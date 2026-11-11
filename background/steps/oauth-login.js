(function attachBackgroundStep7(root, factory) {
  root.MultiPageBackgroundStep7 = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundStep7Module() {
  // 恢复模式用的登录链接处理：步骤 6 虽然清了已知域名下的 cookies，
  // 但浏览器会话仍可能残留（比如其他标签页重新建立了会话），导致
  // 步骤 7 打开 OAuth 链接后直接进入同意页，跳过邮箱 + 验证码登录。
  // 恢复必须以当前账号自己的身份登录，所以在链接上追加 prompt=login
  // 强制 Auth0 重新登录；链接已带 prompt 时不动它，由调用处的守卫
  // 在仍直接进入同意页时报错，而不是悄悄替别的账号点同意。
  function buildRestoreLoginUrl(oauthUrl, forceLogin) {
    if (!forceLogin) {
      return { url: oauthUrl, forced: false, alreadyHasPrompt: false, prompt: '' };
    }
    try {
      const urlObject = new URL(oauthUrl);
      if (urlObject.searchParams.has('prompt')) {
        return {
          url: oauthUrl,
          forced: false,
          alreadyHasPrompt: true,
          prompt: urlObject.searchParams.get('prompt') || '',
        };
      }
      urlObject.searchParams.set('prompt', 'login');
      return { url: urlObject.toString(), forced: true, alreadyHasPrompt: false, prompt: 'login' };
    } catch {
      return { url: oauthUrl, forced: false, alreadyHasPrompt: false, prompt: '' };
    }
  }

  function createStep7Executor(deps = {}) {
    const {
      addLog,
      completeStepFromBackground,
      getErrorMessage,
      getLoginAuthStateLabel,
      getOAuthFlowStepTimeoutMs,
      getState,
      isAddPhoneAuthFailure = (error) => {
        const message = String(typeof error === 'string' ? error : error?.message || '');
        if (/\u624b\u673a\u53f7\u8f93\u5165\u6a21\u5f0f|phone\s+entry/i.test(message)) {
          return false;
        }
        return /https:\/\/auth\.openai\.com\/add-phone(?:[/?#]|$)|\badd-phone\b|\u6dfb\u52a0\u624b\u673a\u53f7|\u624b\u673a\u53f7\u7801|\u8fdb\u5165\u624b\u673a\u53f7\u9875\u9762|\u624b\u673a\u53f7\u9875|\u624b\u673a\u53f7\u9875\u9762|phone\s+number|telephone/i.test(message);
      },
      isStep6RecoverableResult,
      isStep6SuccessResult,
      refreshOAuthUrlBeforeStep6,
      reuseOrCreateTab,
      sendToContentScriptResilient,
      startOAuthFlowTimeoutWindow,
      STEP6_MAX_ATTEMPTS,
      throwIfStopped,
    } = deps;

    function isManagementSecretConfigError(error) {
      const message = String(typeof error === 'string' ? error : error?.message || '').trim();
      if (!message) {
        return false;
      }

      const mentionsSecret = /管理密钥|Admin Secret|X-Admin-Key|CPA Key/i.test(message);
      if (!mentionsSecret) {
        return false;
      }

      return /缺少|未配置|请输入|无效|错误|失败|401|认证失败|未授权|unauthorized|invalid/i.test(message);
    }

    async function executeStep7(state) {
      const visibleStep = Math.floor(Number(state?.visibleStep) || 0);
      const completionStep = visibleStep > 0 ? visibleStep : 7;
      const resolvedIdentifierType = String(
        state?.accountIdentifierType
        || (state?.signupPhoneNumber ? 'phone' : '')
        || ''
      ).trim().toLowerCase() === 'phone'
        ? 'phone'
        : 'email';
      const phoneNumber = String(
        state?.signupPhoneNumber
        || (resolvedIdentifierType === 'phone' ? state?.accountIdentifier : '')
        || state?.signupPhoneCompletedActivation?.phoneNumber
        || state?.signupPhoneActivation?.phoneNumber
        || ''
      ).trim();
      const email = String(
        state?.email
        || (resolvedIdentifierType === 'email' ? state?.accountIdentifier : '')
        || ''
      ).trim();
      if (!email && !phoneNumber) {
        throw new Error('缺少登录账号：请先完成步骤 2，或在侧栏“注册邮箱/注册手机号”中手动填写账号后再执行当前步骤。');
      }

      let attempt = 0;
      let lastError = null;

      while (attempt < STEP6_MAX_ATTEMPTS) {
        throwIfStopped();
        attempt += 1;
        try {
          const currentState = attempt === 1 ? state : await getState();
          const password = currentState.password || currentState.customPassword || '';
          const currentIdentifierType = String(
            currentState?.accountIdentifierType
            || (currentState?.signupPhoneNumber ? 'phone' : '')
            || resolvedIdentifierType
          ).trim().toLowerCase() === 'phone'
            ? 'phone'
            : 'email';
          const currentPhoneNumber = String(
            currentState?.signupPhoneNumber
            || (currentIdentifierType === 'phone' ? currentState?.accountIdentifier : '')
            || currentState?.signupPhoneCompletedActivation?.phoneNumber
            || currentState?.signupPhoneActivation?.phoneNumber
            || phoneNumber
          ).trim();
          const currentEmail = String(
            currentState?.email
            || (currentIdentifierType === 'email' ? currentState?.accountIdentifier : '')
            || email
          ).trim();
          const accountIdentifier = currentIdentifierType === 'phone'
            ? currentPhoneNumber
            : currentEmail;
          const oauthUrl = await refreshOAuthUrlBeforeStep6(currentState);
          const loginUrlResult = buildRestoreLoginUrl(oauthUrl, Boolean(currentState.restoreForceLogin));
          const loginUrl = loginUrlResult.url;
          if (loginUrlResult.forced) {
            await addLog('恢复模式：强制重新登录（prompt=login），不沿用浏览器已有会话。', 'info', {
              step: completionStep,
              stepKey: 'oauth-login',
            });
          } else if (loginUrlResult.alreadyHasPrompt) {
            await addLog(`恢复模式：OAuth 链接已带 prompt=${loginUrlResult.prompt}，不再追加强制登录参数。`, 'warn', {
              step: completionStep,
              stepKey: 'oauth-login',
            });
          }
          if (typeof startOAuthFlowTimeoutWindow === 'function') {
            await startOAuthFlowTimeoutWindow({ step: completionStep, oauthUrl });
          }
          const loginTimeoutMs = typeof getOAuthFlowStepTimeoutMs === 'function'
            ? await getOAuthFlowStepTimeoutMs(180000, {
              step: completionStep,
              actionLabel: 'OAuth 登录并进入验证码页',
              oauthUrl,
            })
            : 180000;

          if (attempt === 1) {
            await addLog('正在打开最新 OAuth 链接并登录...', 'info', {
              step: completionStep,
              stepKey: 'oauth-login',
            });
          } else {
            await addLog(`上一轮失败后，正在进行第 ${attempt} 次尝试（最多 ${STEP6_MAX_ATTEMPTS} 次）...`, 'warn', {
              step: completionStep,
              stepKey: 'oauth-login',
            });
          }

          await reuseOrCreateTab('signup-page', loginUrl, { forceNew: true });

          const result = await sendToContentScriptResilient(
            'signup-page',
            {
              type: 'EXECUTE_STEP',
              step: 7,
              source: 'background',
              payload: {
                email: currentEmail,
                phoneNumber: currentPhoneNumber,
                countryId: currentState?.signupPhoneCompletedActivation?.countryId
                  ?? currentState?.signupPhoneActivation?.countryId
                  ?? null,
                countryLabel: String(
                  currentState?.signupPhoneCompletedActivation?.countryLabel
                  || currentState?.signupPhoneActivation?.countryLabel
                  || ''
                ).trim(),
                accountIdentifier,
                loginIdentifierType: currentIdentifierType,
                password,
                visibleStep: completionStep,
              },
            },
            {
              timeoutMs: loginTimeoutMs,
              responseTimeoutMs: loginTimeoutMs,
              retryDelayMs: 700,
              logMessage: '认证页正在切换，等待页面重新就绪后继续登录...',
              logStep: completionStep,
              logStepKey: 'oauth-login',
            }
          );

          if (result?.error) {
            throw new Error(result.error);
          }

          if (isStep6SuccessResult(result)) {
            // 恢复模式下直接进入同意页等于没用当前账号登录：宁可报错，
            // 也不能悄悄替浏览器里已登录的那个账号点同意。
            if (currentState.restoreForceLogin && result.directOAuthConsentPage) {
              throw new Error('恢复模式已强制重新登录，但认证页仍直接进入了同意页（浏览器会话未被清除）。请先退出当前 ChatGPT 登录，或换一个干净的浏览器会话后重试。');
            }
            const completionPayload = {
              loginVerificationRequestedAt: result.loginVerificationRequestedAt || null,
            };
            if (Object.prototype.hasOwnProperty.call(result || {}, 'skipLoginVerificationStep')) {
              completionPayload.skipLoginVerificationStep = Boolean(result.skipLoginVerificationStep);
            }
            if (Object.prototype.hasOwnProperty.call(result || {}, 'directOAuthConsentPage')) {
              completionPayload.directOAuthConsentPage = Boolean(result.directOAuthConsentPage);
            }

            await completeStepFromBackground(completionStep, completionPayload);
            return;
          }

          if (isStep6RecoverableResult(result)) {
            const reasonMessage = result.message
              || `当前停留在${getLoginAuthStateLabel(result.state)}，准备重新执行步骤 ${completionStep}。`;
            throw new Error(reasonMessage);
          }

          throw new Error(`步骤 ${completionStep}：认证页未返回可识别的登录结果。`);
        } catch (err) {
          throwIfStopped(err);
          if (isAddPhoneAuthFailure(err)) {
            throw err;
          }
          if (isManagementSecretConfigError(err)) {
            await addLog(
              `检测到来源后台管理密钥缺失或错误，不再重试，当前流程停止。原因：${getErrorMessage(err)}`,
              'error',
              { step: completionStep, stepKey: 'oauth-login' }
            );
            throw err;
          }
          lastError = err;
          if (attempt >= STEP6_MAX_ATTEMPTS) {
            break;
          }

          await addLog(`第 ${attempt} 次尝试失败，原因：${getErrorMessage(err)}；准备重试...`, 'warn', {
            step: completionStep,
            stepKey: 'oauth-login',
          });
        }
      }

      throw new Error(`步骤 ${completionStep}：判断失败后已重试 ${STEP6_MAX_ATTEMPTS - 1} 次，仍未成功。最后原因：${getErrorMessage(lastError)}`);
    }

    return { executeStep7 };
  }

  return { createStep7Executor, buildRestoreLoginUrl };
});
