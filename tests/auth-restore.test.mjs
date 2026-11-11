import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), 'utf8');
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await import(path.join(rootDir, 'shared', 'auth-restore.js'));
const { parseAuthFileName, parseAuthFileList, inferRestoreProvider, findSavedPassword } = globalThis.AuthRestore;

test('解析用户给的例子：codex-k5k4icd4g7@maoerai.cloud-free.json', () => {
  const parsed = parseAuthFileName('codex-k5k4icd4g7@maoerai.cloud-free.json');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.email, 'k5k4icd4g7@maoerai.cloud');
  assert.equal(parsed.tag, 'free');
  assert.equal(parsed.domain, 'maoerai.cloud');
});

test('解析无 tag 与带 tag 的文件名', () => {
  assert.equal(parseAuthFileName('codex-user@qq.com.json').email, 'user@qq.com');
  assert.equal(parseAuthFileName('codex-abc@2925.com-free.json').email, 'abc@2925.com');
  assert.equal(parseAuthFileName('codex-a.b@duck.com.json').email, 'a.b@duck.com');
});

test('解析失败时给出原因，不会编造邮箱', () => {
  assert.equal(parseAuthFileName('bad.txt').ok, false);
  assert.equal(parseAuthFileName('codex-noemail.json').ok, false);
  assert.equal(parseAuthFileName('codex-a@b.json').ok, false);
});

test('批量解析去重并报告跳过的条目', () => {
  const { items, skipped } = parseAuthFileList(
    'codex-k5k4icd4g7@maoerai.cloud-free.json\ncodex-user@qq.com.json, codex-user@qq.com.json\nbad.txt'
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].email, 'k5k4icd4g7@maoerai.cloud');
  assert.equal(skipped.length, 2);
});

test('按域名推断收码 provider，未知域名返回 null 走手动填码', () => {
  assert.equal(inferRestoreProvider('a@qq.com'), 'qq_mail');
  assert.equal(inferRestoreProvider('a@163.com'), 'mail_163');
  assert.equal(inferRestoreProvider('a@2925.com'), 'mail_2925');
  assert.equal(inferRestoreProvider('k5k4icd4g7@maoerai.cloud'), null);
});

test('从已保存账号里按邮箱找密码（大小写不敏感）', () => {
  const accounts = [{ email: 'A@qq.com', password: 'secret-1' }];
  assert.equal(findSavedPassword(accounts, 'a@qq.com'), 'secret-1');
  assert.equal(findSavedPassword(accounts, 'b@qq.com'), null);
  assert.equal(findSavedPassword([], 'a@qq.com'), null);
});

test('后台已接入恢复流程：只重走 1/6/7/8/9，不走注册', () => {
  const backgroundJs = read('background.js');
  assert.ok(backgroundJs.includes("importScripts('data/names.js', 'shared/mail-2925.js', 'shared/verification-timing.js', 'shared/auth-restore.js')"));
  assert.ok(backgroundJs.includes("case 'PARSE_RESTORE_LIST'"));
  assert.ok(backgroundJs.includes("case 'START_RESTORE'"));
  assert.ok(backgroundJs.includes('async function restoreLoop'));
  assert.ok(backgroundJs.includes('async function runRestoreForAccount'));
  assert.ok(backgroundJs.includes('for (const step of [1, 6, 7, 8, 9])'));
  assert.ok(!backgroundJs.includes('for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9])'), '恢复流程不应包含注册步骤');
});

test('侧边栏已有批量恢复入口：粘贴、选文件、通用密码、开始、导出', () => {
  const html = read('sidepanel/sidepanel.html');
  for (const token of ['input-restore-list', 'input-restore-files', 'input-restore-password', 'btn-start-restore', 'btn-export-restore', 'restore-list']) {
    assert.ok(html.includes(token), `侧边栏缺少恢复入口: ${token}`);
  }
  const js = read('sidepanel/sidepanel.js');
  assert.ok(js.includes('PARSE_RESTORE_LIST'));
  assert.ok(js.includes('START_RESTORE'));
  assert.ok(js.includes('initializeRestoreActions'));
});
