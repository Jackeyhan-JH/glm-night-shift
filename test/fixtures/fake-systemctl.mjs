#!/usr/bin/env node
// 假 systemctl：模拟 install-service / uninstall-service 会调用的 systemctl，绝不碰真实
// systemd。行为由环境变量控制：
//   FAKE_SYSTEMCTL_LOG  若设置，把 argv 作为一行 JSON 追加到该文件（测试靠它断言调用序列）
//   FAKE_SYSTEMCTL_FAIL=1  stderr 报错并退出 1（模拟 systemctl 失败）
// 重要：不带任何参数被调用时（例如被 `node --test` 误当测试文件执行）零副作用：
// FAKE_SYSTEMCTL_LOG 未设置时不写任何文件、不输出任何内容、退出 0。
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (process.env.FAKE_SYSTEMCTL_LOG) {
  appendFileSync(process.env.FAKE_SYSTEMCTL_LOG, `${JSON.stringify(argv)}\n`);
}

if (process.env.FAKE_SYSTEMCTL_FAIL === '1') {
  process.stderr.write('fake systemctl failure (FAKE_SYSTEMCTL_FAIL=1)\n');
  process.exitCode = 1;
}
