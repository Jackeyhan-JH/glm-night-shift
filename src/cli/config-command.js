// config 子命令：显示生效配置（默认值 < <home>/config.json < 环境变量）与数据目录
// 里的各路径。只读，不创建任何文件（config.json 不存在也照常显示默认值）。
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { configPath, loadConfig, resolveHome } from '../config.js';

export const configCommand = {
  summary: '查看生效配置与数据目录',
  usage: '用法：night-shift config [--json]',
  run(args, ctx) {
    const { values } = parseArgs({ args, options: { json: { type: 'boolean' } } });
    const home = resolveHome(ctx.env);
    // JSON 形状（固定，文档化）：{ home, configPath, dbPath, config }。
    // concurrency / port 等配置键在 config 里（嵌套一层），对整个输出 grep 键名仍能命中。
    const info = {
      home,
      configPath: configPath(home),
      dbPath: path.join(home, 'night-shift.db'),
      config: loadConfig({ home, env: ctx.env }),
    };
    if (values.json) {
      ctx.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
      return 0;
    }
    const exists = fs.existsSync(info.configPath) ? '' : '（不存在，用默认值）';
    ctx.stdout.write([
      `数据目录：${info.home}`,
      `配置文件：${info.configPath}${exists}`,
      `数据库：${info.dbPath}`,
      '',
      '生效配置：',
      JSON.stringify(info.config, null, 2),
      '',
    ].join('\n'));
    return 0;
  },
};
