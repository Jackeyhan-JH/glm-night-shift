// templates / templates show 两个子命令（issue #13）。只读：列出与查看模板，不碰数据库。
// add --template 的渲染逻辑在 task-commands.js（那里要开库写任务）。
//
// ⚠️ 本文件不 import src/db.js（原因见 bin/night-shift.mjs 顶部的时机说明）；
// templates.js 及其依赖也不加载 node:sqlite，静态引入没问题。
import { parseArgs } from 'node:util';
import { resolveHome } from '../config.js';
import { listTemplates, loadTemplate } from '../templates.js';
import { displayWidth, padEndDisplay, truncateDisplay } from '../format.js';

/** 多行用法里续行的缩进：对齐到「用法：night-shift 」之后的命令名。 */
const USAGE_CONT = ' '.repeat(15);

/** 说明列的最大显示列数，超出截断加 …（完整内容看 templates show）。 */
const DESCRIPTION_MAX_COLUMNS = 44;

/** 变量声明的紧凑展示：必填 `issue`；可选无默认 `extra?`；有默认值 `framework=jest`。 */
function varLabel({ name, required, default: def }) {
  if (required) return name;
  return def ? `${name}=${def}` : `${name}?`;
}

export const templatesCommand = {
  summary: '列出/查看任务模板',
  usage: [
    '用法：night-shift templates [--json]',
    `${USAGE_CONT}night-shift templates show <名字>`,
  ].join('\n'),
  run(args, ctx) {
    const { values, positionals } = parseArgs({
      args,
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
    });
    if (positionals.length === 0) return listAll(ctx, values.json);
    if (positionals[0] === 'show') {
      if (positionals.length === 1) {
        throw new ctx.UsageError('缺少必填参数：<名字>', { usage: templatesCommand.usage });
      }
      if (positionals.length > 2) {
        throw new ctx.UsageError(`参数过多：${positionals.slice(1).join(' ')}（只需要 <名字>）`, {
          usage: templatesCommand.usage,
        });
      }
      return showOne(ctx, positionals[1]);
    }
    throw new ctx.UsageError(`未知参数：${positionals.join(' ')}（只支持 show <名字>）`, {
      usage: templatesCommand.usage,
    });
  },
};

/** templates：--json 输出定形数组；人类可读输出「名字 来源 难度 变量 说明」表。 */
function listAll(ctx, json) {
  const templates = listTemplates({ home: resolveHome(ctx.env) });
  if (json) {
    ctx.stdout.write(`${JSON.stringify(templates, null, 2)}\n`);
    return 0;
  }
  const header = ['名字', '来源', '难度', '变量', '说明'];
  const rows = templates.map((t) => [
    t.name,
    t.source === 'user' ? '自定义' : '内置',
    t.difficulty ?? '-',
    t.vars.length === 0 ? '-' : t.vars.map(varLabel).join(', '),
    truncateDisplay(t.description, DESCRIPTION_MAX_COLUMNS) || '（无说明）',
  ]);
  const widths = header.map(
    (_, i) => Math.max(displayWidth(header[i]), ...rows.map((row) => displayWidth(row[i]))),
  );
  const line = (cells) => cells.map((cell, i) => padEndDisplay(cell, widths[i])).join('  ').trimEnd();
  ctx.stdout.write(`${[line(header), ...rows.map(line)].join('\n')}\n`);
  return 0;
}

/** templates show <名字>：先 loadTemplate 校验 front-matter（坏文件在这里报错），
 *  再打印模板原文与文件路径。 */
function showOne(ctx, name) {
  const tpl = loadTemplate(name, { home: resolveHome(ctx.env) });
  const content = tpl.raw.endsWith('\n') ? tpl.raw : `${tpl.raw}\n`;
  ctx.stdout.write(
    `模板：${tpl.name}（${tpl.source === 'user' ? '自定义' : '内置'}）\n路径：${tpl.path}\n\n${content}`,
  );
  return 0;
}
