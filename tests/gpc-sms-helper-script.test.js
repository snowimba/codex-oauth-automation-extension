const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const scriptPath = path.join(process.cwd(), 'scripts/gpc_sms_helper_macos.py');

function runPython(args, options = {}) {
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      ...options,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        ...(options.env || {}),
      },
    });
    if (result.error && result.error.code === 'ENOENT') {
      continue;
    }
    if (process.platform === 'win32' && result.status === 9009) {
      continue;
    }
    return result;
  }
  return null;
}

test('GPC SMS helper shows macOS and iPhone forwarding guidance on non-macOS', () => {
  const help = runPython([scriptPath, '--help']);
  if (!help) {
    return;
  }
  assert.equal(help.status, 0);
  if (process.platform === 'darwin') {
    return;
  }
  const run = runPython([scriptPath, '--db', '/tmp/nonexistent-gpc-chat.db'], {
    timeout: 3000,
  });
  assert.ok(run);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /仅支持 macOS/);
  assert.match(run.stderr, /iPhone 短信已转发|短信转发/);
});

test('GPC SMS helper filters cached OTP records by order timestamp', () => {
  const code = `
import importlib.util
import json

script_path = ${JSON.stringify(scriptPath)}
spec = importlib.util.spec_from_file_location("gpc_sms_helper_macos", script_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

old = {"otp": "111111", "code": "111111", "message_id": "old", "received_at": "2026-05-05T00:00:00+00:00"}
fresh = {"otp": "222222", "code": "222222", "message_id": "fresh", "received_at": "2026-05-05T00:00:10+00:00"}
state = {"last_otp": fresh, "otps": [fresh, old]}
payload = {
    "without_filter": module.select_otp_record(state, 0)["otp"],
    "fresh_only": module.select_otp_record(state, module.parse_timestamp_ms("2026-05-05T00:00:05+00:00"))["otp"],
    "none_after_fresh": module.select_otp_record(state, module.parse_timestamp_ms("2026-05-05T00:00:11+00:00")) is None,
}
print(json.dumps(payload))
`;
  const run = runPython(['-c', code], {
    timeout: 3000,
    env: { GPC_SMS_HELPER_ALLOW_NON_MAC: '1' },
  });
  if (!run) {
    return;
  }
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), {
    without_filter: '222222',
    fresh_only: '222222',
    none_after_fresh: true,
  });
});
