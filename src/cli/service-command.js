// install-service / uninstall-service 子命令（issue #18）：把 `night-shift serve` 装成
// systemd 用户单元（登录后自动在后台跑），一键卸载。不做系统级（root）服务，也不做
// Windows/macOS 的服务管理器。
//
// 单元内容由 renderUnit 生成（导出给测试）：ExecStart 用当前 node 绝对路径跑本仓库的
// bin/night-shift.mjs serve；环境里设了的 NIGHT_SHIFT_CLAUDE_BIN / NIGHT_SHIFT_GH_BIN /
// NIGHT_SHIFT_PORT 一并写成 Environment= 行；**绝不**把 ANTHROPIC_*、GH_TOKEN 等凭据写进
// 单元（claude / gh 自己的登录状态会在用户环境里生效）。路径带空格时按 systemd 规则加引号。
//
// 本文件不 import src/db.js（不碰任务库，也就不加载 node:sqlite）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { loadConfig, resolveHome } from '../config.js';

/** 单元文件名（install 与 uninstall 共用，也是提示命令里的服务名）。 */
const UNIT_NAME = 'glm-night-shift.service';
/** bin/night-shift.mjs 的绝对路径（npm link / 任意 cwd 下都对）。 */
const BIN_PATH = fileURLToPath(new URL('../../bin/night-shift.mjs', import.meta.url));
/** env 里没有 PATH 时的兜底（PATH 会原样写进单元，空值会让服务里找不到 git 等）。 */
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** 需要原样带进单元的环境变量（设了且非空才写；凭据类一律不写）。 */
const PASSTHROUGH_ENV_KEYS = ['NIGHT_SHIFT_CLAUDE_BIN', 'NIGHT_SHIFT_GH_BIN', 'NIGHT_SHIFT_PORT'];

/**
 * 生成 systemd 用户单元内容（导出给测试与 --dry-run）。
 * @param {object} [options]
 * @param {string} [options.nodePath=process.execPath] node 可执行文件绝对路径
 * @param {string} [options.binPath] bin/night-shift.mjs 绝对路径（缺省本仓库的）
 * @param {string} options.home 数据目录绝对路径（NIGHT_SHIFT_HOME 的值）
 * @param {object} [options.env=process.env] 取 PATH 与 PASSTHROUGH_ENV_KEYS 的环境
 * @returns {string} 单元文件全文（以一个换行结尾）
 */
export function renderUnit({
  nodePath = process.execPath, binPath = BIN_PATH, home, env = process.env,
} = {}) {
  if (typeof home !== 'string' || home.trim() === '') {
    throw new TypeError(`renderUnit 需要 home（数据目录绝对路径），收到：${home}`);
  }
  const envPath = typeof env.PATH === 'string' && env.PATH !== '' ? env.PATH : DEFAULT_PATH;
  const lines = [
    '[Unit]',
    'Description=GLM 夜班：非高峰时段自动执行 Claude Code 任务',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${quoteSystemd(nodePath)} ${quoteSystemd(binPath)} serve`,
    `Environment=${quoteSystemd(`NIGHT_SHIFT_HOME=${oneLine(home)}`)}`,
    `Environment=${quoteSystemd(`PATH=${oneLine(envPath)}`)}`,
  ];
  for (const key of PASSTHROUGH_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value !== '') {
      lines.push(`Environment=${quoteSystemd(`${key}=${oneLine(value)}`)}`);
    }
  }
  lines.push(
    'Restart=on-failure',
    'RestartSec=30',
    'KillSignal=SIGTERM',
    'TimeoutStopSec=90',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  );
  return lines.join('\n');
}

/** systemd 单元里的一个 ExecStart 参数或 Environment 值：含特殊字符时按规则加引号。 */
function quoteSystemd(token) {
  const value = String(token);
  // 安全字符集（含 %：systemd 的 %% 转义出现在极少数路径里，这里不展开解释、按字面保留）
  if (/^[\x20-\x7e]+$/.test(value) && !/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/(["\\])/g, '\\$1')}"`;
}

/** 值里的换行会劈坏单元行：换成空格压平。 */
function oneLine(value) {
  return String(value).replace(/[\r\n]+/g, ' ');
}

/** 缺省单元目录：$XDG_CONFIG_HOME（ctx.env 优先）或 ~/.config 下的 systemd/user。 */
function defaultUnitDir(env) {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME.trim() !== ''
    ? env.XDG_CONFIG_HOME
    : null;
  return path.join(xdg ?? path.join(os.homedir(), '.config'), 'systemd', 'user');
}

/**
 * 跑一次 systemctl。退出码非 0 或启动失败：把它的输出原样透传给用户并返回 false。
 * @returns {boolean} 是否成功（退出码 0）
 */
function runSystemctl(ctx, config, argv) {
  let res;
  try {
    res = spawnSync(config.systemctlBin, argv, { encoding: 'utf8' });
  } catch (err) {
    ctx.stderr.write(`错误：无法执行 ${config.systemctlBin}：${err.message}\n`);
    return false;
  }
  if (res.error) {
    ctx.stderr.write(`错误：无法执行 ${config.systemctlBin}：${res.error.message}\n`);
    return false;
  }
  if (res.stdout) ctx.stdout.write(res.stdout);
  if (res.stderr) ctx.stderr.write(res.stderr); // 原样透传（包括换行）
  if (res.status !== 0) {
    ctx.stderr.write(`错误：systemctl ${argv.join(' ')} 失败（退出码 ${res.status}）\n`);
    return false;
  }
  return true;
}

export const installServiceCommand = {
  summary: '安装为 systemd 用户服务（开机自启）',
  usage: '用法：night-shift install-service [--dry-run] [--unit-dir <目录>]\n（--dry-run 只打印单元内容，不写文件、不调 systemctl）',
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: { 'dry-run': { type: 'boolean' }, 'unit-dir': { type: 'string' } },
    });
    const env = ctx.env;
    const home = resolveHome(env);
    const config = loadConfig({ home, env }); // systemctlBin 等；配置非法 → 退出 1
    const unitDir = values['unit-dir'] ?? defaultUnitDir(env);
    const unitPath = path.join(unitDir, UNIT_NAME);
    const unit = renderUnit({ home, env });

    if (values['dry-run']) {
      ctx.stdout.write(unit);
      return 0;
    }

    // 正常安装：写文件 → daemon-reload → enable --now。即使 reload / enable 失败也保留
    // 已写入的单元文件并退出 1——不假装没安装过；用户修好环境后重跑即可。
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unitPath, unit);
    if (!runSystemctl(ctx, config, ['--user', 'daemon-reload'])) return 1;
    if (!runSystemctl(ctx, config, ['--user', 'enable', '--now', UNIT_NAME])) return 1;
    ctx.stdout.write([
      `已安装 systemd 用户服务：${unitPath}`,
      '常用命令：',
      '  systemctl --user status glm-night-shift',
      '  journalctl --user -u glm-night-shift -f',
      '想在未登录（没有活动会话）时也保持运行，请执行：loginctl enable-linger $USER',
      '',
    ].join('\n'));
    return 0;
  },
};

export const uninstallServiceCommand = {
  summary: '卸载 systemd 用户服务',
  usage: '用法：night-shift uninstall-service [--unit-dir <目录>]',
  async run(args, ctx) {
    const { values } = parseArgs({
      args,
      options: { 'unit-dir': { type: 'string' } },
    });
    const env = ctx.env;
    const home = resolveHome(env);
    const config = loadConfig({ home, env });
    const unitDir = values['unit-dir'] ?? defaultUnitDir(env);
    const unitPath = path.join(unitDir, UNIT_NAME);

    if (!fs.existsSync(unitPath)) {
      ctx.stdout.write(`没有安装：找不到单元文件 ${unitPath}\n`);
      return 0; // 不调 systemctl
    }
    if (!runSystemctl(ctx, config, ['--user', 'disable', '--now', UNIT_NAME])) return 1;
    fs.rmSync(unitPath);
    if (!runSystemctl(ctx, config, ['--user', 'daemon-reload'])) return 1;
    ctx.stdout.write(`已卸载 systemd 用户服务（已停止并删除单元文件）：${unitPath}\n`);
    return 0;
  },
};
