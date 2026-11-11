const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// 恢复模式强制重新登录：步骤 6 清了 cookies 后浏览器会话仍可能残留，
// 步骤 7 会直接进同意页、跳过邮箱 + 验证码登录。恢复必须以当前账号
// 自己的身份登录，所以步骤 7 在 OAuth 链接上追加 prompt=login。

function loadStep7Module() {
  const source = fs.readFileSync('background/steps/oauth-login.js', 'utf8');
  const globalScope = {};
  return new Function('self', `${source}; return self.MultiPageBackgroundStep7;`)(globalScope);
}

const PANEL_URL = 'https://auth.openai.com/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&response_type=code&scope=openid&state=xyz&nonce=n1&code_challenge=c1&code_challenge_method=S256';

test('buildRestoreLoginUrl appends prompt=login and keeps the panel params', () => {
  const api = loadStep7Module();
  assert.equal(typeof api.buildRestoreLoginUrl, 'function');
  const result = api.buildRestoreLoginUrl(PANEL_URL, true);
  assert.equal(result.forced, true);
  assert.equal(result.alreadyHasPrompt, false);
  const url = new URL(result.url);
  assert.equal(url.searchParams.get('prompt'), 'login');
  assert.equal(url.searchParams.get('client_id'), 'abc');
  assert.equal(url.searchParams.get('state'), 'xyz');
  assert.equal(url.searchParams.get('code_challenge'), 'c1');
});

test('buildRestoreLoginUrl leaves the URL alone without force login', () => {
  const api = loadStep7Module();
  const result = api.buildRestoreLoginUrl(PANEL_URL, false);
  assert.equal(result.url, PANEL_URL);
  assert.equal(result.forced, false);
});

test('buildRestoreLoginUrl does not overwrite an existing prompt', () => {
  const api = loadStep7Module();
  const withPrompt = `${PANEL_URL}&prompt=consent`;
  const result = api.buildRestoreLoginUrl(withPrompt, true);
  assert.equal(result.url, withPrompt);
  assert.equal(result.forced, false);
  assert.equal(result.alreadyHasPrompt, true);
  assert.equal(result.prompt, 'consent');
});

test('buildRestoreLoginUrl falls back to the original URL when it cannot parse', () => {
  const api = loadStep7Module();
  const result = api.buildRestoreLoginUrl('not-a-url', true);
  assert.equal(result.url, 'not-a-url');
  assert.equal(result.forced, false);
});

test('step 7 opens the forced-login URL and guards direct consent in restore mode', () => {
  const source = fs.readFileSync('background/steps/oauth-login.js', 'utf8');
  assert.match(source, /buildRestoreLoginUrl\(oauthUrl, Boolean\(currentState\.restoreForceLogin\)\)/);
  assert.match(source, /reuseOrCreateTab\('signup-page', loginUrl, \{ forceNew: true \}\)/);
  assert.match(source, /恢复模式：强制重新登录（prompt=login）/);
  assert.match(source, /currentState\.restoreForceLogin && result\.directOAuthConsentPage/);
  assert.match(source, /仍直接进入了同意页（浏览器会话未被清除）/);
});

test('restore runner enables forced login and default state keeps it off', () => {
  const runnerSource = fs.readFileSync('background/auth-restore-runner.js', 'utf8');
  assert.match(runnerSource, /restoreForceLogin: true,/);
  const backgroundSource = fs.readFileSync('background.js', 'utf8');
  assert.match(backgroundSource, /restoreForceLogin: false,/);
});
