// background/auth-restore-runner.js — 批量恢复过期认证的专用链路。
//
// 为什么不复用 runAutoSequenceFromStep：那是给“注册新号”写的自动运行
// 序列，恢复用它有三个实测会踩的坑：
//   1. 步骤 7/8 报错后走 getPostStep6AutoRestartDecision 回到步骤 7 重开，
//      重开次数没有上限——一个坏账号（比如密码错了）会让整批恢复无限
//      空转，只能靠用户点停止；
//   2. 步骤 7 一拿到 OAuth 链接就启动 5 分钟授权链总超时
//      （OAUTH_FLOW_TIMEOUT_MS），手动填验证码的账号（未知域名走 custom
//      时必须等人去邮箱找码再回来确认）很容易超时，超时后整条链作废；
//   3. 序列里混着注册流的重启语义（回到步骤 1 沿用邮箱重开等），恢复
//      不需要、也不应该跑注册步骤。
//
// 所以恢复单独写一条链：只按 6 -> 7 -> 8 -> 9 -> 10 顺序调已有的步骤
// 执行器（清理登录 Cookies、刷新 OAuth 并登录、获取登录验证码、自动
// 确认 OAuth、平台回调验证），页面和面板层面的实现继续复用他这份代码，
// 只把编排改成恢复语义：失败就记失败、不重开；手动填码的账号关掉
// 5 分钟总超时（各步骤自己的等待超时仍然生效）；触发手机号验证的
// 账号直接判失败，不重试。
(function attachAuthRestoreRunner(root, factory) {
  root.MultiPageAuthRestoreRunner = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createAuthRestoreRunnerModule() {
  const RESTORE_CHAIN_STEPS = [6, 7, 8, 9, 10];
  const RESTORE_CHAIN_STEP_TITLES = {
    6: '清理登录 Cookies',
    7: '刷新 OAuth 并登录',
    8: '获取登录验证码',
    9: '自动确认 OAuth',
    10: '平台回调验证',
  };

  function createRestoreChain(deps = {}) {
    const {
      addLog = async () => {},
      broadcastDataUpdate = () => {},
      executeStepAndWait,
      findSavedPassword = () => null,
      getState,
      inferRestoreMailProvider = () => ({ mailProvider: 'custom', manual: true }),
      isStopError = () => false,
      resetState,
      setEmailState,
      setPasswordState,
      setState,
    } = deps;

    function isAddPhoneFailure(error) {
      const message = String(error?.message || error || '');
      return /add-phone|添加手机号|手机号验证|phone number/i.test(message);
    }

    // 跑完一个账号的恢复链，返回 { email, tag, mailProvider, manual, status, reason }。
    // status 为 'success' / 'failed'；只有用户点了停止时才抛错（让外层中断整批）。
    async function runRestoreAccount(account, context = {}) {
      const { commonPassword = '', index = 0, total = 1 } = context;
      const email = String(account?.email || '').trim().toLowerCase();
      const tag = String(account?.tag || '').trim();
      const result = { email, tag, status: 'pending', mailProvider: '', manual: false, reason: '' };

      const currentState = await getState();
      const savedAccounts = Array.isArray(currentState.accounts) ? currentState.accounts : [];
      const password = findSavedPassword(savedAccounts, email) || String(commonPassword || '').trim();
      if (!password) {
        result.status = 'failed';
        result.reason = '缺少密码：扩展未保存该账号密码，且未填写通用密码';
        await addLog(`批量恢复：${email} 缺少密码，已跳过。`, 'error');
        return result;
      }

      const inferred = inferRestoreMailProvider(email) || { mailProvider: 'custom', manual: true };
      result.mailProvider = inferred.mailProvider || String(currentState.mailProvider || '163');
      result.manual = Boolean(inferred.manual);

      // 每轮从干净状态开始：resetState 会保留持久化设置（VPS 地址、
      // 自定义密码、收码邮箱等），这里只把当前账号的邮箱 / 密码 /
      // 收码邮箱写进去，并强制普通模式；同时关掉 5 分钟授权链总超时，
      // 手动填验证码的账号等不起这个倒计时。
      await resetState();
      await setEmailState(email);
      await setPasswordState(password);
      const restoreStateUpdates = {
        plusModeEnabled: false,
        signupMethod: 'email',
        oauthFlowTimeoutEnabled: false,
      };
      if (inferred.mailProvider) {
        restoreStateUpdates.mailProvider = inferred.mailProvider;
      }
      await setState(restoreStateUpdates);
      const nextState = await getState();
      broadcastDataUpdate({ mailProvider: nextState.mailProvider });

      await addLog(
        `批量恢复：第 ${index + 1}/${total} 个账号 ${email}（${result.manual ? '手动填登录验证码' : '收码邮箱：' + result.mailProvider}），开始重走步骤 6-10。`,
        'info'
      );

      try {
        for (const step of RESTORE_CHAIN_STEPS) {
          await addLog(
            `批量恢复：第 ${index + 1}/${total} 个账号 ${email}，步骤 ${step}：${RESTORE_CHAIN_STEP_TITLES[step] || ''}。`,
            'info'
          );
          await executeStepAndWait(step, 2000);
        }
        result.status = 'success';
        await addLog(`批量恢复：第 ${index + 1}/${total} 个账号 ${email} 恢复成功。`, 'ok');
      } catch (err) {
        if (isStopError(err)) {
          throw err;
        }
        result.status = 'failed';
        result.reason = err?.message || String(err || '未知错误');
        if (isAddPhoneFailure(err)) {
          result.reason = '账号触发手机号验证，无法自动恢复：' + result.reason;
        }
        await addLog(`批量恢复：第 ${index + 1}/${total} 个账号 ${email} 失败：${result.reason}`, 'error');
      }
      return result;
    }

    return { runRestoreAccount, RESTORE_CHAIN_STEPS };
  }

  return { createRestoreChain, RESTORE_CHAIN_STEPS };
});
