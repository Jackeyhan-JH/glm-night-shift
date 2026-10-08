import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 默认配置（见 issue #2）。深层冻结，任何代码都不应改动它。
export const DEFAULT_CONFIG = deepFreeze({
  concurrency: 1,
  timeoutMinutes: 60,
  killGraceSeconds: 10,
  maxAttempts: 2,
  pollSeconds: 30,
  port: 7788,
  host: '127.0.0.1',
  plan: 'v2-max',
  weekStart: null,
  safetyRatio: 0.9,
  allowPeak: false,
  claudeBin: 'claude',
  ghBin: 'gh',
  difficulty: {
    easy: { model: 'glm-5.3-flash', effort: 'low' },
    medium: { model: 'glm-5.3', effort: 'medium' },
    hard: { model: 'glm-5.3', effort: 'high' },
  },
  effortThinkingTokens: { low: 0, medium: 8000, high: 32000 },
  // —— issue #8 新增（git 集成与测试命令），按约定追加在对象末尾 ——
  remoteUrlTemplate: 'https://github.com/{repo}.git',
  gitAuthorName: null,
  gitAuthorEmail: null,
  testTimeoutMinutes: 15,
  // —— issue #9 新增（调度器：限流退避与失败现场保留），按约定追加在对象末尾 ——
  rateLimitBackoffMinutes: 15,
  keepFailedWorktrees: false,
  // —— issue #12 新增（失败自动诊断），按约定追加在对象末尾 ——
  autoDiagnose: true,          // 普通失败且还有重试次数时，先用便宜模型诊断再重跑
  diagnoseModel: 'glm-5.3-flash', // 诊断用的便宜模型
  diagnoseTimeoutMinutes: 5,   // 诊断超时（诊断不该比任务本身还久）
  // —— issue #18 新增（一键启动 serve 与 systemd 用户服务），按约定追加在对象末尾 ——
  systemctlBin: 'systemctl',   // install/uninstall-service 用的 systemctl 可执行文件
});

/**
 * 数据目录：$NIGHT_SHIFT_HOME（非空时，解析为绝对路径），否则 ~/.glm-night-shift。
 */
export function resolveHome(env = process.env) {
  const fromEnv = env.NIGHT_SHIFT_HOME;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.glm-night-shift');
}

/**
 * 配置文件路径：<home>/config.json。
 */
export function configPath(home) {
  return path.join(home, 'config.json');
}

/**
 * 读取配置：默认值 < <home>/config.json < 环境变量。
 * - config.json 不存在：返回默认值（不创建任何目录）。
 * - JSON 不合法 / 顶层不是对象 / 其他读取错误：抛出的错误信息里带文件绝对路径。
 * - 嵌套普通对象按键合并（如 difficulty），数组和标量整体替换，未知字段保留。
 * - 返回全新可变对象，不会改动或泄漏 DEFAULT_CONFIG。
 */
export function loadConfig({ home, env } = {}) {
  const theEnv = env ?? process.env;
  const theHome = home ?? resolveHome(theEnv);
  const file = configPath(theHome);

  let fileConfig = {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      raw = undefined; // 没有配置文件，用默认值
    } else {
      throw new Error(`无法读取配置文件 ${file}：${err.message}`);
    }
  }
  if (raw !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`配置文件不是合法 JSON：${file}（${err.message}）`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error(`配置文件顶层必须是 JSON 对象：${file}`);
    }
    fileConfig = parsed;
  }

  const config = deepMerge(deepClone(DEFAULT_CONFIG), fileConfig);
  applyEnvOverrides(config, theEnv);
  return config;
}

/**
 * 创建数据目录及其子目录（幂等），返回各目录的绝对路径。
 */
export function ensureHome(home) {
  const resolved = path.resolve(home);
  for (const dir of [resolved, 'logs', 'repos', 'worktrees']) {
    fs.mkdirSync(path.join(resolved, dir), { recursive: true });
  }
  return {
    home: resolved,
    logs: path.join(resolved, 'logs'),
    repos: path.join(resolved, 'repos'),
    worktrees: path.join(resolved, 'worktrees'),
  };
}

function applyEnvOverrides(config, env) {
  const claudeBin = readEnvValue(env, 'NIGHT_SHIFT_CLAUDE_BIN');
  if (claudeBin !== undefined) config.claudeBin = claudeBin;
  const ghBin = readEnvValue(env, 'NIGHT_SHIFT_GH_BIN');
  if (ghBin !== undefined) config.ghBin = ghBin;
  const systemctlBin = readEnvValue(env, 'NIGHT_SHIFT_SYSTEMCTL_BIN');
  if (systemctlBin !== undefined) config.systemctlBin = systemctlBin;
  const portRaw = readEnvValue(env, 'NIGHT_SHIFT_PORT');
  if (portRaw !== undefined) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`环境变量 NIGHT_SHIFT_PORT 必须是 1～65535 的整数，当前值：${portRaw}`);
    }
    config.port = port;
  }
}

function readEnvValue(env, name) {
  const value = env[name];
  if (value === undefined || value === '') return undefined; // 空字符串视为未设置
  return value;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) out[key] = deepClone(child);
    return out;
  }
  return value;
}

// base 是深拷贝过的默认值，overlay 是 config.json 的内容；返回新对象。
function deepMerge(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? deepMerge(out[key], value)
      : value;
  }
  return out;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
