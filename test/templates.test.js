// src/templates.js 的单元测试（issue #13）：列表/加载/解析/渲染。
// fetchIssue 相关用仓库里的假 gh 实际跑（绝不联网、不碰真实 ~/.glm-night-shift）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeEnv, fixturePath, makeTempHome } from './helpers.js';
import {
  BUILTIN_TEMPLATES_DIR,
  listTemplates,
  loadTemplate,
  renderTemplate,
} from '../src/templates.js';

const GH = { ghBin: fixturePath('fake-gh.mjs') }; // renderTemplate 只读 config.ghBin

/** 在 <home>/templates/ 下写一个用户模板，返回 { home, file }。 */
function writeUserTemplate(t, name, content) {
  const home = makeTempHome(t);
  const dir = path.join(home, 'templates');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  fs.writeFileSync(file, content);
  return { home, file };
}

/** 手工构造最小模板对象（渲染逻辑的纯函数测试不依赖文件）。 */
function tpl(overrides = {}) {
  return {
    name: 't',
    source: 'user',
    path: '/tmp/t.md',
    raw: '',
    description: '',
    difficulty: undefined,
    testCommand: null,
    title: undefined,
    vars: [],
    fetchIssue: undefined,
    body: '正文',
    ...overrides,
  };
}

// —— 列表 ——

test('验收: listTemplates 列出四个内置模板，source 都是 builtin，fix-issue 的 vars 正确', () => {
  const templates = listTemplates({ home: '/nonexistent-home' });
  assert.deepEqual(templates.map((t) => t.name), ['add-tests', 'docs', 'fix-issue', 'refactor']);
  for (const t of templates) {
    assert.equal(t.source, 'builtin', t.name);
    assert.equal(t.path, path.join(BUILTIN_TEMPLATES_DIR, `${t.name}.md`));
    // JSON 输出的键集合是定形的（templates --json 按原样序列化这个对象）
    assert.deepEqual(
      Object.keys(t).sort(),
      ['description', 'difficulty', 'name', 'path', 'source', 'testCommand', 'vars'],
    );
  }
  const fix = templates.find((t) => t.name === 'fix-issue');
  assert.equal(fix.description, '修复一个 GitHub issue');
  assert.equal(fix.difficulty, 'medium');
  assert.equal(fix.testCommand, null);
  assert.deepEqual(fix.vars.find((v) => v.name === 'issue'), { name: 'issue', required: true, default: null });
  assert.deepEqual(fix.vars.find((v) => v.name === 'extra'), { name: 'extra', required: false, default: '' });

  const byName = Object.fromEntries(templates.map((t) => [t.name, t]));
  assert.equal(byName['add-tests'].difficulty, 'medium');
  assert.equal(byName['add-tests'].testCommand, 'npm test');
  assert.equal(byName.refactor.difficulty, 'hard');
  assert.equal(byName.docs.difficulty, 'easy');
});

test('验收: 用户目录同名覆盖内置，新增的用户模板也出现在列表里', (t) => {
  const home = makeTempHome(t);
  const dir = path.join(home, 'templates');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs.md'),
    '---\ndescription: 自定义文档模板\nvars: topic\n---\n自定义 {{topic}} 文档');
  fs.writeFileSync(path.join(dir, 'mine.md'),
    '---\ndescription: 我的模板\nvars: a\n---\n内容 {{a}}');

  const templates = listTemplates({ home });
  assert.deepEqual(templates.map((x) => x.name), ['add-tests', 'docs', 'fix-issue', 'mine', 'refactor']);
  const docs = templates.find((x) => x.name === 'docs');
  assert.equal(docs.source, 'user');
  assert.equal(docs.description, '自定义文档模板');
  assert.equal(docs.path, path.join(dir, 'docs.md'));
  const mine = templates.find((x) => x.name === 'mine');
  assert.equal(mine.source, 'user');
  assert.equal(mine.path, path.join(dir, 'mine.md'));
  assert.equal(templates.find((x) => x.name === 'fix-issue').source, 'builtin', '未覆盖的仍是内置');
});

// —— 加载与 front-matter 解析 ——

test('loadTemplate：找不到抛 NotFoundError，名字不合法（目录穿越）抛 ValidationError', () => {
  assert.throws(
    () => loadTemplate('nope', { home: '/nonexistent-home' }),
    (err) => err.name === 'NotFoundError' && err.message.includes('nope'),
  );
  for (const bad of ['../x', 'a/b', '', '.hidden']) {
    assert.throws(() => loadTemplate(bad, {}), (err) => err.name === 'ValidationError', JSON.stringify(bad));
  }
});

test('非 ASCII 模板名（如中文）能列出也能加载，与列表所见一致', (t) => {
  const { home } = writeUserTemplate(t, '我的模板', '---\nvars: topic\n---\n内容 {{topic}}');
  const listed = listTemplates({ home }).find((x) => x.name === '我的模板');
  assert.equal(listed.source, 'user');
  const loaded = loadTemplate('我的模板', { home });
  assert.equal(loaded.body, '内容 {{topic}}');
});

test('验收: front-matter 缺结束 ---：ValidationError 且信息带文件路径', (t) => {
  const { home, file } = writeUserTemplate(t, 'noclose', '---\ndescription: x\nvars: topic\n');
  assert.throws(
    () => loadTemplate('noclose', { home }),
    (err) => err.name === 'ValidationError' && err.message.includes(file) && err.message.includes('---'),
  );
});

test('front-matter 其他格式错误：首行不是 ---、坏行带行号、缺正文', (t) => {
  const first = writeUserTemplate(t, 'a', 'description: x\n---\n正文');
  assert.throws(() => loadTemplate('a', { home: first.home }), /第 1 行必须是 ---/);

  const badLine = writeUserTemplate(t, 'b', '---\ndescription: x\n这一行没有冒号\n---\n正文');
  assert.throws(() => loadTemplate('b', { home: badLine.home }), /第 3 行必须是「key: value」形式/);

  const noBody = writeUserTemplate(t, 'c', '---\nvars: a\n---\n\n');
  assert.throws(() => loadTemplate('c', { home: noBody.home }), /缺少提示词正文/);
});

test('front-matter：值在第一个冒号切分（可含全角冒号）、空值为 null、未知键忽略', (t) => {
  const { home } = writeUserTemplate(t, 'ok', [
    '---',
    'description: 说明',
    'title: 修复 #{{n}}：{{issue_title}}', // 全角冒号留在值里
    'testCommand:',
    'unknown-key: 随便什么都被忽略',
    'vars: n',
    '---',
    '正文 {{n}}',
    '',
  ].join('\n'));
  const loaded = loadTemplate('ok', { home });
  assert.equal(loaded.title, '修复 #{{n}}：{{issue_title}}');
  assert.equal(loaded.testCommand, null);
  assert.equal(loaded.description, '说明');
  assert.equal(loaded.body, '正文 {{n}}');
});

test('vars 声明：名字? / 名字=默认值 / 连写；非法名字、保留名、重复声明都报错', (t) => {
  const { home } = writeUserTemplate(t, 'v', '---\nvars: a, b?, c=默认 值, d?=x, e==y\n---\n正文');
  assert.deepEqual(loadTemplate('v', { home }).vars, [
    { name: 'a', required: true, default: null },
    { name: 'b', required: false, default: '' },
    { name: 'c', required: false, default: '默认 值' },
    { name: 'd', required: false, default: 'x' },
    { name: 'e', required: false, default: '=y' },
  ]);

  for (const [vars, needle] of [
    ['a, 1bad', '变量名不合法'],
    ['issue_title', '保留名'],
    ['a, a', '声明了多次'],
  ]) {
    const w = writeUserTemplate(t, 'bad', `---\nvars: ${vars}\n---\n正文`);
    assert.throws(() => loadTemplate('bad', { home: w.home }), new RegExp(needle), vars);
  }
});

test('difficulty / fetchIssue 声明不合法时报错（信息带文件路径）', (t) => {
  const diff = writeUserTemplate(t, 'd1', '---\ndifficulty: extreme\nvars: a\n---\n正文');
  assert.throws(() => loadTemplate('d1', { home: diff.home }), (err) =>
    err.name === 'ValidationError' && err.message.includes(diff.file) && err.message.includes('extreme'));

  const fetch = writeUserTemplate(t, 'd2', '---\nvars: a\nfetchIssue: missing\n---\n正文');
  assert.throws(() => loadTemplate('d2', { home: fetch.home }), /fetchIssue .*missing/);
});

// —— 渲染（不碰 gh） ——

test('渲染：缺必填变量 / 传了未声明变量（拼错）/ 正文用了未声明变量 → ValidationError 列出变量名', async () => {
  const template = tpl({ vars: [{ name: 'issue', required: true, default: null }, { name: 'extra', required: false, default: '' }] });
  await assert.rejects(
    () => renderTemplate(template, {}),
    (err) => err.name === 'ValidationError' && err.message.includes('issue'),
  );
  await assert.rejects(
    () => renderTemplate(template, { isue: '1' }),
    (err) => err.name === 'ValidationError' && err.message.includes('isue'),
  );
  await assert.rejects(
    () => renderTemplate(tpl({ body: 'x {{nope}} {{other}}' }), {}),
    (err) => err.name === 'ValidationError' && err.message.includes('nope') && err.message.includes('other'),
  );
});

test('渲染：可选变量缺省为空串或默认值；给了就用给的', async () => {
  const template = tpl({
    vars: [
      { name: 'a', required: true, default: null },
      { name: 'opt', required: false, default: '' },
      { name: 'withDef', required: false, default: '默认' },
    ],
    body: 'a={{a}} opt={{opt}} withDef={{withDef}}',
  });
  assert.equal((await renderTemplate(template, { a: '1' })).prompt, 'a=1 opt= withDef=默认');
  assert.equal(
    (await renderTemplate(template, { a: '1', opt: 'o', withDef: '显式' })).prompt,
    'a=1 opt=o withDef=显式',
  );
});

test('渲染：{{ 名字 }} 内侧允许空白；值原样代入，值里的 {{ }} 不再展开', async () => {
  const template = tpl({ vars: [{ name: 'v', required: true, default: null }], body: 'a {{ v }} b' });
  const rendered = await renderTemplate(template, { v: '{{v}} 恶意' });
  assert.equal(rendered.prompt, 'a {{v}} 恶意 b');
});

test('渲染：3 个及以上连续换行压缩成一个空行，首尾去空白；title 同样处理', async () => {
  const template = tpl({
    vars: [{ name: 'v', required: false, default: '' }],
    title: ' {{v}} ',
    body: '\n开头\n\n\n\n\n中间\n\n结尾\n\n',
  });
  const rendered = await renderTemplate(template, { v: 'x' });
  assert.equal(rendered.prompt, '开头\n\n中间\n\n结尾');
  assert.equal(rendered.title, 'x');
});

test('渲染：title 渲染为空时返回 null（让 add 按规则从 prompt 取标题）', async () => {
  const template = tpl({ vars: [{ name: 'v', required: false, default: '' }], title: '{{v}}', body: '正文' });
  assert.equal((await renderTemplate(template, {})).title, null);
  assert.equal((await renderTemplate(template, { v: 'x' })).title, 'x');
});

test('渲染：正文渲染后全空 → ValidationError', async () => {
  const template = tpl({ vars: [{ name: 'v', required: false, default: '' }], body: ' {{v}} ' });
  await assert.rejects(() => renderTemplate(template, {}), /渲染后为空/);
});

// —— fetchIssue（假 gh 实跑） ——

test('验收: fetchIssue 用假 gh 拉取，FAKE_GH_LOG 记录完整参数数组', async (t) => {
  const home = makeTempHome(t);
  const log = path.join(home, 'gh.log');
  const template = loadTemplate('fix-issue', { home: '/nonexistent-home' });
  const rendered = await renderTemplate(template, { issue: '12' }, {
    repo: 'a/b',
    config: GH,
    env: fakeEnv({
      FAKE_GH_ISSUE_JSON: '{"title":"登录报错","body":"点击登录 500"}',
      FAKE_GH_LOG: log,
    }),
  });
  assert.equal(rendered.title, '修复 #12：登录报错');
  assert.ok(rendered.prompt.includes('issue #12'), rendered.prompt);
  assert.ok(rendered.prompt.includes('登录报错'), rendered.prompt);
  assert.ok(rendered.prompt.includes('点击登录 500'), rendered.prompt);
  assert.equal(rendered.difficulty, 'medium');
  assert.equal(rendered.testCommand, null);
  const logged = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(logged, [['issue', 'view', '12', '--repo', 'a/b', '--json', 'title,body']]);
});

test('验收: gh 失败时抛错且信息带 gh 的 stderr（Could not resolve）', async () => {
  const template = loadTemplate('fix-issue', { home: '/nonexistent-home' });
  await assert.rejects(
    () => renderTemplate(template, { issue: '404' }, {
      repo: 'a/b',
      config: GH,
      env: fakeEnv({ FAKE_GH_ISSUE_FAIL: '1' }),
    }),
    (err) => err.message.includes('Could not resolve'),
  );
});

test('假 gh 默认输出：Fake issue #<n> / Fake body of <repo>#<n>', async () => {
  const template = tpl({
    vars: [{ name: 'issue', required: true, default: null }],
    fetchIssue: 'issue',
    body: '{{issue_title}}|{{issue_body}}',
  });
  const rendered = await renderTemplate(template, { issue: '3' }, { repo: 'a/b', config: GH, env: fakeEnv() });
  assert.equal(rendered.prompt, 'Fake issue #3|Fake body of a/b#3');
});

test('FAKE_GH_ISSUE_FILE 指向的 JSON 文件作为 gh 输出', async (t) => {
  const home = makeTempHome(t);
  const issueFile = path.join(home, 'issue.json');
  fs.writeFileSync(issueFile, '{"title":"文件标题","body":"文件正文"}');
  const template = loadTemplate('fix-issue', { home: '/nonexistent-home' });
  const rendered = await renderTemplate(template, { issue: '7' }, {
    repo: 'x/y',
    config: GH,
    env: fakeEnv({ FAKE_GH_ISSUE_FILE: issueFile }),
  });
  assert.equal(rendered.title, '修复 #7：文件标题');
  assert.ok(rendered.prompt.includes('文件正文'));
});

test('fetchIssue 相关的调用方参数：repo 缺失、issue 变量为空都报 ValidationError', async () => {
  const template = tpl({
    vars: [{ name: 'issue', required: false, default: '' }],
    fetchIssue: 'issue',
    body: '{{issue_title}}',
  });
  await assert.rejects(
    () => renderTemplate(template, {}, { repo: undefined, config: GH, env: fakeEnv() }),
    (err) => err.name === 'ValidationError' && err.message.includes('repo'),
  );
  await assert.rejects(
    () => renderTemplate(template, { issue: '' }, { repo: 'a/b', config: GH, env: fakeEnv() }),
    (err) => err.name === 'ValidationError' && err.message.includes('issue'),
  );
});

test('没有 fetchIssue 时 issue_title / issue_body 按空串代入（不报错）', async () => {
  const rendered = await renderTemplate(tpl({ body: 'a{{issue_title}}b{{issue_body}}c' }), {});
  assert.equal(rendered.prompt, 'abc');
});
