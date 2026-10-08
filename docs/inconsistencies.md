# 文档与代码的已知不一致

写 README 与 docs/configuration.md 时（issue #20）发现的、Issue 描述（或截图）与代码实际
行为不一致的地方。按约定**不改代码**，在这里列出，由产品决定改哪边。

1. **package.json 没有 `npm run e2e` script。**
   issue #20 的 README 开发节原本要求写 `npm run e2e`，但 `package.json` 目前只有
   `npm test`（`node --test`）。e2e 套件在 issue #19 开发中、尚未合并为 script，所以 README
   开发节只写了 `npm test`，并注明 e2e 尚未成为 script。#19 合并后应回来补上。

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
