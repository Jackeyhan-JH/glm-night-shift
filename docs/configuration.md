# 配置详解

配置生效顺序：**内置默认值 < `<数据目录>/config.json` < 环境变量**（实现见 `src/config.js`）。

- config.json 不存在时直接用默认值（不创建任何目录或文件）；
- JSON 不合法 / 顶层不是对象 / 读不了：报错并带文件绝对路径；
- 嵌套普通对象**按键合并**（如只改 `difficulty.medium` 时，`easy` / `hard` 仍用默认值），
  数组与标量整体替换，未知字段原样保留（不报错）；
- `night-shift config` 查看当前生效配置与数据目录各路径，`night-shift config --json` 输出
  机器可读版本（`{ home, configPath, dbPath, config }`）。

数据目录由环境变量 `NIGHT_SHIFT_HOME` 决定（非空时解析为绝对路径），默认
`~/.glm-night-shift`。首次运行自动创建三个子目录：`logs/`（运行日志）、`repos/`（仓库
缓存）、`worktrees/`（任务工作副本）。

## 配置项逐项说明

### concurrency

同时运行的任务数上限。正整数（≥ 1）。默认 `1`。

两个须知：

- **并发名额要等 worktree 清理完才释放**：任务结束（成功或失败）后先清理 worktree、再释放
  名额、最后才发出 done 事件（`src/scheduler.js` 的 `processTask`：cleanup 在 done 之前，
  监听者收到 done 时名额一定已释放）。`concurrency` 为 1 时，任务刚成功后的下一次轮询可能
  空转一次，这是预期行为，不是丢任务。
- 把并发调大前先确认 `<数据目录>/worktrees/` 所在磁盘装得下同时存在的多份工作副本。

```json
{ "concurrency": 2 }
```

### timeoutMinutes

单次 claude 运行（任务执行）的超时，分钟数，正数。到点先对整个进程组 SIGTERM，超过
`killGraceSeconds` 仍存活再 SIGKILL；超时按「普通失败」处理（还有次数就诊断后重试）。
默认 `60`。

### killGraceSeconds

SIGTERM 之后等多少秒再升级 SIGKILL，非负整数。默认 `10`。对任务运行、测试命令、诊断
都生效。

### maxAttempts

每个任务的最大尝试次数（含首次），正整数。任务级可用 `add --max-attempts` 覆盖，不给时
取这里的值。次数用尽的失败任务落到终态 `failed`（也不再诊断）。默认 `2`。

### pollSeconds

调度器轮询队列的间隔，秒，正数。默认 `30`；演示/测试里常用 `1`。

### port

看板 HTTP 服务监听端口，1–65535 的整数；命令行 `serve --port` / `serve-api --port` 优先于
配置（`--port 0` = 随机端口）。默认 `7788`。环境变量 `NIGHT_SHIFT_PORT`（非法值报错）。

### host

看板监听地址。默认 `"127.0.0.1"`（只听本机）。改成非回环地址（`127.0.0.1` / `localhost` /
`::1` 之外）时，`serve` 启动会打安全警告——看板没有任何登录，不要暴露到公网。

### plan

GLM 套餐名，额度估算用（`src/quota.js` 的 `PLAN_LIMITS`）：

| 套餐 | 5 小时限额 | 每周限额 |
| --- | --- | --- |
| `v2-lite` | 80 | 400 |
| `v2-pro` | 400 | 2000 |
| `v2-max`（默认） | 1600 | 8000 |

单位是 prompt（一次 claude 运行算 1 个，乘以模型倍率）。未知套餐名会报错。

### weekStart

周额度窗口的周期起点（下单时间），ISO 时间字符串（如 `"2026-09-01T00:00:00+08:00"`）。
给了就按它起每 7 天一个周期统计；`null`（默认）= 最近 7 天的滚动窗口。两种口径都能在
`night-shift usage` 的输出里看出区别（周期窗口会显示重置时刻，滚动窗口不会）。

### safetyRatio

额度安全系数，0～1 之间的数字（默认 `0.9`）：`used + 下次预计开销 ≤ 限额 × safetyRatio`
两项窗口（5 小时 / 每周）都满足才放行新任务。

### allowPeak

全局是否允许在高峰期领任务，布尔值，默认 `false`。任务级的 `add --allow-peak` 独立控制：
任务允许但全局不允许时，该任务高峰也能跑；全局允许时不影响任何任务的判断。

### claudeBin

claude 可执行文件（Claude Code CLI）。默认 `"claude"`（走 PATH）。环境变量
`NIGHT_SHIFT_CLAUDE_BIN` 覆盖——测试与 `scripts/demo.sh` 用它指向仓库里的假替身。

### ghBin

gh 可执行文件。默认 `"gh"`。环境变量 `NIGHT_SHIFT_GH_BIN` 覆盖。

### difficulty

难度 → 模型 / 思考强度的映射。三个档位 `easy` / `medium` / `hard`，每档一个
`{ "model": …, "effort": … }` 对象；`add --difficulty` 选择档位，执行器用映射出的 `model`
调 claude、用 `effort` 去查 `effortThinkingTokens`。默认：

```json
{
  "difficulty": {
    "easy":   { "model": "glm-5.3-flash", "effort": "low" },
    "medium": { "model": "glm-5.3",       "effort": "medium" },
    "hard":   { "model": "glm-5.3",       "effort": "high" }
  }
}
```

想改某一档（例如把 medium 也换成 flash 省额度）只写那一档即可，嵌套对象按键合并：

```json
{ "difficulty": { "medium": { "model": "glm-5.3-flash", "effort": "medium" } } }
```

### effortThinkingTokens

每个思考强度档位给 claude 的 `MAX_THINKING_TOKENS`（思考预算，token 数）。键是 effort 名
（`low` / `medium` / `high`，与 `difficulty` 里写的 effort 对应），值是非负整数，默认
`{ "low": 0, "medium": 8000, "high": 32000 }`。

- 值为 `0` 时执行器会**删掉**子进程环境里的 `MAX_THINKING_TOKENS`（外层环境残留的值不会
  泄漏给 claude）；
- 失败诊断（`diagnose`）永远不开思考。

```json
{ "effortThinkingTokens": { "high": 64000 } }
```

### remoteUrlTemplate

任务仓库远端地址模板。占位符（替换逻辑见 `src/git.js` 的 `remoteUrl`）：

- `{repo}` → `owner/name`（完整标识）
- `{owner}` → owner
- `{name}` → name

默认 `"https://github.com/{repo}.git"`。改成 SSH：

```json
{ "remoteUrlTemplate": "git@github.com:{repo}.git" }
```

改成自建 / 本地路径（`scripts/demo.sh` 就是这么做的，`{name}` 换成仓库名后指向本地 bare
仓库，全程不联网）：

```json
{ "remoteUrlTemplate": "/tmp/glm-night-shift-demo/demo/{name}.git" }
```

配置改了之后，已缓存的仓库会在下次 `ensureRepoCache` 时自动 `git remote set-url` 改指新地址。

### gitAuthorName / gitAuthorEmail

任务提交（worktree 里的 `git commit`）用的身份。`null`（默认）= 沿用机器自己的 git 身份
（环境变量或全局配置）。设置后同时通过 `-c user.name/email` 与 `GIT_AUTHOR_*` /
`GIT_COMMITTER_*` 环境变量传入，机器上残留的 `GIT_AUTHOR_*` 不会盖掉它。

```json
{ "gitAuthorName": "night-shift-bot", "gitAuthorEmail": "bot@example.com" }
```

### testTimeoutMinutes

任务测试命令（`add --test`）的超时，分钟数，正数，默认 `15`。测试进程组会被完整清理，
后台孙进程也不留。

### rateLimitBackoffMinutes

claude 返回 429 / rate limit 时的退避时长，分钟数，正数，默认 `15`：该任务退回队列不扣
次数，同时**全局**暂停领取到退避时刻（限流是整个账号的事）。

### keepFailedWorktrees

布尔值，默认 `false`。`true` 时**失败**（终态 failed）任务的 worktree 保留在
`<数据目录>/worktrees/task-<id>/` 不清理，方便进现场看日志与改动。留意磁盘占用：每个
现场都是一份完整工作副本。手动清理：先停掉调度器（serve / start），再删对应的 worktree
目录；不要在调度器运行时删可能正在使用的目录。成功任务的 worktree 无论该配置如何都会
清理。

### autoDiagnose

布尔值，默认 `true`。普通失败（执行器失败 / 超时 / 测试失败 / git 阶段出错）且还有重试
次数时，先用 `diagnoseModel` 跑一次只读诊断，把「原因 + 修复建议」附进重试的 prompt。
限流、停机中断、取消、没有改动、次数用尽的失败都不诊断。诊断被高峰 / 额度拦下时跳过
（原因记进失败运行的日志），不影响重试。

### diagnoseModel

诊断用的模型，默认 `"glm-5.3-flash"`（便宜档）。诊断是只读的：不带
`--dangerously-skip-permissions`、不开思考（MAX_THINKING_TOKENS 会被删掉）、在
`<数据目录>/tmp/diag-<runId>` 的临时空目录里跑（不在任务 worktree 里），用完即删。

### diagnoseTimeoutMinutes

单次诊断的超时，分钟数，正数，默认 `5`（诊断不该比任务本身还久）。

### systemctlBin

`install-service` / `uninstall-service` 调用的 systemctl 可执行文件，默认 `"systemctl"`。
环境变量 `NIGHT_SHIFT_SYSTEMCTL_BIN` 覆盖（测试指向假替身）。

### oneTaskPerRepo

布尔值，默认 `true`：某仓库已经有 `running` 的任务时，先不领这个仓库的其他排队任务，
别的仓库照常领，直到凑满 `concurrency`。被挡住的任务留在队列里，等先跑的结束（成功或
失败）后下一轮轮询自然会领走；这不算被拦截（`status()` 的 `blocked` 仍是 `null`，调度器
按 `pollSeconds` 正常等待，不空转）。

- 只在 `concurrency` 大于 1 时看得到差别：并发为 1 时同一时刻本来就只有一个任务在跑，
  默认安装无感。
- 设成 `false` 允许同一仓库并行跑多个任务。注意代价：它们各自一份 worktree，但都往同一
  个默认分支开 PR，后推的常和先推的打架（`--force-with-lease` 拒绝、PR 互相覆盖）。
- 只限制**同时跑**几条，不限制一个仓库能排多少条任务；同一仓库不管分支一律算同一把锁
  （不按分支细分）。
- `runNow`（点名立刻跑）不受此锁约束。

### autoFollowReviews

布尔值，默认 `false`。`true` 时调度器（`serve` / `start`）在**非高峰**时段自动扫描已
成功任务的 PR 评审——与 `night-shift follow --all` 同一套判定（见下文 follow 一节），
结论是 `CHANGES_REQUESTED` 就在原 night-shift 分支上入队一条跟进任务，不用人值守。
默认 `false` 时调度器不轮询：任何一轮 tick 都不会为这件事调用 `gh`，发现评审要求修改
后手动跑 `follow`。

- 只跟 `CHANGES_REQUESTED`；不跟 `APPROVED` / `COMMENTED`，不合并 PR，也没有网页按钮
  （开了自动跟进之后，任务自己出现在队列里）。
- 查到的跟进任务照旧排队等领取：扫描只入队、不执行，领取仍走高峰 / 额度 / 暂停的原有
  规则；手动 `pause` 或限流退避期间**仍然扫描**（可以入队），只是那几轮不领取。

### followPollMinutes

两次自动跟进扫描至少间隔的分钟数，正数，默认 `30`。间隔按调度器自己的时钟计算。
高峰期间不扫描、也不刷新「刚查过」的时刻：高峰一结束的下一轮 tick 就可以扫，不必再
等满一个间隔。扫描中 `gh` 失败同样算查过（调度器记一条日志、本轮不再扫其余父任务），
至少隔这么多分钟才会再试。

### prStatus

布尔值，默认 `false`。`true` 时调度器（`serve` / `start`）定期用
`gh pr view --json state,mergedAt` 查询已成功任务的 PR state，把结论记在任务上
（详情页 PR 行后面出现「PR 结果」：`MERGED` → 已合并、`CLOSED` → 已关闭）。
默认 `false` 时调度器不轮询：任何一轮 tick 都不会为这件事调用 `gh`。

- 与 `autoFollowReviews` 相反，打开后**高峰也会查**；手动 `pause`、限流退避期间
  同样查（只写结论，不领取、不入队）。
- 只把结论写进任务的 `prOutcome`，**不改变任务 status**（成功仍是成功）；已经是
  `merged` / `closed` 的不再查，`open` 的下一轮间隔到了还会再查。
- gh 返回的 state 不是 `OPEN` / `MERGED` / `CLOSED`（大小写敏感）、或输出不是
  JSON 对象时，记一条日志、跳过该任务，不写入任何结论。

### prStatusPollMinutes

两次 PR 状态查询至少间隔的分钟数，正数，默认 `30`。间隔按调度器自己的时钟计算，
从未查过时第一次符合条件的 tick 立刻查（包括高峰）。`gh` 失败同样算查过（调度器记
一条日志、本轮停止，不查后面的任务），至少隔这么多分钟才会再试。

## 完整 config.json 示例

下面的值全部等于默认值，可以直接拷去改（删掉不想显式写的键即可，缺省键自动用默认值）：

```json
{
  "concurrency": 1,
  "timeoutMinutes": 60,
  "killGraceSeconds": 10,
  "maxAttempts": 2,
  "pollSeconds": 30,
  "port": 7788,
  "host": "127.0.0.1",
  "plan": "v2-max",
  "weekStart": null,
  "safetyRatio": 0.9,
  "allowPeak": false,
  "claudeBin": "claude",
  "ghBin": "gh",
  "difficulty": {
    "easy": { "model": "glm-5.3-flash", "effort": "low" },
    "medium": { "model": "glm-5.3", "effort": "medium" },
    "hard": { "model": "glm-5.3", "effort": "high" }
  },
  "effortThinkingTokens": { "low": 0, "medium": 8000, "high": 32000 },
  "remoteUrlTemplate": "https://github.com/{repo}.git",
  "gitAuthorName": null,
  "gitAuthorEmail": null,
  "testTimeoutMinutes": 15,
  "rateLimitBackoffMinutes": 15,
  "keepFailedWorktrees": false,
  "autoDiagnose": true,
  "diagnoseModel": "glm-5.3-flash",
  "diagnoseTimeoutMinutes": 5,
  "systemctlBin": "systemctl",
  "oneTaskPerRepo": true,
  "autoFollowReviews": false,
  "followPollMinutes": 30,
  "prStatus": false,
  "prStatusPollMinutes": 30
}
```

## NIGHT_SHIFT_* 环境变量一览

| 变量 | 作用 | 取值 / 说明 |
| --- | --- | --- |
| `NIGHT_SHIFT_HOME` | 数据目录 | 任意路径；相对路径按进程 cwd 解析成绝对路径。看板/调度器/数据库/日志/缓存全在这里 |
| `NIGHT_SHIFT_CLAUDE_BIN` | 覆盖 `claudeBin` | claude 可执行文件路径 |
| `NIGHT_SHIFT_GH_BIN` | 覆盖 `ghBin` | gh 可执行文件路径 |
| `NIGHT_SHIFT_SYSTEMCTL_BIN` | 覆盖 `systemctlBin` | systemctl 可执行文件路径 |
| `NIGHT_SHIFT_PORT` | 覆盖 `port` | 1–65535 的整数，其他值直接报错 |
| `NIGHT_SHIFT_NOW` | **仅测试用**：把「现在」固定住 | 合法时间字符串（如 `2026-10-08T07:00:00Z`）；高峰判定、额度窗口、日志时间戳全跟着它走。给了但不是合法时间会抛错退出（绝不悄悄回退到真实时间） |

所有变量都以**空字符串为「未设置」**。`install-service` 会把调用时已设置的
`NIGHT_SHIFT_CLAUDE_BIN` / `NIGHT_SHIFT_GH_BIN` / `NIGHT_SHIFT_PORT` 写进 systemd 单元的
`Environment=` 行（`NIGHT_SHIFT_HOME` 一定写；凭据类变量绝不写）。

## 多台机器 / 多个数据目录

- 每个数据目录一份独立的任务库、仓库缓存、worktree 与配置：给不同机器（或同一台机器的
  不同用途）各设一个 `NIGHT_SHIFT_HOME`，各自起 `serve` 即可，互不共享额度估算与暂停状态。
- **每个数据目录一把 `<数据目录>/scheduler.lock`**：`serve` / `start` 启动时获取，拿不到就
  退出 1，所以同一数据目录天然只有一个调度器；不同数据目录的调度器互不干扰。
- 注意：多个数据目录若指向同一个 GitHub 仓库，会各自开 PR；额度估算也各自独立统计
  （它只看本数据目录的运行历史）。

## 一个数据目录只跑一个调度器（scheduler.lock）

限流暂停（pausedUntil）与依赖阻塞（blocked）只存在于调度器进程内存里，多个进程共用一个
数据目录不会共享——为了避免状态错乱，`serve` 与 `start` 启动时都会获取
`<数据目录>/scheduler.lock`（内容：持锁进程 pid + 一行说明），拿不到就退出 1，不建 HTTP、
不领任务。判定规则（`src/scheduler-lock.js`）：

- pid 已死（进程不存在 / 读不出 pid）→ 过期锁，**接管**（崩溃后不会卡死）；
- pid 活着但 `/proc/<pid>/cmdline` 不含 night-shift（别的程序碰巧占了文件）→ 同样接管；
- pid 活着且像本程序 → 被持有，报「已有调度器在运行（pid …）」退出 1。

正常退出（优雅与强制都是退出 0）时删掉自己的锁；删前重读内容，**只删仍写着自己 pid 的
那份**——后继者接管后写的锁绝不会误删。只看数据不调度的 `serve-api` 不拿锁，可与调度器
并存。

## prompt 的两步 trim（--prompt-file / --prompt）

1. `--prompt-file <路径>`：文件内容**原样**作为提示词，只去掉末尾一个换行（`\n` 或
   `\r\n`；没有就不去）。读取失败（文件不存在等）是运行时错误，报错带路径。
2. 随后建任务时整段 prompt **去掉首尾空白（trim）**；正文中间的换行、空行全部保留。

`--prompt` 直接给的文字跳过第 1 步、同样走第 2 步。结论：任务 prompt 的首尾空白/空行
无论如何都不会保留（全空白会直接报错）；要保留格式请写在正文中间。`--template` 渲染出的
prompt 也一样（渲染后压缩连续空行并 trim）。

## 依赖环只在 deps --set 拒绝

`deps <id> --set` 走存储层 `setDependencies`：边写上之后在完整图上查环，会形成环就回滚并
报错（退出码 1，信息如「会形成依赖环：#1 → #2 → #1」）。

`add --depends-on` 和 HTTP `POST /api/tasks` **不做环检测**。新任务还没有任何入边，它的
`dependsOn` 只是向外指，不可能靠创建把它自己收成环。自己依赖自己在创建和修改时都会拒绝
（「不能依赖自己」），那不是环检测。要改已经存在的任务、让两条边互相指，只能用 `deps --set`，
也只有那里会拒绝环。

## start / serve 的停止

`scheduler.stop()` 无论 Promise 兑现还是拒绝，`start` 和 `serve` 都退出 0。收尾出错已经记在
任务上，不会变成非零退出码。

第一次 SIGINT（Ctrl-C）或第一次 SIGTERM 是优雅停止：不再领新任务，等运行中的任务收尾。
第二次信号是强制停止，第二次也可以是 SIGTERM，不只是再按一次 Ctrl-C。帮助文案只写了
「再按一次 Ctrl-C」，见 docs/inconsistencies.md。`serve` 在强制停止时还会掐掉剩余连接。

## logs --follow

`logs <id> --follow` 先打印已有日志，再轮询新内容。该次运行在库里有了 `finished_at`，并且
日志文件至少安静了一个轮询周期（收尾的「结束」行写在 `finished_at` 之后）才退出 0。

若这次运行永远没有 `finished_at`，命令不会自己停。用 Ctrl-C 结束。这条命令没有安装
「第二次信号才强制」的处理器，Ctrl-C 就是停掉这个跟随进程（Node 的默认 SIGINT），不是
`start` / `serve` 那套优雅再强制的协议。

## follow：按 PR 评审在原分支上跟进

任务成功开出 PR 之后，评审要求修改（`CHANGES_REQUESTED`）时，用 `night-shift follow <id>`
（或 `follow --all` 扫全部已成功任务）在**原来的 night-shift 分支**上入队一条跟进任务：
`gh pr view` 读最新评审，新任务的 `gitRef` 指向父任务成功时推送的分支，worktree 从
`origin/<gitRef>` 检出，提交推回原分支并**复用原来那个 PR**，不新开第二个。评审正文
（trim 后按码点截到 8000）加上「只在当前分支 `<branch>` 上提交并推送，不要开新分支，
不要开新的 PR」作为任务说明；`difficulty` / `priority` / `testCommand` / `allowPeak`
照抄父任务，`maxAttempts` 用默认值。

结论不是 `CHANGES_REQUESTED`（APPROVED / COMMENTED / 空）时输出「没有待处理的修改请求」
退出 0、不建任务；同一来源（`pr-review:<repo>#<PR编号>:<评审id>`）已有任务时输出
「已经入队 #<id>（状态）」退出 0。`--all` 下某条 `gh` 失败会记下来继续，有任何失败
退出码 1、已入队的保留；`--json` 输出 `{created, skipped, failed}`。

调度器也可以自动做这套扫描（issue #49）：配置 `autoFollowReviews` 为 `true` 后，只在
非高峰、且距上次扫描至少 `followPollMinutes` 分钟时扫一遍（判定与入队与本节是同一份
代码，`src/follow.js`），查到的跟进任务照旧排队等领取、不会因为这次扫描就被直接执行；
扫描中 `gh` 失败记一条日志并停止本轮（这次仍算查过）。默认 `false` 时调度器不轮询、
任何一轮都不为此调用 `gh`，要手动跑 `follow`。详见上文 `autoFollowReviews` /
`followPollMinutes` 两节。

## 两个页面同时取消

取消是带状态守卫的：只有 `queued` 或 `running` 能变成 `canceled`。两个看板页同时取消同一个
任务时，先到的成功（200）；后到的任务已经是终态，API 返回 **409**（`InvalidTransitionError`，
不是 400）。队列页把错误显示在页面上，详情页显示在按钮旁，但浏览器控制台仍会记下这条失败
请求。这是预期，不是页面没处理。
