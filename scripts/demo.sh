#!/usr/bin/env bash
# GLM 夜班一键演示（issue #20）：**只用仓库里的假替身**跑通完整流程——
#   建本地 bare 仓库 → add 3 个任务（一个先失败后成功、一个直接成功、一个依赖第一个）
#   → serve 调度（假 claude 在 worktree 里写 NIGHT_SHIFT_FAKE.md 当作改动）
#   → 提交、推送到本地 bare、假 gh「开 PR」→ 打印任务列表与 PR 地址。
# 绝不调用真实 claude / gh，绝不联网：git 全走本地 bare 仓库，PR 地址只是假 gh 的假输出。
#
# 用法：
#   bash scripts/demo.sh          正常模式：跑完打印结果，杀掉 serve、删除临时目录
#   bash scripts/demo.sh --keep   保留临时数据目录、serve 留在后台，方便打开看板看
set -euo pipefail

# ---------------------------------------------------------------- 参数
KEEP=no
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=yes ;;
    *) echo "未知参数：$arg（可用：--keep）" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------- 仓库根与假替身
# 按脚本自身位置定位仓库，不写死绝对路径。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FAKE_CLAUDE="$REPO_ROOT/test/fixtures/fake-claude.mjs"
FAKE_GH="$REPO_ROOT/test/fixtures/fake-gh.mjs"

# ---------------------------------------------------------------- 安全检查：绝不碰真实 claude / gh
# NIGHT_SHIFT_CLAUDE_BIN / NIGHT_SHIFT_GH_BIN 已被设置成别的值时立即拒绝：
# 演示只允许假替身，以免误用真实 claude 花额度、误用真实 gh 动真实仓库。
if [ -n "${NIGHT_SHIFT_CLAUDE_BIN:-}" ] && [ "$NIGHT_SHIFT_CLAUDE_BIN" != "$FAKE_CLAUDE" ]; then
  echo "拒绝运行：NIGHT_SHIFT_CLAUDE_BIN=$NIGHT_SHIFT_CLAUDE_BIN 不是本仓库的假 claude。" >&2
  echo "演示绝不调用真实 claude；请 unset NIGHT_SHIFT_CLAUDE_BIN 或把它设为：" >&2
  echo "  $FAKE_CLAUDE" >&2
  exit 1
fi
if [ -n "${NIGHT_SHIFT_GH_BIN:-}" ] && [ "$NIGHT_SHIFT_GH_BIN" != "$FAKE_GH" ]; then
  echo "拒绝运行：NIGHT_SHIFT_GH_BIN=$NIGHT_SHIFT_GH_BIN 不是本仓库的假 gh。" >&2
  echo "演示绝不调用真实 gh；请 unset NIGHT_SHIFT_GH_BIN 或把它设为：" >&2
  echo "  $FAKE_GH" >&2
  exit 1
fi

# ---------------------------------------------------------------- 环境
export NIGHT_SHIFT_CLAUDE_BIN="$FAKE_CLAUDE"
export NIGHT_SHIFT_GH_BIN="$FAKE_GH"
# 隔离机器的 git 全局/系统配置（gpg 签名、hooks 等），保证演示可复现。
export GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_SYSTEM=/dev/null
# 清掉可能残留的假替身控制变量，再显式设置本演示需要的，行为完全确定。
unset FAKE_GH_FAIL FAKE_GH_PR_NUMBER FAKE_GH_EXISTING_PR_URL FAKE_GH_LOG \
  FAKE_GH_BODY_COPY FAKE_GH_ISSUE_FILE FAKE_GH_ISSUE_JSON FAKE_GH_ISSUE_FAIL \
  FAKE_GH_REPO FAKE_GH_DEFAULT_BRANCH
unset FAKE_CLAUDE_SCENARIO FAKE_CLAUDE_DELAY_MS FAKE_CLAUDE_RESULT_TEXT \
  FAKE_CLAUDE_ARGS_LOG

# ---------------------------------------------------------------- 临时目录与清理
DEMO_DIR="$(mktemp -d "${TMPDIR:-/tmp}/glm-night-shift-demo-XXXXXX")"
HOME_DIR="$DEMO_DIR/home"            # NIGHT_SHIFT_HOME（数据目录）
SERVE_LOG="$DEMO_DIR/serve.log"
SERVE_PID=""
DASHBOARD_URL=""

cleanup() {
  trap - EXIT INT TERM
  if [ "$KEEP" = "yes" ]; then
    if [ -n "$SERVE_PID" ] && kill -0 "$SERVE_PID" 2>/dev/null; then
      echo ""
      echo "serve 继续在后台运行：pid $SERVE_PID，停止用：kill $SERVE_PID"
    fi
    echo "数据目录已保留：$DEMO_DIR"
    echo "看板地址：${DASHBOARD_URL:-（未解析到）}"
    return 0
  fi
  if [ -n "$SERVE_PID" ] && kill -0 "$SERVE_PID" 2>/dev/null; then
    kill -TERM "$SERVE_PID" 2>/dev/null || true   # 优雅停止：等收尾，最多 5 秒
    for _ in $(seq 1 50); do
      kill -0 "$SERVE_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$SERVE_PID" 2>/dev/null || true   # 仍存活才强杀
  fi
  if [ -n "$DEMO_DIR" ]; then
    rm -rf "$DEMO_DIR"
  fi
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ---------------------------------------------------------------- 本地 bare 仓库（不联网）
echo "==> 准备本地演示仓库 $DEMO_DIR/demo/app.git"
SRC="$DEMO_DIR/demo/src"
BARE="$DEMO_DIR/demo/app.git"
GIT_DEMO=(git -c user.name="night-shift demo" -c user.email="demo@example.com" -c commit.gpgsign=false)
mkdir -p "$SRC"
git init -q -b main "$SRC"
echo "# demo app" > "$SRC/README.md"
git -C "$SRC" add README.md
"${GIT_DEMO[@]}" -C "$SRC" commit -q -m "init"
git clone -q --bare "$SRC" "$BARE"

# ---------------------------------------------------------------- 数据目录与 config.json
# remoteUrlTemplate 用 {name} 占位符指向本地 bare（与 src/git.js 的替换一致：
# {repo}→owner/name、{owner}→owner、{name}→name，demo/app 的 name 即 app）。
# port 写 0，再用 CLI --port 0 覆盖：都表示随机端口，不与本机 7788 冲突。
mkdir -p "$HOME_DIR"
cat > "$HOME_DIR/config.json" <<EOF
{
  "remoteUrlTemplate": "$DEMO_DIR/demo/{name}.git",
  "pollSeconds": 1,
  "host": "127.0.0.1",
  "port": 0,
  "gitAuthorName": "night-shift demo",
  "gitAuthorEmail": "demo@example.com"
}
EOF
export NIGHT_SHIFT_HOME="$HOME_DIR"

# 假 claude 全局计数序列：第 1 次调用 fail（第一个任务首跑失败），
# 之后一直 success（诊断成功 → 第一个任务重试成功 → 其余任务成功）。
export FAKE_CLAUDE_SEQUENCE="fail,success"
export FAKE_CLAUDE_STATE_FILE="$DEMO_DIR/fake-claude-count"
printf '0\n' > "$FAKE_CLAUDE_STATE_FILE"

run_cli() { node "$REPO_ROOT/bin/night-shift.mjs" "$@"; }

# ---------------------------------------------------------------- 加任务
echo "==> 添加 3 个任务（全部 --allow-peak，避免演示撞上北京时间高峰跑不动）"
OUT="$(run_cli add --repo demo/app --title "任务一：先失败、诊断、重试成功" \
  --prompt "任务一：在仓库里加一行演示说明。" --allow-peak --max-attempts 2)"
echo "$OUT"
TASK1_ID="$(printf '%s\n' "$OUT" | sed -n 's/^已加入队列：#\([0-9][0-9]*\).*/\1/p')"
if [ -z "$TASK1_ID" ]; then
  echo "没能从 add 输出里解析任务 id：$OUT" >&2
  exit 1
fi
run_cli add --repo demo/app --title "任务二：一次成功" \
  --prompt "任务二：再补充一行演示说明。" --allow-peak --max-attempts 2
run_cli add --repo demo/app --title "任务三：依赖任务一" \
  --prompt "任务三：依赖任务一的产出。" --allow-peak --max-attempts 2 \
  --depends-on "$TASK1_ID"

# ---------------------------------------------------------------- serve
echo "==> 启动 serve（--port 0 随机端口），日志：$SERVE_LOG"
node "$REPO_ROOT/bin/night-shift.mjs" serve --port 0 >"$SERVE_LOG" 2>&1 &
SERVE_PID=$!

# 从 stdout 的「看板 http://127.0.0.1:<port>」启动行解析看板地址（最多等 10 秒）。
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVE_PID" 2>/dev/null; then
    echo "serve 意外退出，完整日志：" >&2
    cat "$SERVE_LOG" >&2 || true
    exit 1
  fi
  DASHBOARD_URL="$(node -e '
    const fs = require("node:fs");
    const m = /看板 (http:\/\/127\.0\.0\.1:\d+)/.exec(fs.readFileSync(process.argv[1], "utf8"));
    if (m) console.log(m[1]);
  ' "$SERVE_LOG" || true)"
  if [ -n "$DASHBOARD_URL" ]; then break; fi
  sleep 0.1
done
if [ -z "$DASHBOARD_URL" ]; then
  echo "10 秒内没等到看板启动行，serve 日志：" >&2
  cat "$SERVE_LOG" >&2 || true
  exit 1
fi
echo "看板地址：$DASHBOARD_URL（此刻打开能看到任务在跑；正常模式跑完即清理）"

# ---------------------------------------------------------------- 等全部成功（最多 110 秒）
echo "==> 等待 3 个任务全部 succeeded……"
DEADLINE=$(( $(date +%s) + 110 ))
while :; do
  if ! kill -0 "$SERVE_PID" 2>/dev/null; then
    echo "serve 意外退出，serve 日志：" >&2
    cat "$SERVE_LOG" >&2 || true
    exit 1
  fi
  # 输出「succeeded 终态 总数」；终态 = succeeded + failed + canceled。
  STATUS="$(run_cli list --json | node -e '
    let s = "";
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => {
      const tasks = JSON.parse(s);
      const by = {};
      for (const t of tasks) by[t.status] = (by[t.status] || 0) + 1;
      const succeeded = by.succeeded || 0;
      const terminal = succeeded + (by.failed || 0) + (by.canceled || 0);
      console.log(`${succeeded} ${terminal} ${tasks.length}`);
    });
  ')"
  read -r SUCCEEDED TERMINAL TOTAL <<< "$STATUS"
  if [ "$SUCCEEDED" -ge 3 ]; then
    break
  fi
  if [ "$TOTAL" -gt 0 ] && [ "$TERMINAL" -eq "$TOTAL" ]; then
    echo "任务已全部到终态但没有全部成功（succeeded=$SUCCEEDED/$TOTAL）。任务列表：" >&2
    run_cli list >&2 || true
    echo "serve 日志末尾：" >&2
    tail -n 40 "$SERVE_LOG" >&2 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    echo "超过 110 秒仍未全部成功。任务列表：" >&2
    run_cli list >&2 || true
    echo "serve 日志末尾：" >&2
    tail -n 40 "$SERVE_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done

# ---------------------------------------------------------------- 结果
echo ""
echo "==> 演示成功：3 个任务全部 succeeded。任务列表："
run_cli list
echo ""
echo "==> 每个任务的 PR 地址（假 gh 的输出，形如 https://github.com/demo/app/pull/N，并未联网开 PR）："
run_cli list --json | node -e '
  let s = "";
  process.stdin.on("data", (c) => { s += c; });
  process.stdin.on("end", () => {
    for (const t of JSON.parse(s)) {
      console.log(`#${t.id} ${t.title}：${t.prUrl ?? "（无 PR 地址）"}`);
    }
  });
'

if [ "$KEEP" = "no" ]; then
  echo ""
  echo "==> 演示结束：清理 serve 进程与临时目录 $DEMO_DIR"
fi
# 实际的杀进程 / 删目录 / --keep 保留动作都在 EXIT trap（cleanup）里统一收尾。
