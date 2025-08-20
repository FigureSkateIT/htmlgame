// cf-funcs/get-start.mjs  (CloudFront Functions Runtime 2.0)
import crypto from 'crypto';
import cf from 'cloudfront';

// 設定
const KVS_KEY_CURRENT = 'k_current';
const KVS_KEY_PREV    = 'k_prev';
const MAX_DUR_S       = 1800; // 30分
const VER             = 1;

// ルーティング: /api/get-start/:gid/:uid
function parsePath(path) {
  // 例: /api/get-start/snake/USER-XYZ
  const parts = path.split('/').filter(Boolean);
  if (parts.length >= 4 && parts[0] === 'api' && parts[1] === 'get-start') {
    return { gid: decodeURIComponent(parts[2]), uid: decodeURIComponent(parts[3]) };
  }
  return null;
}

// base64url ユーティリティ
function b64urlFromUtf8(s) {
  return Buffer.from(s, 'utf8').toString('base64url');
}
function b64urlFromJson(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

async function sign(b64payload) {
  const kvs = cf.kvs();
  let key = await kvs.get(KVS_KEY_CURRENT);
  if (!key) key = await kvs.get(KVS_KEY_PREV);
  if (!key) throw new Error('No HMAC key in KVS');

  // HMAC-SHA256 → base64url
  return crypto.createHmac('sha256', key).update(b64payload).digest('base64url');
}

// 乱数っぽいセッションID（短く高速）
function genSessionId(len) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

function jsonResponse(statusCode, bodyObj, extraHeaders) {
  return {
    statusCode,
    statusDescription: statusCode === 200 ? 'OK' : 'ERR',
    headers: Object.assign({
      'content-type':      { value: 'application/json' },
      'cache-control':     { value: 'no-store' },
    }, extraHeaders || {}),
    body: JSON.stringify(bodyObj),
  };
}

export async function handler(event) {
  const req = event.request;
  const path = req.uri || '';

  const params = parsePath(path);
  if (!params) {
    // 他のパスは素通し
    return req;
  }

  const { gid, uid } = params;
  const tStart = new Date().toISOString();
  const sid = genSessionId(24);

  const payload = {
    gid,          // ゲームID（表示用とは別。内部ID）
    uid,          // ユーザID（表示しない）
    t_start: tStart,
    max_dur_s: MAX_DUR_S,
    sid,
    ver: VER,
  };

  try {
    const p64 = b64urlFromJson(payload);
    const mac = await sign(p64);
    const token = `${p64}.${mac}`;

    // Cookie は必要なら（例: 同一端末制御/連携用）。不要なら削除OK。
    const headers = {
      'set-cookie': {
        value: `game_sid=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_DUR_S}`,
      },
    };

    return jsonResponse(200, {
      token_start: token,
      t_start: tStart,
      max_dur_s: MAX_DUR_S,
      sid,
      ver: VER,
      gid,
      uid,
    }, headers);
  } catch (e) {
    // サイン失敗時
    return jsonResponse(500, { error: 'sign_failed' });
  }
}