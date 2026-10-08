#!/usr/bin/env node
// 假 gh：模拟测试里用到的 `gh pr create`、`gh pr list`、`gh repo view`、`gh issue view`
// 和 `gh issue list`，绝不联网。
// 行为由环境变量控制：
//   FAKE_GH_LOG            若设置，把 argv 作为一行 JSON 追加到该文件
//   FAKE_GH_PR_NUMBER      pr create 输出的 PR 编号（默认 1）
//   FAKE_GH_FAIL=1         pr create 报错退出 1（只作用于 pr create）
//   FAKE_GH_REPO           未用 --repo 且不在 git 仓库里时的兜底 owner/name
//   FAKE_GH_DEFAULT_BRANCH repo view 输出的默认分支名（默认 main）
//   FAKE_GH_EXISTING_PR_URL pr list 输出里的 open PR 地址；未设置时输出空数组 []
//   FAKE_GH_BODY_COPY      pr create 时把 --body-file 指向的文件内容复制到该路径
//                          （临时正文文件用完就删，测试靠它检查 PR 正文；FAIL=1 时不复制）
//   FAKE_GH_ISSUE_FILE     issue view 输出该 JSON 文件的内容（原样，优先级最高）
//   FAKE_GH_ISSUE_JSON     issue view 输出该 JSON 字符串
//   FAKE_GH_ISSUE_FAIL=1   issue view 报 GraphQL 错误退出 1（优先于上面两个）
//   FAKE_GH_ISSUE_LIST_FAIL=1 issue list 报错退出 1（优先于下面两个；不影响 issue view）
//   FAKE_GH_ISSUE_LIST_FILE  issue list 输出该文件的内容（原样，不补换行）
//   FAKE_GH_ISSUE_LIST_JSON  issue list 输出该 JSON 字符串（原样，不补换行）
// 重要：不带任何参数被调用时（例如被 `node --test` 误当测试文件执行）静默退出 0，
// 且 FAKE_GH_LOG 未设置时不写任何文件。
import { appendFileSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);

function writeLog() {
  const target = process.env.FAKE_GH_LOG;
  if (!target) return;
  appendFileSync(target, `${JSON.stringify(argv)}\n`);
}

// --repo a/b / --repo=a/b / -R a/b / -R=a/b
function repoFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo' || arg === '-R') {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) return next;
    }
    const eq = arg.startsWith('--repo=') || arg.startsWith('-R=') ? arg.indexOf('=') : -1;
    if (eq !== -1) {
      const value = arg.slice(eq + 1);
      if (value !== '') return value;
    }
  }
  return null;
}

// 从 git 远端地址解析 owner/name；支持 github.com 的 ssh / https 写法，
// 本地路径远端记作 local/<basename>。
function parseRemoteUrl(url) {
  if (!url) return null;
  const trimmed = url.trim();
  const github = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(trimmed);
  if (github) return `${github[1]}/${github[2]}`;
  const base = path.basename(trimmed.replace(/[\\/]+$/, ''));
  if (!base) return null;
  return `local/${base.replace(/\.git$/, '')}`;
}

// 在当前目录用 `git remote get-url origin` 推断仓库；git 不存在或失败时返回 null。
function repoFromGit() {
  let res;
  try {
    res = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: process.cwd(), encoding: 'utf8' });
  } catch {
    return null;
  }
  if (!res || res.error || res.status !== 0 || typeof res.stdout !== 'string') return null;
  return parseRemoteUrl(res.stdout);
}

function prNumber() {
  const n = Number.parseInt(process.env.FAKE_GH_PR_NUMBER, 10);
  return Number.isInteger(n) && n > 0 ? n : 1;
}

// --flag <value> / --flag=<value>（值以 - 开头时视为没有值）
function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) return next;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (value !== '') return value;
    }
  }
  return null;
}

// `issue view <n> [--repo <r>] --json title,body`：stdout 输出 issue 的 JSON。
// 内容优先取 FAKE_GH_ISSUE_FILE（文件内容原样输出），其次 FAKE_GH_ISSUE_JSON，
// 都没有时输出 {"title":"Fake issue #<n>","body":"Fake body of <r>#<n>}（r 取
// --repo 参数，兜底 FAKE_GH_REPO / fake-owner/fake-repo）。FAKE_GH_ISSUE_FAIL=1
// 时 stderr 输出 GraphQL 解析错误并退出 1。
function issueView(args) {
  // 编号是 view 后第一个不以 - 开头的参数；--repo/-R/--json 的值跳过，支持 flag 在前在后。
  let number = '1';
  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--repo' || arg === '-R' || arg === '--json') {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) continue;
    number = arg;
    break;
  }
  if (process.env.FAKE_GH_ISSUE_FAIL === '1') {
    process.stderr.write(`GraphQL: Could not resolve to an issue or pull request with the number of ${number}.\n`);
    process.exitCode = 1;
    return;
  }
  const file = process.env.FAKE_GH_ISSUE_FILE;
  if (file) {
    process.stdout.write(readFileSync(file, 'utf8')); // 原样输出，不补换行
    return;
  }
  const json = process.env.FAKE_GH_ISSUE_JSON;
  if (json) {
    process.stdout.write(`${json}\n`);
    return;
  }
  const repo = repoFromArgs(args) || process.env.FAKE_GH_REPO || 'fake-owner/fake-repo';
  process.stdout.write(`${JSON.stringify({ title: `Fake issue #${number}`, body: `Fake body of ${repo}#${number}` })}\n`);
}

// `issue list [--repo <r>] --state <s> --json number,title,body --limit <n>`（flag 顺序
// 无关，只看子命令）：stdout 输出 issue 列表 JSON。FAKE_GH_ISSUE_LIST_FAIL=1 时 stderr
// 一行错误并退出 1（优先级最高）；否则 FAKE_GH_ISSUE_LIST_FILE 的文件内容原样输出，
// 其次 FAKE_GH_ISSUE_LIST_JSON 字符串原样输出（都不补换行）；都没有时输出 []。
// 这些 *_LIST_* 变量不影响 issue view（view 只看 FAKE_GH_ISSUE_*）。
function issueList() {
  if (process.env.FAKE_GH_ISSUE_LIST_FAIL === '1') {
    process.stderr.write('fake gh issue list failure (FAKE_GH_ISSUE_LIST_FAIL=1)\n');
    process.exitCode = 1;
    return;
  }
  const file = process.env.FAKE_GH_ISSUE_LIST_FILE;
  if (file) {
    process.stdout.write(readFileSync(file, 'utf8')); // 原样输出，不补换行
    return;
  }
  const json = process.env.FAKE_GH_ISSUE_LIST_JSON;
  if (json) {
    process.stdout.write(json); // 原样输出，不补换行
    return;
  }
  process.stdout.write('[]\n');
}

function main() {
  writeLog();
  const sub = argv[0];
  const subSub = argv[1];

  if (sub === 'pr' && subSub === 'create') {
    if (process.env.FAKE_GH_FAIL === '1') {
      process.stderr.write('fake gh failure (FAKE_GH_FAIL=1)\n');
      process.exitCode = 1;
      return;
    }
    const copyTo = process.env.FAKE_GH_BODY_COPY;
    if (copyTo) {
      const bodyFile = flagValue(argv, '--body-file');
      if (bodyFile !== null) copyFileSync(bodyFile, copyTo);
    }
    const repo = repoFromArgs(argv)
      ?? repoFromGit()
      ?? (process.env.FAKE_GH_REPO || 'fake-owner/fake-repo');
    process.stdout.write(`https://github.com/${repo}/pull/${prNumber()}\n`);
    return;
  }

  if (sub === 'pr' && subSub === 'list') {
    const url = process.env.FAKE_GH_EXISTING_PR_URL;
    const rows = url ? [{ url }] : [];
    process.stdout.write(`${JSON.stringify(rows)}\n`);
    return;
  }

  if (sub === 'repo' && subSub === 'view') {
    const name = process.env.FAKE_GH_DEFAULT_BRANCH || 'main';
    process.stdout.write(`${JSON.stringify({ defaultBranchRef: { name } })}\n`);
    return;
  }

  if (sub === 'issue' && subSub === 'view') {
    issueView(argv);
    return;
  }

  if (sub === 'issue' && subSub === 'list') {
    issueList();
    return;
  }

  // 其他子命令（auth status、pr view、无参数……）：静默成功。
}

try {
  main();
} catch (err) {
  process.stderr.write(`fake-gh 内部错误：${err && err.stack ? err.stack : String(err)}\n`);
  process.exitCode = 1;
}
