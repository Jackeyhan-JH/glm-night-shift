// install-service / uninstall-service 子命令的端到端测试（issue #18）：spawn 真实 CLI
// 进程（fakeEnv 隔离环境），systemctl 用假替身（NIGHT_SHIFT_SYSTEMCTL_BIN 指向包着
// test/fixtures/fake-systemctl.mjs 的 shim），单元内容用导出的 renderUnit 直接断言。
// 全程绝不调用真实 systemd；沙箱 PATH 上的 systemctl 是退出 99 的陷阱（见 helpers.js），
// 忘了覆盖 systemctlBin 的用例会失败关闭而不是碰真实系统。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderUnit } from '../src/cli/service-command.js';
import { fakeEnv, makeTempHome, fixturePath } from './helpers.js';

const binPath = fileURLToPath(new URL('../bin/night-shift.mjs', import.meta.url));

/** 跑一个 CLI 命令，等它结束并带上全部输出。 */
function runCli(args, { home, env: envOverrides = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: fakeEnv({ NIGHT_SHIFT_HOME: home, TZ: 'UTC', ...envOverrides }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

/**
 * 建一个指向假 systemctl 的可执行 shim。NIGHT_SHIFT_SYSTEMCTL_BIN 的值必须是单个
 * 可执行路径（与 claudeBin / ghBin 同一模式），所以用 /bin/sh 包一层 exec node。
 */
function makeFakeSystemctl(t) {
  const dir = makeTempHome(t);
  const shim = path.join(dir, 'systemctl');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${fixturePath('fake-systemctl.mjs')}" "$@"\n`);
  fs.chmodSync(shim, 0o755);
  return shim;
}

/** 读 FAKE_SYSTEMCTL_LOG（每行一次调用的 argv 数组）；不存在返回空数组。 */
function readSystemctlLog(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** 一套服务测试环境：假 systemctl shim + 调用日志 + 显式单元目录。 */
function setup(t) {
  const home = makeTempHome(t);
  const unitDir = path.join(makeTempHome(t), 'units');
  const log = path.join(makeTempHome(t), 'systemctl-log.jsonl');
  const shim = makeFakeSystemctl(t);
  const env = { NIGHT_SHIFT_SYSTEMCTL_BIN: shim, FAKE_SYSTEMCTL_LOG: log };
  const unitPath = path.join(unitDir, 'glm-night-shift.service');
  return { home, unitDir, unitPath, log, shim, env };
}

// ---------------------------------------------------------------- install-service

test('验收: install-service --dry-run：输出 ExecStart/NIGHT_SHIFT_HOME/WantedBy，不写 GH_TOKEN，不写任何文件', async (t) => {
  const home = makeTempHome(t);
  const xdg = makeTempHome(t); // 缺省单元目录的落点：dry-run 不该碰它
  const res = await runCli(['install-service', '--dry-run'], {
    home,
    env: { XDG_CONFIG_HOME: xdg, GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret' },
  });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes(`ExecStart=${process.execPath} ${binPath} serve`),
    `ExecStart 应是 node 绝对路径 + bin 绝对路径 + serve：\n${res.stdout}`);
  assert.ok(res.stdout.includes(`Environment=NIGHT_SHIFT_HOME=${home}`), res.stdout);
  assert.ok(res.stdout.includes('Environment=PATH='), res.stdout);
  assert.ok(res.stdout.includes('WantedBy=default.target'), res.stdout);
  assert.ok(res.stdout.includes('Type=simple'), res.stdout);
  assert.ok(res.stdout.includes('Restart=on-failure'), res.stdout);
  assert.ok(res.stdout.includes('KillSignal=SIGTERM'), res.stdout);
  assert.ok(res.stdout.includes('TimeoutStopSec=90'), res.stdout);
  assert.equal(res.stdout.includes('secret'), false, `凭据不得写进单元文件：\n${res.stdout}`);
  assert.equal(fs.readdirSync(xdg).length, 0, 'dry-run 不应写任何文件');
  // fakeEnv 默认设了两个假替身 bin → 对应的 Environment= 行也在
  assert.ok(res.stdout.includes('Environment=NIGHT_SHIFT_CLAUDE_BIN='), res.stdout);
  assert.ok(res.stdout.includes('Environment=NIGHT_SHIFT_GH_BIN='), res.stdout);
});

test('验收: install-service --unit-dir <tmp>：文件内容与 dry-run 一致；FAKE_SYSTEMCTL_LOG 依次记录 daemon-reload、enable --now', async (t) => {
  const ctx = setup(t);
  const dry = await runCli(['install-service', '--dry-run'], { home: ctx.home, env: ctx.env });
  assert.equal(dry.code, 0, dry.stderr);

  const res = await runCli(['install-service', '--unit-dir', ctx.unitDir], { home: ctx.home, env: ctx.env });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(fs.existsSync(ctx.unitPath), '应写出单元文件');
  assert.equal(fs.readFileSync(ctx.unitPath, 'utf8'), dry.stdout, '写入的单元内容应与 dry-run 输出一致');
  assert.deepEqual(readSystemctlLog(ctx.log), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'glm-night-shift.service'],
  ]);
  assert.ok(res.stdout.includes(ctx.unitPath), res.stdout);
  assert.ok(res.stdout.includes('systemctl --user status glm-night-shift'), res.stdout);
  assert.ok(res.stdout.includes('journalctl --user -u glm-night-shift -f'), res.stdout);
  assert.ok(res.stdout.includes('loginctl enable-linger'), res.stdout);
});

test('install-service 缺省 --unit-dir：写到 $XDG_CONFIG_HOME/systemd/user 下', async (t) => {
  const ctx = setup(t);
  const xdg = makeTempHome(t);
  const res = await runCli(['install-service'], { home: ctx.home, env: { ...ctx.env, XDG_CONFIG_HOME: xdg } });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(xdg, 'systemd', 'user', 'glm-night-shift.service')), '单元应在 XDG 目录下');
});

// ---------------------------------------------------------------- uninstall-service

test('验收: uninstall-service --unit-dir <tmp>：文件被删，记录 disable --now 与 daemon-reload；再执行输出 没有安装 退出 0', async (t) => {
  const ctx = setup(t);
  const install = await runCli(['install-service', '--unit-dir', ctx.unitDir], { home: ctx.home, env: ctx.env });
  assert.equal(install.code, 0, install.stderr);

  const res = await runCli(['uninstall-service', '--unit-dir', ctx.unitDir], { home: ctx.home, env: ctx.env });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(fs.existsSync(ctx.unitPath), false, '单元文件应被删除');
  assert.deepEqual(readSystemctlLog(ctx.log).slice(2), [
    ['--user', 'disable', '--now', 'glm-night-shift.service'],
    ['--user', 'daemon-reload'],
  ]);

  const callsBefore = readSystemctlLog(ctx.log).length;
  const again = await runCli(['uninstall-service', '--unit-dir', ctx.unitDir], { home: ctx.home, env: ctx.env });
  assert.equal(again.code, 0, again.stderr);
  assert.ok(again.stdout.includes('没有安装'), again.stdout);
  assert.equal(readSystemctlLog(ctx.log).length, callsBefore, '未安装时不应再调 systemctl');
});

test('uninstall-service 对从未安装过的目录：直接输出 没有安装 退出 0', async (t) => {
  const ctx = setup(t);
  const res = await runCli(['uninstall-service', '--unit-dir', ctx.unitDir], { home: ctx.home, env: ctx.env });
  assert.equal(res.code, 0, res.stderr);
  assert.ok(res.stdout.includes('没有安装'), res.stdout);
  assert.equal(readSystemctlLog(ctx.log).length, 0);
});

// ---------------------------------------------------------------- 失败路径与陷阱

test('验收: FAKE_SYSTEMCTL_FAIL=1：install-service 退出 1，stderr 原样透传假 systemctl 的报错；单元文件保留', async (t) => {
  const ctx = setup(t);
  const res = await runCli(['install-service', '--unit-dir', ctx.unitDir], {
    home: ctx.home,
    env: { ...ctx.env, FAKE_SYSTEMCTL_FAIL: '1' },
  });
  assert.equal(res.code, 1);
  assert.ok(res.stderr.includes('fake systemctl failure (FAKE_SYSTEMCTL_FAIL=1)'), res.stderr);
  assert.ok(fs.existsSync(ctx.unitPath), 'daemon-reload 失败也应保留已写的单元文件（不假装没安装）');
});

test('忘了覆盖 systemctlBin 时失败关闭：默认 systemctl 命中沙箱陷阱（退出 99），命令退出 1', async (t) => {
  const home = makeTempHome(t);
  const unitDir = path.join(makeTempHome(t), 'units');
  const trap = spawnSync('systemctl', ['--user', 'status'], { env: fakeEnv(), encoding: 'utf8' });
  assert.equal(trap.status, 99, '沙箱 PATH 上的 systemctl 应是退出 99 的陷阱');

  const res = await runCli(['install-service', '--unit-dir', unitDir], { home });
  assert.equal(res.code, 1, '默认 systemctlBin 走 PATH → 陷阱 → 命令失败');
  assert.ok(res.stderr.includes('99'), `stderr 应提到陷阱退出码：${res.stderr}`);
});

// ---------------------------------------------------------------- renderUnit

test('验收: renderUnit 对含空格的路径输出合法的加引号写法', () => {
  const unit = renderUnit({
    nodePath: '/opt/node 24/bin/node',
    binPath: '/opt/tools/night shift/bin/night-shift.mjs',
    home: '/tmp/my home/.glm-night-shift',
    env: { PATH: '/usr/bin:/my tools/bin', NIGHT_SHIFT_PORT: '7788' },
  });
  assert.ok(unit.includes('ExecStart="/opt/node 24/bin/node" "/opt/tools/night shift/bin/night-shift.mjs" serve'),
    `ExecStart 的两个参数都应加引号：\n${unit}`);
  assert.ok(unit.includes('Environment="NIGHT_SHIFT_HOME=/tmp/my home/.glm-night-shift"'), unit);
  assert.ok(unit.includes('Environment="PATH=/usr/bin:/my tools/bin"'), unit);
  assert.ok(unit.includes('Environment=NIGHT_SHIFT_PORT=7788'), unit); // 无特殊字符不加引号

  const plain = renderUnit({ home: '/tmp/plain-home', env: { PATH: '/usr/bin:/bin' } });
  assert.ok(plain.includes(`ExecStart=${process.execPath} `), plain); // 缺省 nodePath = process.execPath
  assert.ok(plain.includes('Environment=NIGHT_SHIFT_HOME=/tmp/plain-home'), plain);
  assert.ok(plain.includes('Environment=PATH=/usr/bin:/bin'), plain);

  const quoted = renderUnit({ nodePath: '/bin/node', binPath: '/bin/night"shift.mjs', home: '/tmp/h', env: {} });
  assert.ok(quoted.includes('"/bin/night\\"shift.mjs"'), `内嵌双引号应转义：\n${quoted}`);
});
