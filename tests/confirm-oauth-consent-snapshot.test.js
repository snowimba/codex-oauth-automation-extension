const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// 步骤 9 同意页快照：点击“继续”后页面无反应时，日志里要能直接看清
// 页面状态（账号、按钮、表单、人机验证），而不是盲目刷新重试 5 轮。

function loadStep9Module() {
  const source = fs.readFileSync('background/steps/confirm-oauth.js', 'utf8');
  const globalScope = {};
  return new Function('self', `${source}; return self.MultiPageBackgroundStep9;`)(globalScope);
}

test('step 9 formatter renders a consent snapshot in one readable line', () => {
  const api = loadStep9Module();
  assert.equal(typeof api.formatStep8ConsentSnapshot, 'function');

  const line = api.formatStep8ConsentSnapshot({
    url: 'https://auth.openai.com/sign-in-with-chatgpt/abc/consent',
    title: '使用 ChatGPT 登录到 Codex',
    headings: ['使用 ChatGPT 登录到 Codex'],
    displayedEmail: '1kx7ib17jz@maoerai.cloud',
    buttonFound: true,
    buttonText: '继续',
    buttonTag: 'button',
    buttonDisabled: false,
    formAction: '/sign-in-with-chatgpt/abc/consent',
    submitCount: 1,
    hasUncheckedCheckbox: false,
    hasCaptcha: true,
    textSample: 'Codex 想要访问你的 ChatGPT 账号',
  });
  assert.match(line, /auth\.openai\.com\/sign-in-with-chatgpt\/abc\/consent/);
  assert.match(line, /页面显示账号：1kx7ib17jz@maoerai\.cloud/);
  assert.match(line, /继续按钮：继续/);
  assert.match(line, /检测到人机验证元素/);
  assert.match(line, /表单内提交按钮数：1/);
});

test('step 9 formatter handles a missing snapshot and a missing button', () => {
  const api = loadStep9Module();
  assert.equal(api.formatStep8ConsentSnapshot(null), '无快照');
  assert.equal(api.formatStep8ConsentSnapshot(undefined), '无快照');
  assert.match(
    api.formatStep8ConsentSnapshot({ buttonFound: false, hasUncheckedCheckbox: true }),
    /继续按钮：未找到/
  );
  assert.match(
    api.formatStep8ConsentSnapshot({ buttonFound: false, hasUncheckedCheckbox: true }),
    /未勾选的复选框/
  );
});

test('step 9 executor logs the snapshot and fails fast on captcha', () => {
  const source = fs.readFileSync('background/steps/confirm-oauth.js', 'utf8');
  assert.match(source, /formatStep8ConsentSnapshot\(effect\.snapshot\)/);
  assert.match(source, /hasCaptcha && round >= 2/);
  assert.match(source, /同意页出现人机验证，自动点击被拦截/);
  assert.match(source, /连续 \$\{STEP8_MAX_ROUNDS\} 轮点击“继续”后页面仍无反应。快照：/);
  assert.match(source, /return \{ executeStep9, formatStep8ConsentSnapshot \}/);
});

test('content script captures a consent snapshot in the step 8 state', () => {
  const source = fs.readFileSync('content/signup-page.js', 'utf8');
  assert.match(source, /function getOAuthConsentSnapshot\(\)/);
  assert.match(source, /displayedEmail: getLoginVerificationDisplayedEmail\(\)/);
  assert.match(source, /hasCaptcha: Boolean\(/);
  assert.match(source, /hasUncheckedCheckbox: consentForm/);
  assert.match(source, /formAction: consentForm \? String\(consentForm\.getAttribute\('action'\)/);
  assert.match(source, /textSample: pageText\.slice\(0, 300\)/);
  assert.match(source, /snapshot: getOAuthConsentSnapshot\(\),/);
});

test('click-effect wait returns the last consent snapshot on no effect', () => {
  const source = fs.readFileSync('background.js', 'utf8');
  assert.match(source, /let lastSnapshot = null;/);
  assert.match(source, /if \(pageState\?\.snapshot\) \{\n\s*lastSnapshot = pageState\.snapshot;\n\s*\}/);
  assert.match(source, /return \{ progressed: false, reason: 'no_effect', snapshot: lastSnapshot \};/);
});
