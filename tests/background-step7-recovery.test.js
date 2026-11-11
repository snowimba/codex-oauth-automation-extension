const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('background/steps/fetch-login-code.js', 'utf8');
const globalScope = {};
const api = new Function('self', `${source}; return self.MultiPageBackgroundStep8;`)(globalScope);

test('step 8 submits login verification directly without replaying step 7', async () => {
  const calls = {
    ensureReady: 0,
    ensureReadyOptions: [],
    rerunStep7: 0,
    resolveOptions: null,
    setStates: [],
  };
  const realDateNow = Date.now;
  Date.now = () => 123456;

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async (options) => {
      calls.ensureReady += 1;
      calls.ensureReadyOptions.push(options || null);
      return { state: 'verification_page', displayedEmail: 'display.user@example.com' };
    },
    rerunStep7ForStep8Recovery: async () => {
      calls.rerunStep7 += 1;
    },
    getOAuthFlowRemainingMs: async () => 5000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 5000),
    getMailConfig: () => ({
      provider: 'qq',
      label: 'QQ 邮箱',
      source: 'mail-qq',
      url: 'https://mail.qq.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret' }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async (_step, _state, _mail, options) => {
      calls.resolveOptions = options;
    },
    reuseOrCreateTab: async () => {},
    setState: async (payload) => {
      calls.setStates.push(payload);
    },
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  try {
    await executor.executeStep8({
      email: 'user@example.com',
      password: 'secret',
      oauthUrl: 'https://oauth.example/latest',
    });
  } finally {
    Date.now = realDateNow;
  }

  assert.equal(calls.resolveOptions.beforeSubmit, undefined);
  assert.equal(calls.ensureReady, 1);
  assert.equal(calls.rerunStep7, 0);
  assert.equal(calls.resolveOptions.filterAfterTimestamp, 123456);
  assert.equal(typeof calls.resolveOptions.getRemainingTimeMs, 'function');
  assert.equal(await calls.resolveOptions.getRemainingTimeMs({ actionLabel: '登录验证码流程' }), 5000);
  assert.equal(calls.resolveOptions.resendIntervalMs, 25000);
  assert.equal(calls.resolveOptions.targetEmail, 'display.user@example.com');
  assert.deepStrictEqual(calls.setStates, [
    { step8VerificationTargetEmail: 'display.user@example.com' },
  ]);
  assert.deepStrictEqual(calls.ensureReadyOptions, [
    {
      visibleStep: 8,
      authLoginStep: 7,
      allowPhoneVerificationPage: true,
      allowAddEmailPage: true,
      timeoutMs: 5000,
    },
  ]);
  assert.equal(calls.resolveOptions.completionStep, 8);
});

test('step 8 keeps phone-registered accounts on email-code flow when page is email verification', async () => {
  const calls = {
    getMailConfigCalls: 0,
    helperCalls: [],
    completions: [],
    resolveCalls: 0,
  };

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    completeStepFromBackground: async (step, payload) => {
      calls.completions.push({ step, payload });
    },
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => ({ state: 'verification_page', displayedEmail: 'phone-user@example.com' }),
    getOAuthFlowRemainingMs: async () => 5000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
    getMailConfig: () => {
      calls.getMailConfigCalls += 1;
      return {
        provider: 'qq',
        label: 'QQ 邮箱',
      };
    },
    getState: async () => ({
      accountIdentifierType: 'phone',
      signupPhoneCompletedActivation: {
        activationId: 'signup-done',
        phoneNumber: '66959916439',
      },
    }),
    getTabId: async () => 1,
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    phoneVerificationHelpers: {
      completeLoginPhoneVerificationFlow: async (tabId, options) => {
        calls.helperCalls.push({ tabId, visibleStep: options.visibleStep, state: options.state });
        return { code: '654321' };
      },
    },
    resolveSignupMethod: () => 'phone',
    resolveVerificationStep: async () => {
      calls.resolveCalls += 1;
    },
    rerunStep7ForStep8Recovery: async () => {
      throw new Error('phone login branch should not rerun step 7 in this test');
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    visibleStep: 8,
    accountIdentifierType: 'phone',
    signupPhoneCompletedActivation: {
      activationId: 'signup-done',
      phoneNumber: '66959916439',
    },
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(calls.getMailConfigCalls, 1);
  assert.equal(calls.resolveCalls, 1);
  assert.deepStrictEqual(calls.helperCalls, []);
  assert.deepStrictEqual(calls.completions, []);
});

test('step 8 routes only a real phone verification page through sms helper', async () => {
  const calls = {
    getMailConfigCalls: 0,
    helperCalls: [],
    completions: [],
  };

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    completeStepFromBackground: async (step, payload) => {
      calls.completions.push({ step, payload });
    },
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => ({ state: 'phone_verification_page' }),
    getOAuthFlowRemainingMs: async () => 5000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
    getMailConfig: () => {
      calls.getMailConfigCalls += 1;
      return {
        provider: 'qq',
        label: 'QQ 邮箱',
      };
    },
    getState: async () => ({}),
    getTabId: async () => 1,
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    phoneVerificationHelpers: {
      completeLoginPhoneVerificationFlow: async (tabId, options) => {
        calls.helperCalls.push({ tabId, visibleStep: options.visibleStep, state: options.state });
        return { code: '654321' };
      },
    },
    resolveVerificationStep: async () => {
      throw new Error('real phone verification branch should not call email verification flow');
    },
    rerunStep7ForStep8Recovery: async () => {
      throw new Error('real phone verification branch should not rerun step 7 in this test');
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    visibleStep: 8,
    accountIdentifierType: 'phone',
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(calls.getMailConfigCalls, 0);
  assert.deepStrictEqual(calls.helperCalls, [
    {
      tabId: 1,
      visibleStep: 8,
      state: {
        visibleStep: 8,
        accountIdentifierType: 'phone',
        oauthUrl: 'https://oauth.example/latest',
      },
    },
  ]);
  assert.deepStrictEqual(calls.completions, [
    {
      step: 8,
      payload: {
        phoneVerification: true,
        loginPhoneVerification: true,
        code: '654321',
      },
    },
  ]);
});

test('step 8 submits add-email before polling the email verification code', async () => {
  const calls = {
    contentMessages: [],
    resolvedStates: [],
    setStates: [],
    mailStates: [],
  };

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => ({ state: 'add_email_page', url: 'https://auth.openai.com/add-email' }),
    getOAuthFlowRemainingMs: async () => 5000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => defaultTimeoutMs,
    getMailConfig: (state) => {
      calls.mailStates.push(state);
      return {
        provider: 'qq',
        label: 'QQ 邮箱',
        source: 'mail-qq',
        url: 'https://mail.qq.com',
        navigateOnReuse: false,
      };
    },
    getState: async () => ({
      email: '',
      password: 'secret',
      oauthUrl: 'https://oauth.example/latest',
    }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveSignupEmailForFlow: async (state, options = {}) => {
      calls.resolvedStates.push(state);
      calls.resolveOptions = options;
      return 'new.user@example.com';
    },
    resolveVerificationStep: async (_step, state, _mail, options) => {
      calls.resolvedVerification = { state, options };
    },
    rerunStep7ForStep8Recovery: async () => {},
    reuseOrCreateTab: async () => {},
    sendToContentScriptResilient: async (_source, message) => {
      calls.contentMessages.push(message);
      assert.equal(message.type, 'SUBMIT_ADD_EMAIL');
      assert.equal(message.payload.email, 'new.user@example.com');
      return {
        submitted: true,
        displayedEmail: 'new.user@example.com',
        url: 'https://auth.openai.com/email-verification',
      };
    },
    setState: async (payload) => {
      calls.setStates.push(payload);
    },
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    visibleStep: 8,
    accountIdentifierType: 'phone',
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(calls.contentMessages.length, 1);
  assert.equal(calls.resolvedStates.length, 1);
  assert.equal(calls.resolveOptions.preserveAccountIdentity, true);
  assert.equal(calls.mailStates[0].email, 'new.user@example.com');
  assert.equal(calls.resolvedVerification.state.email, 'new.user@example.com');
  assert.equal(calls.resolvedVerification.options.targetEmail, 'new.user@example.com');
  assert.deepStrictEqual(calls.setStates, [
    {
      email: 'new.user@example.com',
      step8VerificationTargetEmail: 'new.user@example.com',
    },
    {
      step8VerificationTargetEmail: 'new.user@example.com',
    },
  ]);
});

test('Plus login-code step reuses step 8 verification logic but completes visible step 11', async () => {
  let resolvedStep = null;
  let resolvedOptions = null;
  let readyOptions = null;
  const remainingStepCalls = [];

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async (options) => {
      readyOptions = options;
      return { state: 'verification_page', displayedEmail: 'plus.user@example.com' };
    },
    rerunStep7ForStep8Recovery: async () => {},
    getOAuthFlowRemainingMs: async (details) => {
      remainingStepCalls.push(details.step);
      return 9000;
    },
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs, details) => {
      remainingStepCalls.push(details.step);
      return Math.min(defaultTimeoutMs, 9000);
    },
    getMailConfig: () => ({
      provider: 'qq',
      label: 'QQ 邮箱',
      source: 'mail-qq',
      url: 'https://mail.qq.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret', plusModeEnabled: true }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async (step, _state, _mail, options) => {
      resolvedStep = step;
      resolvedOptions = options;
      await options.getRemainingTimeMs({ actionLabel: '登录验证码流程' });
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    visibleStep: 11,
    plusModeEnabled: true,
    email: 'user@example.com',
    password: 'secret',
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(resolvedStep, 8);
  assert.equal(resolvedOptions.completionStep, 11);
  assert.equal(resolvedOptions.targetEmail, 'plus.user@example.com');
  assert.deepStrictEqual(readyOptions, {
    visibleStep: 11,
    authLoginStep: 10,
    allowPhoneVerificationPage: true,
    allowAddEmailPage: true,
    timeoutMs: 9000,
  });
  assert.deepStrictEqual(remainingStepCalls, [11, 11]);
});

test('step 8 completes directly when auth page is already on OAuth consent page', async () => {
  const events = {
    resolveCalls: 0,
    completeCalls: [],
    setStates: [],
    rerunStep7: 0,
  };

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    completeStepFromBackground: async (step, payload) => {
      events.completeCalls.push({ step, payload });
    },
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => ({
      state: 'oauth_consent_page',
    }),
    rerunStep7ForStep8Recovery: async () => {
      events.rerunStep7 += 1;
    },
    getOAuthFlowRemainingMs: async () => 9000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 9000),
    getMailConfig: () => ({
      provider: 'qq',
      label: 'QQ 邮箱',
      source: 'mail-qq',
      url: 'https://mail.qq.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret' }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async () => {
      events.resolveCalls += 1;
    },
    reuseOrCreateTab: async () => {},
    setState: async (payload) => {
      events.setStates.push(payload);
    },
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    email: 'user@example.com',
    password: 'secret',
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(events.resolveCalls, 0);
  assert.equal(events.rerunStep7, 0);
  assert.deepStrictEqual(events.setStates, [
    {
      step8VerificationTargetEmail: '',
      loginVerificationRequestedAt: null,
    },
  ]);
  assert.deepStrictEqual(events.completeCalls, [
    {
      step: 8,
      payload: {
        loginVerificationRequestedAt: null,
        skipLoginVerificationStep: true,
        directOAuthConsentPage: true,
      },
    },
  ]);
});

test('step 8 retries in-place when polling fails but auth page still stays on verification page', async () => {
  const events = {
    ensureCalls: 0,
    resolveCalls: 0,
    rerunStep7: 0,
  };
  const pageStates = [
    { state: 'verification_page', displayedEmail: 'user@example.com' },
    { state: 'verification_page', displayedEmail: 'user@example.com' },
    { state: 'verification_page', displayedEmail: 'user@example.com' },
  ];

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    completeStepFromBackground: async () => {},
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => {
      events.ensureCalls += 1;
      return pageStates[Math.min(events.ensureCalls - 1, pageStates.length - 1)];
    },
    rerunStep7ForStep8Recovery: async () => {
      events.rerunStep7 += 1;
    },
    getOAuthFlowRemainingMs: async () => 9000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 9000),
    getMailConfig: () => ({
      provider: 'qq',
      label: 'QQ 邮箱',
      source: 'mail-qq',
      url: 'https://mail.qq.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret' }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: (error) => /页面通信异常|did not respond/i.test(String(error?.message || error || '')),
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async () => {
      events.resolveCalls += 1;
      if (events.resolveCalls === 1) {
        throw new Error('步骤 8：页面通信异常 did not respond in 30s');
      }
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    email: 'user@example.com',
    password: 'secret',
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(events.resolveCalls, 2);
  assert.equal(events.rerunStep7, 0);
  assert.equal(events.ensureCalls >= 3, true);
});

test('step 8 keeps resend cooldown timestamp across in-place retries to avoid repeated resend storms', async () => {
  const events = {
    resolveCalls: 0,
    resolveLastResendAts: [],
    sleepMs: [],
  };
  const realDateNow = Date.now;
  Date.now = () => 230000;

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    completeStepFromBackground: async () => {},
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => ({ state: 'verification_page', displayedEmail: 'user@example.com' }),
    rerunStep7ForStep8Recovery: async () => {},
    getOAuthFlowRemainingMs: async () => 9000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 9000),
    getMailConfig: () => ({
      provider: 'qq',
      label: 'QQ 邮箱',
      source: 'mail-qq',
      url: 'https://mail.qq.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret', loginVerificationRequestedAt: null }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: (error) => /页面通信异常|did not respond/i.test(String(error?.message || error || '')),
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async (_step, _state, _mail, options) => {
      events.resolveCalls += 1;
      events.resolveLastResendAts.push(Number(options?.lastResendAt) || 0);
      if (events.resolveCalls === 1) {
        await options.onResendRequestedAt(222000);
        throw new Error('步骤 8：页面通信异常 did not respond in 1s');
      }
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    sleepWithStop: async (ms) => {
      events.sleepMs.push(ms);
    },
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  try {
    await executor.executeStep8({
      email: 'user@example.com',
      password: 'secret',
      oauthUrl: 'https://oauth.example/latest',
    });
  } finally {
    Date.now = realDateNow;
  }

  assert.equal(events.resolveCalls, 2);
  assert.deepStrictEqual(events.resolveLastResendAts, [0, 222000]);
  assert.equal(events.sleepMs.length >= 1, true);
  assert.equal(events.sleepMs[0], 3000);
});

test('step 8 completes when polling fails but recovery probe shows oauth consent page', async () => {
  const events = {
    ensureCalls: 0,
    resolveCalls: 0,
    rerunStep7: 0,
    completeCalls: [],
  };
  const pageStates = [
    { state: 'verification_page', displayedEmail: 'user@example.com' },
    { state: 'oauth_consent_page' },
  ];

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    completeStepFromBackground: async (step, payload) => {
      events.completeCalls.push({ step, payload });
    },
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => {
      events.ensureCalls += 1;
      return pageStates[Math.min(events.ensureCalls - 1, pageStates.length - 1)];
    },
    rerunStep7ForStep8Recovery: async () => {
      events.rerunStep7 += 1;
    },
    getOAuthFlowRemainingMs: async () => 9000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 9000),
    getMailConfig: () => ({
      provider: 'qq',
      label: 'QQ 邮箱',
      source: 'mail-qq',
      url: 'https://mail.qq.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret' }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: (error) => /页面通信异常|did not respond/i.test(String(error?.message || error || '')),
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async () => {
      events.resolveCalls += 1;
      throw new Error('步骤 8：页面通信异常 did not respond in 30s');
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    email: 'user@example.com',
    password: 'secret',
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(events.resolveCalls, 1);
  assert.equal(events.rerunStep7, 0);
  assert.deepStrictEqual(events.completeCalls, [
    {
      step: 8,
      payload: {
        loginVerificationRequestedAt: null,
        skipLoginVerificationStep: true,
        directOAuthConsentPage: true,
      },
    },
  ]);
});

test('step 8 uses a fixed 10-minute lookback window and disables resend interval for 2925 mailbox polling', async () => {
  let capturedOptions = null;
  let ensureCalls = 0;
  let ensureOptions = null;
  const tabUpdates = [];
  const tabReuses = [];
  const realDateNow = Date.now;
  Date.now = () => 900000;

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async (tabId, payload) => {
          tabUpdates.push({ tabId, payload });
        },
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    confirmCustomVerificationStepBypass: async () => {},
    ensureMail2925MailboxSession: async (options) => {
      ensureCalls += 1;
      ensureOptions = options;
    },
    ensureStep8VerificationPageReady: async () => ({ state: 'verification_page' }),
    rerunStep7ForStep8Recovery: async () => {},
    getOAuthFlowRemainingMs: async () => 8000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 8000),
    getMailConfig: () => ({
      provider: '2925',
      label: '2925 邮箱',
      source: 'mail-2925',
      url: 'https://2925.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({
      email: 'user@example.com',
      password: 'secret',
      mail2925UseAccountPool: true,
      currentMail2925AccountId: 'acc-1',
      mail2925Accounts: [
        { id: 'acc-1', email: 'pool-user@2925.com' },
      ],
    }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async (_step, _state, _mail, options) => {
      capturedOptions = options;
    },
    reuseOrCreateTab: async (source, url) => {
      tabReuses.push({ source, url });
    },
    setState: async () => {},
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  try {
    await executor.executeStep8({
      email: 'user@example.com',
      password: 'secret',
      oauthUrl: 'https://oauth.example/latest',
      mail2925UseAccountPool: true,
      currentMail2925AccountId: 'acc-1',
      mail2925Accounts: [
        { id: 'acc-1', email: 'pool-user@2925.com' },
      ],
    });
  } finally {
    Date.now = realDateNow;
  }

  assert.equal(ensureCalls, 1);
  assert.deepStrictEqual(ensureOptions, {
    accountId: 'acc-1',
    forceRelogin: false,
    allowLoginWhenOnLoginPage: true,
    expectedMailboxEmail: 'pool-user@2925.com',
    actionLabel: 'Step 8: ensure 2925 mailbox session',
  });
  assert.deepStrictEqual(tabReuses, []);
  assert.deepStrictEqual(tabUpdates, [
    { tabId: 1, payload: { active: true } },
  ]);
  assert.equal(capturedOptions.filterAfterTimestamp, 300000);
  assert.equal(capturedOptions.resendIntervalMs, 0);
  assert.equal(capturedOptions.targetEmail, '');
  assert.equal(capturedOptions.beforeSubmit, undefined);
  assert.equal(typeof capturedOptions.getRemainingTimeMs, 'function');
});

test('step 8 falls back to the run email when the verification page does not expose a displayed email', async () => {
  let capturedOptions = null;

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => ({ state: 'verification_page', displayedEmail: '' }),
    rerunStep7ForStep8Recovery: async () => {},
    getOAuthFlowRemainingMs: async () => 8000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 8000),
    getMailConfig: () => ({
      provider: 'qq',
      label: 'QQ 邮箱',
      source: 'mail-qq',
      url: 'https://mail.qq.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret' }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async (_step, _state, _mail, options) => {
      capturedOptions = options;
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    email: 'user@example.com',
    password: 'secret',
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(capturedOptions.targetEmail, 'user@example.com');
});

test('step 8 does not rerun step 7 when verification submit lands on add-phone', async () => {
  const calls = {
    rerunStep7: 0,
    logs: [],
  };

  const executor = api.createStep8Executor({
    addLog: async (message, level = 'info') => {
      calls.logs.push({ message, level });
    },
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    confirmCustomVerificationStepBypass: async () => {},
    ensureStep8VerificationPageReady: async () => ({ state: 'verification_page' }),
    rerunStep7ForStep8Recovery: async () => {
      calls.rerunStep7 += 1;
    },
    getOAuthFlowRemainingMs: async () => 8000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 8000),
    getMailConfig: () => ({
      provider: 'qq',
      label: 'QQ 邮箱',
      source: 'mail-qq',
      url: 'https://mail.qq.com',
      navigateOnReuse: false,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret' }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async () => {
      throw new Error('步骤 8：验证码提交后页面进入手机号页面，当前流程无法继续自动授权。 URL: https://auth.openai.com/add-phone');
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await assert.rejects(
    () => executor.executeStep8({
      email: 'user@example.com',
      password: 'secret',
      oauthUrl: 'https://oauth.example/latest',
    }),
    /add-phone/
  );

  assert.equal(calls.rerunStep7, 0);
  assert.ok(!calls.logs.some(({ message }) => /准备从步骤 7 重新开始/.test(message)));
});

test('step 8 checks iCloud session before polling iCloud mailbox', async () => {
  let icloudChecks = 0;
  let resolved = false;

  const executor = api.createStep8Executor({
    addLog: async () => {},
    chrome: {
      tabs: {
        update: async () => {},
      },
    },
    CLOUDFLARE_TEMP_EMAIL_PROVIDER: 'cloudflare-temp-email',
    confirmCustomVerificationStepBypass: async () => {},
    ensureIcloudMailSession: async () => {
      icloudChecks += 1;
    },
    ensureStep8VerificationPageReady: async () => ({ state: 'verification_page', displayedEmail: '' }),
    rerunStep7ForStep8Recovery: async () => {},
    getOAuthFlowRemainingMs: async () => 8000,
    getOAuthFlowStepTimeoutMs: async (defaultTimeoutMs) => Math.min(defaultTimeoutMs, 8000),
    getMailConfig: () => ({
      source: 'icloud-mail',
      url: 'https://www.icloud.com/mail/',
      label: 'iCloud 邮箱',
      navigateOnReuse: true,
    }),
    getState: async () => ({ email: 'user@example.com', password: 'secret' }),
    getTabId: async (sourceName) => (sourceName === 'signup-page' ? 1 : 2),
    HOTMAIL_PROVIDER: 'hotmail-api',
    isTabAlive: async () => true,
    isVerificationMailPollingError: () => false,
    LUCKMAIL_PROVIDER: 'luckmail-api',
    resolveVerificationStep: async () => {
      resolved = true;
    },
    reuseOrCreateTab: async () => {},
    setState: async () => {},
    setStepStatus: async () => {},
    shouldUseCustomRegistrationEmail: () => false,
    STANDARD_MAIL_VERIFICATION_RESEND_INTERVAL_MS: 25000,
    STEP7_MAIL_POLLING_RECOVERY_MAX_ATTEMPTS: 8,
    throwIfStopped: () => {},
  });

  await executor.executeStep8({
    email: 'user@example.com',
    password: 'secret',
    oauthUrl: 'https://oauth.example/latest',
  });

  assert.equal(icloudChecks, 1);
  assert.equal(resolved, true);
});
