// shared/auth-restore.js — 从过期的 Codex 认证文件名解析出账号邮箱，
// 并为“批量恢复过期认证”提供纯函数（不碰 chrome.*，可在 Node 测试里直接 require）。
//
// 背景：VPS 面板在步骤 9 提交回调后，会在服务端生成新的认证文件，
// 文件名是通用的：
//   codex-<email>[-<tag>].json
// 例如：
//   codex-k5k4icd4g7@maoerai.cloud-free.json  -> 邮箱 k5k4icd4g7@maoerai.cloud，tag free
//   codex-user@qq.com.json                    -> 邮箱 user@qq.com，无 tag
//   codex-abc@2925.com-free.json             -> 邮箱 abc@2925.com，tag free
// 注意：文件名里只取名字，不读文件内容 —— 过期的 token 不会离开用户本机。
//
// 恢复本身不是“把旧文件修好”，而是拿文件名里的邮箱 + 该账号的密码，
// 跳过注册（步骤 2-5），只重走登录授权链路：步骤 1 -> 6 -> 7 -> 8 -> 9，
// 让 VPS 重新生成一份新的认证文件。密码优先从扩展已保存的 accounts
// （步骤 3 写下的 { email, password }）里找，找不到就用恢复面板里填的
// 通用密码，仍没有就把该账号标为“缺密码”，等用户补填后再跑。
(function attachAuthRestoreHelpers(globalScope) {
  var EMAIL_RE = /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/;

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function basename(fileName) {
    var name = normalizeText(fileName).replace(/\\/g, '/');
    var parts = name.split('/');
    return parts[parts.length - 1] || '';
  }

  // 解析单个过期认证文件名。解析失败返回 null，并给出原因。
  function parseAuthFileName(fileName) {
    var base = basename(fileName);
    if (!base) {
      return { ok: false, fileName: fileName, error: '文件名为空' };
    }
    if (!/\.json$/i.test(base)) {
      return { ok: false, fileName: base, error: '不是 .json 文件' };
    }
    var stem = base.replace(/\.json$/i, '');
    var withoutPrefix = stem.replace(/^codex-/i, '');
    var match = withoutPrefix.match(EMAIL_RE);
    if (!match) {
      return { ok: false, fileName: base, error: '文件名中找不到合法邮箱' };
    }
    var email = match[0].toLowerCase();
    var rest = withoutPrefix.slice(match.index + match[0].length);
    // 邮箱后面只允许留一个 -tag / _tag 后缀，例如 -free / -plus；
    // 其它残留说明文件名格式不在预期内，直接报错，避免把错邮箱拿去登录。
    var tag = '';
    if (rest) {
      var tagMatch = rest.match(/^[-_]([A-Za-z0-9-]+)$/);
      if (!tagMatch) {
        return { ok: false, fileName: base, error: '邮箱后的后缀无法识别：' + rest };
      }
      tag = tagMatch[1].toLowerCase();
    }
    var at = email.lastIndexOf('@');
    return {
      ok: true,
      fileName: base,
      email: email,
      tag: tag,
      localPart: email.slice(0, at),
      domain: email.slice(at + 1),
    };
  }

  // 解析一批文件名/邮箱（每行一个，也支持逗号、分号分隔）。
  // 返回 { items: [{ fileName, email, tag, domain, localPart }], skipped: [{ input, reason }] }，
  // 同一邮箱只保留第一次出现的那条。
  function parseAuthFileList(input) {
    var raw = normalizeText(input);
    var items = [];
    var skipped = [];
    var seen = new Set();
    if (!raw) {
      return { items: items, skipped: skipped };
    }
    var entries = raw.split(/[\r\n,;]+/).map(function (entry) { return normalizeText(entry); }).filter(Boolean);
    for (var i = 0; i < entries.length; i++) {
      var parsed = parseAuthFileName(entries[i]);
      if (!parsed.ok) {
        skipped.push({ input: entries[i], reason: parsed.error });
        continue;
      }
      if (seen.has(parsed.email)) {
        skipped.push({ input: entries[i], reason: '与前面的 ' + parsed.email + ' 重复，已跳过' });
        continue;
      }
      seen.add(parsed.email);
      items.push(parsed);
    }
    return { items: items, skipped: skipped };
  }

  // 按邮箱域名推断步骤 7 收登录验证码用的 provider。
  // 能推断的走自动收码；推断不出的（例如 maoerai.cloud 这类自有域名）
  // 返回 null，恢复流程会切到手动模式，等用户自己填登录验证码。
  // 注意：2925 的子邮箱形如 <xxx>@<主邮箱前缀>.2925.com 这类派生地址，
  // 这里只按域名 2925.com 兜底，精确的子邮箱归属仍由原有 2925 逻辑处理。
  function inferRestoreProvider(email) {
    var domain = normalizeText(email).toLowerCase().split('@')[1] || '';
    if (!domain) {
      return null;
    }
    if (domain === 'qq.com' || domain.endsWith('.qq.com')) {
      return 'qq_mail';
    }
    if (domain === '163.com' || domain === '126.com' || domain.endsWith('.163.com') || domain.endsWith('.126.com')) {
      return 'mail_163';
    }
    if (domain === '2925.com' || domain.endsWith('.2925.com')) {
      return 'mail_2925';
    }
    if (domain === 'duck.com' || domain.endsWith('.duck.com')) {
      return 'burner_mailbox';
    }
    return null;
  }

  // 从已保存账号里找密码（步骤 3 存下的 accounts: [{ email, password }]）。
  function findSavedPassword(accounts, email) {
    var wanted = normalizeText(email).toLowerCase();
    var list = Array.isArray(accounts) ? accounts : [];
    for (var i = 0; i < list.length; i++) {
      var account = list[i] || {};
      if (normalizeText(account.email).toLowerCase() === wanted && account.password) {
        return account.password;
      }
    }
    return null;
  }

  var api = {
    parseAuthFileName: parseAuthFileName,
    parseAuthFileList: parseAuthFileList,
    inferRestoreProvider: inferRestoreProvider,
    findSavedPassword: findSavedPassword,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.AuthRestore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
