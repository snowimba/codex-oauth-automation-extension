// auth-restore-utils.js — 从过期的 Codex 认证文件名解析出账号邮箱，
// 并为“批量恢复过期认证”提供纯函数（不碰 chrome.*，可在 Node 测试里直接 require）。
//
// 背景：VPS 面板在步骤 10 提交回调后，会在服务端生成新的认证文件，
// 文件名是通用的：
//   codex-<email>[-<tag>].json
// 例如：
//   codex-k5k4icd4g7@maoerai.cloud-free.json  -> 邮箱 k5k4icd4g7@maoerai.cloud，tag free
//   codex-user@qq.com.json                    -> 邮箱 user@qq.com，无 tag
//   codex-abc@2925.com-free.json             -> 邮箱 abc@2925.com，tag free
// 注意：文件名里只取名字，不读文件内容 —— 过期的 token 不会离开用户本机。
//
// 恢复本身不是“把旧文件修好”，而是拿文件名里的邮箱 + 该账号的密码，
// 跳过注册（步骤 2-5），只重走登录授权链路：步骤 6 -> 7 -> 8 -> 9 -> 10
// （Ultra6 步骤号：6 清理登录 Cookies、7 刷新 OAuth 并登录、8 获取登录
// 验证码、9 自动确认 OAuth、10 平台回调验证），让 VPS 重新生成一份新的
// 认证文件。密码优先从扩展已保存的 accounts（步骤 3 写下的 { email,
// password }）里找，找不到就用恢复面板里填的通用密码，仍没有就把该账号
// 标为“缺密码”，等用户补填后再跑。登录验证码复用项目原有步骤 8 的逻辑：
// 能推断出收码邮箱的走自动收码；推断不出的（例如 maoerai.cloud 这类自有
// 域名）走 mailProvider='custom'，步骤 8 会弹出原有的手动确认框，等用户
// 在页面里自己填好登录验证码后再点确认。
(function attachAuthRestoreUtils(root, factory) {
  const api = factory();

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.AuthRestoreUtils = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function createAuthRestoreUtils() {
  const EMAIL_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/;

  // 恢复只跑登录授权链路：6 清理登录 Cookies、7 刷新 OAuth 并登录、
  // 8 获取登录验证码、9 自动确认 OAuth、10 平台回调验证。
  const RESTORE_START_STEP = 6;
  const RESTORE_STEP_IDS = [6, 7, 8, 9, 10];

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function basename(fileName) {
    const name = normalizeText(fileName).replace(/\\/g, '/');
    const parts = name.split('/');
    return parts[parts.length - 1] || '';
  }

  // 解析单个过期认证文件名。解析失败返回 { ok: false, fileName, error }。
  function parseAuthFileName(fileName) {
    const base = basename(fileName);
    if (!base) {
      return { ok: false, fileName, error: '文件名为空' };
    }
    if (!/\.json$/i.test(base)) {
      return { ok: false, fileName: base, error: '不是 .json 文件' };
    }
    const stem = base.replace(/\.json$/i, '');
    const withoutPrefix = stem.replace(/^codex-/i, '');
    const match = withoutPrefix.match(EMAIL_RE);
    if (!match) {
      return { ok: false, fileName: base, error: '文件名中找不到合法邮箱' };
    }
    const email = match[0].toLowerCase();
    const rest = withoutPrefix.slice(match.index + match[0].length);
    // 邮箱后面只允许留一个 -tag / _tag 后缀，例如 -free / -plus；
    // 其它残留说明文件名格式不在预期内，直接报错，避免把错邮箱拿去登录。
    let tag = '';
    if (rest) {
      const tagMatch = rest.match(/^[-_]([A-Za-z0-9-]+)$/);
      if (!tagMatch) {
        return { ok: false, fileName: base, error: '邮箱后的后缀无法识别：' + rest };
      }
      tag = tagMatch[1].toLowerCase();
    }
    const at = email.lastIndexOf('@');
    return {
      ok: true,
      fileName: base,
      email,
      tag,
      localPart: email.slice(0, at),
      domain: email.slice(at + 1),
    };
  }

  // 解析一批文件名/邮箱（每行一个，也支持逗号、分号分隔）。
  // 返回 { items: [{ fileName, email, tag, domain, localPart }], skipped: [{ input, reason }] }，
  // 同一邮箱只保留第一次出现的那条。
  function parseAuthFileList(input) {
    const raw = normalizeText(input);
    const items = [];
    const skipped = [];
    const seen = new Set();
    if (!raw) {
      return { items, skipped };
    }
    const entries = raw.split(/[\r\n,;]+/).map((entry) => normalizeText(entry)).filter(Boolean);
    for (const entry of entries) {
      const parsed = parseAuthFileName(entry);
      if (!parsed.ok) {
        skipped.push({ input: entry, reason: parsed.error });
        continue;
      }
      if (seen.has(parsed.email)) {
        skipped.push({ input: entry, reason: '与前面的 ' + parsed.email + ' 重复，已跳过' });
        continue;
      }
      seen.add(parsed.email);
      items.push(parsed);
    }
    return { items, skipped };
  }

  // 按邮箱域名推断步骤 8 收登录验证码用的 mailProvider（Ultra6 的取值）。
  // 返回 { mailProvider, manual }：
  //   mailProvider 为字符串 -> 恢复时把 state.mailProvider 切到它，走原有自动收码；
  //   mailProvider 为 null -> Duck 地址（duck.com 是生成器，验证码到用户已配
  //     好的收信邮箱），保持当前 mailProvider 不动，manual=false；
  //   manual 为 true -> 未知域名（如 maoerai.cloud），mailProvider='custom'，
  //     步骤 8 走原有手动确认流程，等用户在页面里填好验证码再点确认。
  // 注意：2925 的子邮箱形如 <xxx>@<主邮箱前缀>.2925.com 这类派生地址，
  // 这里只按域名 2925.com 兜底，精确的子邮箱归属仍由原有 2925 逻辑处理。
  function inferRestoreMailProvider(email) {
    const domain = normalizeText(email).toLowerCase().split('@')[1] || '';
    if (!domain) {
      return { mailProvider: 'custom', manual: true };
    }
    if (domain === 'qq.com' || domain.endsWith('.qq.com')) {
      return { mailProvider: 'qq', manual: false };
    }
    if (domain === 'vip.163.com' || domain.endsWith('.vip.163.com')) {
      return { mailProvider: '163-vip', manual: false };
    }
    if (domain === '163.com' || domain.endsWith('.163.com')) {
      return { mailProvider: '163', manual: false };
    }
    if (domain === '126.com' || domain.endsWith('.126.com')) {
      return { mailProvider: '126', manual: false };
    }
    if (domain === '2925.com' || domain.endsWith('.2925.com')) {
      return { mailProvider: '2925', manual: false };
    }
    if (domain === 'gmail.com' || domain === 'googlemail.com'
      || domain.endsWith('.gmail.com') || domain.endsWith('.googlemail.com')) {
      return { mailProvider: 'gmail', manual: false };
    }
    if (domain === 'icloud.com' || domain === 'me.com' || domain === 'mac.com'
      || domain.endsWith('.icloud.com') || domain.endsWith('.me.com') || domain.endsWith('.mac.com')) {
      return { mailProvider: 'icloud', manual: false };
    }
    if (domain === 'hotmail.com' || domain === 'outlook.com' || domain === 'live.com' || domain === 'msn.com'
      || domain.endsWith('.hotmail.com') || domain.endsWith('.outlook.com')
      || domain.endsWith('.live.com') || domain.endsWith('.msn.com')) {
      return { mailProvider: 'hotmail-api', manual: false };
    }
    if (domain === 'duck.com' || domain.endsWith('.duck.com')) {
      return { mailProvider: null, manual: false };
    }
    return { mailProvider: 'custom', manual: true };
  }

  // 从已保存账号里找密码（步骤 3 存下的 accounts: [{ email, password }]）。
  function findSavedPassword(accounts, email) {
    const wanted = normalizeText(email).toLowerCase();
    const list = Array.isArray(accounts) ? accounts : [];
    for (const account of list) {
      if (normalizeText(account?.email).toLowerCase() === wanted && account?.password) {
        return account.password;
      }
    }
    return null;
  }

  return {
    RESTORE_START_STEP,
    RESTORE_STEP_IDS,
    parseAuthFileName,
    parseAuthFileList,
    inferRestoreMailProvider,
    findSavedPassword,
  };
});
