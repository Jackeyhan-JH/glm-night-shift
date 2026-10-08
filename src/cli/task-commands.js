// add / list / show / cancel / retry 五个子命令（issue #5）；add 的 --template 渲染
// （issue #13）也在本文件；import 按 GitHub issue 批量入队（issue #39）。
// 命令对象形状见 bin/night-shift.mjs 的 COMMANDS 表：{ summary, usage, run(args, ctx) }。
//
// ⚠️ 本文件（及其静态依赖）绝不能 import src/db.js：db.js 是唯一加载 node:sqlite
// 的模块，静态引入会让入口来不及先装 SQLite 警告过滤（时机说明见 src/warnings.js，
// 已在 Node 22.13 上实测）。openDb 一律走下面 withDb() 里的动态 import。
// tasks.js / config.js / render.js / templates.js 不碰 node:sqlite，静态引入没问题。
// import 的入队循环抽在 src/import-issues.js（静态 import tasks.js，#50 起与
// POST /api/import 共用），本文件在 run() 里动态 import 它。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig, resolveHome } from '../config.js';
import {
  DIFFICULTIES,
  TASK_STATUSES,
  NotFoundError,
  cancelTask,
  createTask,
  getTask,
  listDependencies,
  listRuns,
  listTasks,
  retryTask,
} from '../tasks.js';
import { loadTemplate, renderTemplate } from '../templates.js';
import { renderTaskDetail, renderTasksTable } from './render.js';
import { parseIdListOption } from './deps-command.js';

/** 多行用法里续行的缩进：对齐到「用法：night-shift 」之后的命令名。 */
const USAGE_CONT = ' '.repeat(15);

/**
 * util.parseArgs 把紧跟在选项后面的负数（`--priority -2` 里的 -2）当成未知选项；
 * 解析前先把「已知取整数的选项 + 紧随其后的纯数字」合并成 `--opt=value`
 * （`--priority=2` / `--priority 2` 两种写法照旧支持）。只动这几个选项，
 * 其他选项值以 - 开头（如标题）不受影响，仍按 parseArgs 的规则报用法错误。
 */
const NUMBER_VALUE_OPTIONS = new Set(['priority', 'max-attempts', 'limit']);

function normalizeNumericOptions(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { // 其后全是位置参数，不再改写
      out.push(...args.slice(i));
      break;
    }
    const name = arg.startsWith('--') && !arg.includes('=') ? arg.slice(2) : null;
    if (name !== null && NUMBER_VALUE_OPTIONS.has(name)
        && i + 1 < args.length && /^[+-]?\d+$/.test(args[i + 1])) {
      out.push(`${arg}=${args[i + 1]}`);
      i += 1;
    } else {
      out.push(arg);
    }
  }
  return out;
}

/**
 * 打开 <home>/night-shift.db（不存在则自动创建）执行 fn，用完无论成败都关闭连接。
 * 打不开（NIGHT_SHIFT_HOME 指到普通文件、目录不可写……）时抛中文原因带路径的错。
 */
async function withDb(ctx, fn) {
  const { openDb } = await import('../db.js'); // 动态 import：给警告过滤留出安装时间
  const dbPath = path.join(resolveHome(ctx.env), 'night-shift.db');
  let db;
  try {
    db = openDb(dbPath);
  } catch (err) {
    throw new Error(`无法打开数据库 ${dbPath}：${err.message}`);
  }
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** 入口视角的生效配置：默认值 < <home>/config.json < 环境变量。 */
function effectiveConfig(ctx) {
  return loadConfig({ home: resolveHome(ctx.env), env: ctx.env });
}

/**
 * #85「在等这个仓库」：算 list 要标的 waitingIds——listed 里 status 为 queued、且
 * running 清单中存在另一条（id 不同）任务 repo 与之全等（===，不 trim、不
 * toLowerCase）的任务 id。同仓库另一条也只是 queued 不算；自己不是 queued 不进集合。
 * running 清单由调用方在同一条 withDb 连接上查（limit 固定 1000，不用本次 --limit），
 * 开关（oneTaskPerRepo === true）也由调用方判过才到这里。
 */
function waitingSameRepoIds(listed, running) {
  const ids = new Set();
  for (const task of listed) {
    if (task.status !== 'queued') continue;
    if (running.some((busy) => busy.id !== task.id && busy.repo === task.repo)) ids.add(task.id);
  }
  return ids;
}

/** --json 时输出缩进 JSON，否则输出人类可读的一行。 */
function writeOut(ctx, json, value, humanLine) {
  ctx.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${humanLine}\n`);
}

/**
 * 用法级整数校验：只接受可选正负号 + 纯数字（''、' 3'、'1.5'、'1e3' 都算非法），
 * 可要求下限（limit ≥ 1、max-attempts ≥ 1）。不合法抛该命令的 UsageError（退出码 2）。
 */
function parseIntStrict(ctx, raw, label, usage, { min } = {}) {
  const constraint = min === undefined ? '整数' : `不小于 ${min} 的整数`;
  const fail = () => new ctx.UsageError(`${label} 必须是${constraint}（当前值：${raw}）`, { usage });
  if (typeof raw !== 'string' || !/^[+-]?\d+$/.test(raw)) throw fail();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (min !== undefined && value < min)) throw fail();
  return value;
}

/** show/cancel/retry 的 <id>：恰好一个位置参数且为正整数，否则用法错误。 */
function parseIdPositional(ctx, positionals, usage) {
  if (positionals.length === 0) throw new ctx.UsageError('缺少必填参数：<id>', { usage });
  if (positionals.length > 1) {
    throw new ctx.UsageError(`参数过多：${positionals.join(' ')}（只需要 <id>）`, { usage });
  }
  const raw = positionals[0];
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new ctx.UsageError(`<id> 必须是正整数（当前值：${raw}）`, { usage });
  }
  return Number(raw);
}

/**
 * add 的 --var <名字=值>（可重复，multiple 收成数组）：拆成 { 名字: 值 }。
 * 在第一个 = 处切分（值可再含 =）；没有 = 或名字为空是用法错误（退出码 2）。
 * 名字是否真的存在于模板，由 renderTemplate 校验（运行时错误，退出码 1）。
 */
function parseTemplateVars(ctx, items) {
  const vars = Object.create(null); // 变量名叫 __proto__ 也不走原型链
  for (const item of items ?? []) {
    const eq = item.indexOf('=');
    const name = eq === -1 ? '' : item.slice(0, eq).trim();
    if (name === '') {
      throw new ctx.UsageError(`--var 必须是「名字=值」形式（当前值：${item}）`, {
        usage: addCommand.usage,
      });
    }
    vars[name] = item.slice(eq + 1);
  }
  return vars;
}

export const addCommand = {
  summary: '添加任务到队列',
  usage: [
    '用法：night-shift add --repo <owner/name> (--prompt <文字> | --prompt-file <路径>',
    `${USAGE_CONT}| --template <名字>)`,
    `${USAGE_CONT}[--var <名字=值>] [--title <标题>] [--difficulty easy|medium|hard]`,
    `${USAGE_CONT}[--priority <整数>] [--test "<测试命令>"] [--allow-peak]`,
    `${USAGE_CONT}[--max-attempts <次数>] [--depends-on <id,id,…>] [--json]`,
  ].join('\n'),
  async run(args, ctx) {
    const { values } = parseArgs({
      args: normalizeNumericOptions(args),
      options: {
        repo: { type: 'string' },
        prompt: { type: 'string' },
        'prompt-file': { type: 'string' },
        template: { type: 'string' },
        var: { type: 'string', multiple: true },
        title: { type: 'string' },
        difficulty: { type: 'string' },
        priority: { type: 'string' },
        test: { type: 'string' },
        'allow-peak': { type: 'boolean' },
        'max-attempts': { type: 'string' },
        'depends-on': { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    if (values.repo === undefined) {
      throw new ctx.UsageError('缺少必填参数：--repo <owner/name>', { usage: addCommand.usage });
    }
    if (values.prompt !== undefined && values['prompt-file'] !== undefined) {
      throw new ctx.UsageError('--prompt 与 --prompt-file 只能二选一', { usage: addCommand.usage });
    }
    if (values.template !== undefined
        && (values.prompt !== undefined || values['prompt-file'] !== undefined)) {
      throw new ctx.UsageError('--template 不能与 --prompt / --prompt-file 同时使用', {
        usage: addCommand.usage,
      });
    }
    if (values.template === undefined && values.prompt === undefined
        && values['prompt-file'] === undefined) {
      throw new ctx.UsageError(
        '缺少必填参数：--prompt <文字>、--prompt-file <路径> 或 --template <名字>',
        { usage: addCommand.usage },
      );
    }
    if (values.var !== undefined && values.template === undefined) {
      throw new ctx.UsageError('--var 只能与 --template 一起使用', { usage: addCommand.usage });
    }
    const templateVars = parseTemplateVars(ctx, values.var);
    let difficulty;
    if (values.difficulty !== undefined) {
      // 枚举在 CLI 层判（用法错误，退出码 2）；repo 格式等留给 store 判（运行时错误，退出码 1）。
      if (!DIFFICULTIES.includes(values.difficulty)) {
        throw new ctx.UsageError(
          `--difficulty 必须是 ${DIFFICULTIES.join(' | ')} 之一（当前值：${values.difficulty}）`,
          { usage: addCommand.usage },
        );
      }
      difficulty = values.difficulty;
    }
    const priority = values.priority === undefined
      ? undefined
      : parseIntStrict(ctx, values.priority, '--priority', addCommand.usage);
    const maxAttempts = values['max-attempts'] === undefined
      ? undefined
      : parseIntStrict(ctx, values['max-attempts'], '--max-attempts', addCommand.usage, { min: 1 });
    // 格式错误（abc、1,,x、0、负数）在这里就是用法错误（退出码 2）；
    // id 不存在 / 已失败等留给存储层（退出码 1）。空串 = 无依赖。
    const dependsOn = values['depends-on'] === undefined
      ? undefined
      : parseIdListOption(ctx, values['depends-on'], '--depends-on', addCommand.usage);

    // --prompt-file：文件内容原样作为提示词，只去掉末尾一个换行（\n 或 \r\n）；
    // 读取失败是运行时错误（文件不存在等），报错带路径。
    let prompt = values.prompt;
    if (values['prompt-file'] !== undefined) {
      const file = path.resolve(ctx.cwd, values['prompt-file']);
      let content;
      try {
        content = fs.readFileSync(file, 'utf8');
      } catch (err) {
        throw new Error(`无法读取 prompt 文件 ${file}：${err.message}`);
      }
      prompt = content.endsWith('\n') ? content.replace(/\r?\n$/, '') : content;
    }

    const config = effectiveConfig(ctx);

    // --template：渲染出 prompt 与各默认值（fetchIssue 时会 spawn gh，故 await）。
    // 显式给出的 --title / --difficulty / --test 优先于模板默认值。渲染失败（缺变量、
    // 拼错变量名、gh 报错……）在这里就抛出，走统一的「错误：…」退出码 1，不会建任务。
    let title = values.title;
    let testCommand = values.test;
    if (values.template !== undefined) {
      const template = loadTemplate(values.template, { home: resolveHome(ctx.env) });
      const rendered = await renderTemplate(template, templateVars, {
        repo: values.repo,
        config,
        env: ctx.env,
      });
      prompt = rendered.prompt;
      if (title === undefined && rendered.title !== null) title = rendered.title;
      if (difficulty === undefined && rendered.difficulty !== null) difficulty = rendered.difficulty;
      if (testCommand === undefined && rendered.testCommand !== null) testCommand = rendered.testCommand;
    }

    const task = await withDb(ctx, (db) => createTask(db, {
      repo: values.repo,
      prompt,
      title, // 未给（模板也没有 title）时 store 取 prompt 前 60 个码点
      difficulty,
      priority,
      testCommand,
      allowPeak: values['allow-peak'] ?? false,
      maxAttempts: maxAttempts ?? config.maxAttempts, // 缺省取配置 maxAttempts
      dependsOn,
    }));
    writeOut(ctx, values.json, task, `已加入队列：#${task.id} ${task.title}`);
    return 0;
  },
};

export const importCommand = {
  summary: '按 GitHub issue 批量入队',
  usage: [
    '用法：night-shift import --repo <owner/name> [--label <名字>]',
    `${USAGE_CONT}[--state open|closed|all] [--limit <条数>]`,
    `${USAGE_CONT}[--difficulty easy|medium|hard] [--dry-run] [--json]`,
  ].join('\n'),
  async run(args, ctx) {
    // 入队循环与 POST /api/import 共用 src/import-issues.js（#50 抽出，含 repo 格式与
    // state 枚举的常量）；该模块静态 import tasks.js，这里按约定在 run() 里动态 import。
    const {
      IMPORT_REPO_PATTERN,
      IMPORT_STATES,
      IMPORT_DEFAULT_LIMIT,
      IMPORT_DEFAULT_DIFFICULTY,
      fetchIssues,
      enqueueIssues,
    } = await import('../import-issues.js');
    const { values } = parseArgs({
      args: normalizeNumericOptions(args),
      options: {
        repo: { type: 'string' },
        label: { type: 'string' },
        state: { type: 'string' },
        limit: { type: 'string' },
        difficulty: { type: 'string' },
        'dry-run': { type: 'boolean' },
        json: { type: 'boolean' },
      },
    });
    if (values.repo === undefined) {
      throw new ctx.UsageError('缺少必填参数：--repo <owner/name>', { usage: importCommand.usage });
    }
    const repo = values.repo.trim();
    if (!IMPORT_REPO_PATTERN.test(repo)) {
      throw new ctx.UsageError(
        `--repo 必须形如 owner/name（当前值：${values.repo}）`,
        { usage: importCommand.usage },
      );
    }
    const state = values.state ?? 'open';
    if (!IMPORT_STATES.includes(state)) {
      throw new ctx.UsageError(
        `--state 必须是 ${IMPORT_STATES.join(' | ')} 之一（当前值：${values.state}）`,
        { usage: importCommand.usage },
      );
    }
    const limit = values.limit === undefined
      ? IMPORT_DEFAULT_LIMIT
      : parseIntStrict(ctx, values.limit, '--limit', importCommand.usage, { min: 1 });
    const difficulty = values.difficulty ?? IMPORT_DEFAULT_DIFFICULTY;
    if (!DIFFICULTIES.includes(difficulty)) {
      throw new ctx.UsageError(
        `--difficulty 必须是 ${DIFFICULTIES.join(' | ')} 之一（当前值：${values.difficulty}）`,
        { usage: importCommand.usage },
      );
    }
    const dryRun = values['dry-run'] === true;

    // gh 先跑、库后开（withDb）：gh 失败时抛出命令行同一句错误，连库都不打开。
    const config = effectiveConfig(ctx);
    const issues = await fetchIssues({
      repo,
      label: values.label,
      state,
      limit,
      ghBin: config.ghBin,
      env: ctx.env,
    });
    const { added, skipped, lines } = await withDb(ctx, (db) => enqueueIssues({
      db,
      repo,
      issues,
      difficulty,
      dryRun,
      maxAttempts: config.maxAttempts,
    }));
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify({ added, skipped }, null, 2)}\n`);
      return 0;
    }
    lines.push(`新增 ${added.length} 个，跳过 ${skipped.length} 个`);
    ctx.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  },
};

export const listCommand = {
  summary: '列出任务',
  usage: '用法：night-shift list [--status <queued|running|succeeded|failed|canceled>] [--limit <条数>] [--json]',
  async run(args, ctx) {
    const { values } = parseArgs({
      args: normalizeNumericOptions(args),
      options: {
        status: { type: 'string' },
        limit: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    let status;
    if (values.status !== undefined) {
      if (!TASK_STATUSES.includes(values.status)) {
        throw new ctx.UsageError(
          `--status 必须是 ${TASK_STATUSES.join(' | ')} 之一（当前值：${values.status}）`,
          { usage: listCommand.usage },
        );
      }
      status = values.status;
    }
    const limit = values.limit === undefined
      ? undefined // 缺省用 store 的默认（当前 100）
      : parseIntStrict(ctx, values.limit, '--limit', listCommand.usage, { min: 1 });
    const { rows, waitingIds } = await withDb(ctx, (db) => {
      const listed = listTasks(db, { status, limit });
      // #85：只给人类可读输出标「等这个仓库」——读这一次生效配置（=== true 才标），
      // 同一连接另查 running（limit 固定 1000，不用本次 --limit）。--json 短路在前：
      // 不读配置也不另查，坏掉的 config.json 不会让 list --json 退出 1。
      const waitingIds = !values.json && effectiveConfig(ctx).oneTaskPerRepo === true
        ? waitingSameRepoIds(listed, listTasks(db, { status: 'running', limit: 1000 }))
        : undefined;
      return { rows: listed, waitingIds };
    });
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); // 空列表输出 []，不是「队列是空的」
      return 0;
    }
    ctx.stdout.write(rows.length === 0 ? '队列是空的\n' : renderTasksTable(rows, { waitingIds }));
    return 0;
  },
};

export const showCommand = {
  summary: '查看任务详情与运行记录',
  usage: '用法：night-shift show <id> [--json]',
  async run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
    });
    const id = parseIdPositional(ctx, positionals, showCommand.usage);
    const { task, runs, deps, waitingSameRepo } = await withDb(ctx, (db) => {
      const found = getTask(db, id);
      if (found === null) throw new NotFoundError(id); // 运行时错误：中文原因，退出码 1
      // #85：人类可读输出在任务 queued、开关开着（读一次配置，=== true）且同仓库另有
      // running（id 不同、repo 全等）时标「等这个仓库」。--json 短路在最前，不读配置、
      // 不查 running，输出的对象形状与从前相同。
      const waitingSameRepo = !values.json
        && effectiveConfig(ctx).oneTaskPerRepo === true
        && found.status === 'queued'
        && listTasks(db, { status: 'running', limit: 1000 })
          .some((busy) => busy.id !== found.id && busy.repo === found.repo);
      return {
        task: found,
        runs: listRuns(db, { taskId: id, limit: 1000 }),
        deps: listDependencies(db, id), // 依赖行（id + 状态），给人类可读输出用
        waitingSameRepo,
      };
    });
    // JSON 形状：任务字段全在顶层（含 status / dependsOn / blockedBy），runs 挂在 runs 键下
    // （waitingSameRepo 不掺进去）。
    writeOut(ctx, values.json, { ...task, runs },
      renderTaskDetail(task, runs, deps, { waitingSameRepo }));
    return 0;
  },
};

/** cancel / retry 共用骨架：解析 <id>、执行动作、输出「#<id> 中文说明（新状态）」。 */
function statusChangeCommand({ name, summary, action, label }) {
  const usage = `用法：night-shift ${name} <id>`;
  return {
    summary,
    usage,
    async run(args, ctx) {
      const { positionals } = parseArgs({ args, options: {}, allowPositionals: true });
      const id = parseIdPositional(ctx, positionals, usage);
      const task = await withDb(ctx, (db) => action(db, id));
      // retry 连带重新排队时（#55）在行尾点名下游（id 升序、中文顿号）；cancelTask 的
      // 返回没有 requeued，chained 为空串，输出与从前逐字一样
      const chained = Array.isArray(task.requeued) && task.requeued.length > 0
        ? `，连带 ${task.requeued.map((downstream) => `#${downstream}`).join('、')}`
        : '';
      ctx.stdout.write(`#${task.id} ${label}（${task.status}）${chained}\n`);
      return 0;
    },
  };
}

export const cancelCommand = statusChangeCommand({
  name: 'cancel',
  summary: '取消排队/执行中的任务',
  action: cancelTask, // (db, id) => TaskRow
  label: '已取消',
});

export const retryCommand = statusChangeCommand({
  name: 'retry',
  summary: '把失败/已取消的任务重新排队',
  action: retryTask, // (db, id) => TaskRow
  label: '已重新排队',
});
