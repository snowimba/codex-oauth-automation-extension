const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  RESTORE_START_STEP,
  RESTORE_STEP_IDS,
  parseAuthFileName,
  parseAuthFileList,
  inferRestoreMailProvider,
  findSavedPassword,
} = require('../auth-restore-utils.js');

test('restore only runs the login chain: steps 6-10', () => {
  assert.equal(RESTORE_START_STEP, 6);
  assert.deepEqual(RESTORE_STEP_IDS, [6, 7, 8, 9, 10]);
});

test('parseAuthFileName parses the user example: email + tag', () => {
  const parsed = parseAuthFileName('codex-k5k4icd4g7@maoerai.cloud-free.json');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.email, 'k5k4icd4g7@maoerai.cloud');
  assert.equal(parsed.tag, 'free');
  assert.equal(parsed.domain, 'maoerai.cloud');
  assert.equal(parsed.localPart, 'k5k4icd4g7');
});

test('parseAuthFileName accepts files without a tag and with a path prefix', () => {
  const parsed = parseAuthFileName('C:\\Users\\shushu\\codex-user@qq.com.json');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.email, 'user@qq.com');
  assert.equal(parsed.tag, '');
});

test('parseAuthFileName rejects non-json files, missing emails and bad suffixes', () => {
  assert.equal(parseAuthFileName('codex-user@qq.com.txt').ok, false);
  assert.equal(parseAuthFileName('codex-no-email-here.json').ok, false);
  assert.equal(parseAuthFileName('codex-user@qq.com-free-extra!.json').ok, false);
  assert.equal(parseAuthFileName('').ok, false);
});

test('parseAuthFileList splits lines, dedupes emails and reports skipped entries', () => {
  const { items, skipped } = parseAuthFileList(
    'codex-a@qq.com-free.json\ncodex-b@2925.com.json, codex-a@qq.com.json;not-a-file.txt'
  );
  assert.deepEqual(items.map((item) => item.email), ['a@qq.com', 'b@2925.com']);
  assert.equal(items[0].tag, 'free');
  assert.equal(skipped.length, 2);
  assert.match(skipped[0].reason, /重复/);
});

test('inferRestoreMailProvider maps known domains to Ultra6 mailProvider values', () => {
  assert.deepEqual(inferRestoreMailProvider('u@qq.com'), { mailProvider: 'qq', manual: false });
  assert.deepEqual(inferRestoreMailProvider('u@163.com'), { mailProvider: '163', manual: false });
  assert.deepEqual(inferRestoreMailProvider('u@vip.163.com'), { mailProvider: '163-vip', manual: false });
  assert.deepEqual(inferRestoreMailProvider('u@126.com'), { mailProvider: '126', manual: false });
  assert.deepEqual(inferRestoreMailProvider('u@2925.com'), { mailProvider: '2925', manual: false });
  assert.deepEqual(inferRestoreMailProvider('u@gmail.com'), { mailProvider: 'gmail', manual: false });
  assert.deepEqual(inferRestoreMailProvider('u@icloud.com'), { mailProvider: 'icloud', manual: false });
  assert.deepEqual(inferRestoreMailProvider('u@outlook.com'), { mailProvider: 'hotmail-api', manual: false });
  assert.deepEqual(inferRestoreMailProvider('u@hotmail.com'), { mailProvider: 'hotmail-api', manual: false });
});

test('inferRestoreMailProvider keeps the current provider for duck.com addresses', () => {
  assert.deepEqual(inferRestoreMailProvider('u@duck.com'), { mailProvider: null, manual: false });
});

test('inferRestoreMailProvider falls back to custom/manual for unknown domains', () => {
  assert.deepEqual(
    inferRestoreMailProvider('k5k4icd4g7@maoerai.cloud'),
    { mailProvider: 'custom', manual: true }
  );
  assert.deepEqual(inferRestoreMailProvider('u@example.org'), { mailProvider: 'custom', manual: true });
});

test('findSavedPassword matches saved accounts case-insensitively', () => {
  const accounts = [
    { email: 'a@qq.com', password: 'pw-a' },
    { email: 'B@2925.com', password: 'pw-b' },
  ];
  assert.equal(findSavedPassword(accounts, 'A@QQ.COM'), 'pw-a');
  assert.equal(findSavedPassword(accounts, 'b@2925.com'), 'pw-b');
  assert.equal(findSavedPassword(accounts, 'missing@qq.com'), null);
  assert.equal(findSavedPassword(null, 'a@qq.com'), null);
});

test('background loads the restore utils and runner, and the restore loop uses the runner', () => {
  const backgroundSource = fs.readFileSync('background.js', 'utf8');
  assert.match(backgroundSource, /'auth-restore-utils\.js'/);
  assert.match(backgroundSource, /'background\/auth-restore-runner\.js'/);
  assert.match(backgroundSource, /self\.AuthRestoreUtils/);
  assert.match(backgroundSource, /self\.MultiPageAuthRestoreRunner\?\.createRestoreChain/);
  assert.match(backgroundSource, /authRestoreChain\.runRestoreAccount/);
  // 恢复不再借用注册用的自动运行序列（无限重开、无 5 分钟超时豁免）。
  assert.doesNotMatch(backgroundSource, /runAutoSequenceFromStep\(RESTORE_START_STEP/);
  assert.match(backgroundSource, /parseAuthFileList,\n\s*startAuthRestoreLoop,\n\s*getAuthRestoreResults,/);

  const routerSource = fs.readFileSync('background/message-router.js', 'utf8');
  assert.match(routerSource, /case 'PARSE_RESTORE_LIST'/);
  assert.match(routerSource, /case 'START_RESTORE'/);
  assert.match(routerSource, /case 'GET_RESTORE_RESULTS'/);
});

function loadRestoreRunnerModule() {
  const source = fs.readFileSync('background/auth-restore-runner.js', 'utf8');
  const globalScope = {};
  return new Function('self', `${source}; return self.MultiPageAuthRestoreRunner;`)(globalScope);
}

function makeRunnerDeps(overrides = {}) {
  const calls = { steps: [], stateUpdates: [] };
  let state = { accounts: [], mailProvider: '163', ...(overrides.initialState || {}) };
  return {
    calls,
    deps: {
      addLog: async () => {},
      broadcastDataUpdate: () => {},
      executeStepAndWait: async (step) => {
        calls.steps.push(step);
        if (overrides.failAtStep === step) {
          throw new Error(overrides.failMessage || `步骤 ${step} 失败`);
        }
        if (overrides.stopAtStep === step) {
          const error = new Error('已停止');
          error.name = 'StopError';
          throw error;
        }
      },
      findSavedPassword: (accounts, email) => {
        const found = (accounts || []).find((item) => item.email === email);
        return found?.password || null;
      },
      getState: async () => ({ ...state }),
      inferRestoreMailProvider: (email) => {
        if (email.endsWith('@qq.com')) return { mailProvider: 'qq', manual: false };
        return { mailProvider: 'custom', manual: true };
      },
      isStopError: (error) => error?.name === 'StopError',
      resetState: async () => {},
      setEmailState: async (email) => { state = { ...state, email }; },
      setPasswordState: async (password) => { state = { ...state, password }; },
      setState: async (updates) => {
        calls.stateUpdates.push({ ...updates });
        state = { ...state, ...updates };
      },
      ...(overrides.deps || {}),
    },
  };
}

test('restore runner exposes a factory and runs steps 6-10 in order', async () => {
  const api = loadRestoreRunnerModule();
  assert.equal(typeof api?.createRestoreChain, 'function');
  assert.deepEqual(api.RESTORE_CHAIN_STEPS, [6, 7, 8, 9, 10]);

  const { calls, deps } = makeRunnerDeps({
    initialState: { accounts: [{ email: 'a@qq.com', password: 'pw-a' }] },
  });
  const chain = api.createRestoreChain(deps);
  const result = await chain.runRestoreAccount({ email: 'a@qq.com', tag: 'free' }, { index: 0, total: 1 });
  assert.equal(result.status, 'success');
  assert.equal(result.mailProvider, 'qq');
  assert.equal(result.manual, false);
  assert.deepEqual(calls.steps, [6, 7, 8, 9, 10]);
});

test('restore runner disables the 5-minute auth chain timeout and forces normal mode', async () => {
  const api = loadRestoreRunnerModule();
  const { calls, deps } = makeRunnerDeps({
    initialState: { accounts: [{ email: 'a@qq.com', password: 'pw-a' }] },
  });
  const chain = api.createRestoreChain(deps);
  await chain.runRestoreAccount({ email: 'a@qq.com' }, { index: 0, total: 1 });
  const restoreUpdate = calls.stateUpdates.find((update) => update.signupMethod === 'email');
  assert.equal(restoreUpdate.oauthFlowTimeoutEnabled, false);
  assert.equal(restoreUpdate.plusModeEnabled, false);
  assert.equal(restoreUpdate.mailProvider, 'qq');
});

test('restore runner fails fast without retrying later steps', async () => {
  const api = loadRestoreRunnerModule();
  const { calls, deps } = makeRunnerDeps({
    initialState: { accounts: [{ email: 'a@qq.com', password: 'pw-a' }] },
    failAtStep: 8,
    failMessage: '步骤 8：收不到登录验证码',
  });
  const chain = api.createRestoreChain(deps);
  const result = await chain.runRestoreAccount({ email: 'a@qq.com' }, { index: 0, total: 1 });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /收不到登录验证码/);
  assert.deepEqual(calls.steps, [6, 7, 8]);
});

test('restore runner marks missing-password accounts failed without running any step', async () => {
  const api = loadRestoreRunnerModule();
  const { calls, deps } = makeRunnerDeps({ initialState: { accounts: [] } });
  const chain = api.createRestoreChain(deps);
  const result = await chain.runRestoreAccount({ email: 'a@qq.com' }, { index: 0, total: 1 });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /缺少密码/);
  assert.deepEqual(calls.steps, []);
});

test('restore runner marks add-phone accounts failed with a clear reason', async () => {
  const api = loadRestoreRunnerModule();
  const { calls, deps } = makeRunnerDeps({
    initialState: { accounts: [{ email: 'a@qq.com', password: 'pw-a' }] },
    failAtStep: 7,
    failMessage: '认证页进入 add-phone',
  });
  const chain = api.createRestoreChain(deps);
  const result = await chain.runRestoreAccount({ email: 'a@qq.com' }, { index: 0, total: 1 });
  assert.equal(result.status, 'failed');
  assert.match(result.reason, /手机号验证/);
  assert.deepEqual(calls.steps, [6, 7]);
});

test('restore runner rethrows stop errors so the batch can abort', async () => {
  const api = loadRestoreRunnerModule();
  const { deps } = makeRunnerDeps({
    initialState: { accounts: [{ email: 'a@qq.com', password: 'pw-a' }] },
    stopAtStep: 7,
  });
  const chain = api.createRestoreChain(deps);
  await assert.rejects(
    () => chain.runRestoreAccount({ email: 'a@qq.com' }, { index: 0, total: 1 }),
    (error) => error.name === 'StopError'
  );
});

test('sidepanel has the batch restore section and controls', () => {
  const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
  assert.match(html, /id="restore-section"/);
  assert.match(html, /批量恢复过期认证/);
  for (const id of [
    'input-restore-list',
    'btn-restore-parse',
    'input-restore-files',
    'input-restore-password',
    'input-restore-continue',
    'btn-start-restore',
    'btn-restore-export',
    'restore-results',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  const sidepanelSource = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');
  assert.match(sidepanelSource, /authRestoreResults/);
  assert.match(sidepanelSource, /PARSE_RESTORE_LIST/);
  assert.match(sidepanelSource, /START_RESTORE/);
  assert.match(sidepanelSource, /GET_RESTORE_RESULTS/);
});

test('manifest is bumped to 6.6 for the consent snapshot release', () => {
  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  assert.equal(manifest.version, '6.6');
  assert.equal(manifest.version_name, 'Ultra6.6');
});
