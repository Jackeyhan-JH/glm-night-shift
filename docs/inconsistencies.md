# 文档与代码的已知不一致

写 README 与 docs/configuration.md 时（issue #20）发现的、Issue 描述（或截图）与代码实际
行为不一致的地方。按约定**不改代码**，在这里列出，由产品决定改哪边。

1. **（已解决）`npm run e2e` 现在有了。**
   原先这里写「package.json 没有 `npm run e2e`」。#19 已 squash 合入 main
   （`6d0cad2`，父提交 `0308625`）。`package.json` 的 script 是
   `node --test --test-concurrency=1 "e2e/*.e2e.mjs"`，不进 `npm test`。
   README 开发节仍留着「e2e 套件在整理中，尚未做成 script」那句，本条目只更正这里的过时说法，不改那份 README 正文。

2. **docs/images/task.png 截图来自看板的旧版本。**
   截图（取自 #16 的看板 PR）里任务分支显示为 `task/2-login-overflow`，而当前代码
   （`src/git.js` 的 `branchName`）生成的分支一律是 `night-shift/<id>-<slug>`。截图仅作示意，
   界面细节与当前版本有出入，待看板稳定后重新截图替换（README 图注已说明这一点）。

3. **「高峰与额度」没有可链接的官方文档。**
   issue 要求「规则摘要（链接官方文档）」，但 GLM Coding Plan 的高峰时段 / 倍率没有公开、
   稳定、可验证的官方 URL 可引用；不编造地址，改为链接规则的上游来源
   [glm-peak-clock 的 src/peak.js](https://github.com/Jackeyhan-JH/glm-peak-clock/blob/main/src/peak.js)
   （`src/peak.js` 头部注释标明了复制的 commit 号）。

4. **额度数字是本地估算，不是官方账单（备案）。**
   `src/quota.js` 的 `PLAN_LIMITS` / `MODEL_MULTIPLIERS` 是写死的表，按「每次 claude 运行 =
   1 prompt × 倍率」累计，不是官方账单 API；官方若调整套餐或倍率，这两张表需要手动同步。
   README 与本文档均已按「本地估算」的口径书写。

5. **（已解决）帮助文案只写了「再按一次 Ctrl-C」。**
   `start` 与 `serve` 的帮助原文是「再按一次 Ctrl-C 强制停止」。代码里第二次 SIGINT 和
   第二次 SIGTERM 都走强制停止（`src/cli/run-commands.js`、`src/cli/serve-run.js` 的
   `onSignal`），并且 `scheduler.stop()` 无论成功还是失败都让进程退出 0。README 与
   configuration.md 按代码写了第二次 SIGTERM；帮助字符串本身没改。
   本条的帮助文案和运行时文案已经改过：`start` 的用法改为「再来一次强制停止」，`start` 与 `serve` 第一次停止的括号改为「再来一次 Ctrl-C 或 SIGTERM 强制停止」。
