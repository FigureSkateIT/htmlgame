/*
④ スコア送信の事前チェック CloudFront Functions（/api/score/...）
受け取る: ヘッダ x-token-start, x-token-end, x-player, x-score, x-time-ms, x-day, x-sig
検証:
token_start / token_end の HMAC と SID/時間の一貫性
sig_k' = HMAC(secret, token_end + '|' + gid + '|' + uid) を生成
expectedSig = HMAC(sig_k', "${player}|${score}|${timeMs}|${day}") と x-sig の一致
KVS の閾値（score/time/date）はgetendでチェック済みのためスキップ
合格時: x-edge-auth を追加 → オリジンへ
*/

// cf-fns/validate.mjs  (CloudFront Functions Runtime 2.0)
import crypto from 'crypto';
import cf from 'cloudfront';

const K_CURRENT = 'k_current';
const K_PREV    = 'k_prev';
const EDGE_AUTH_HEADER_NAME  = 'x-edge-auth';
const EDGE_AUTH_HEADER_VALUE = 'valid-edge-request';

async function getSecret() {
  const kvs = cf.kvs();
  return (await kvs.get('k_current')) || (await kvs.get('k_prev'));
}

function parsePath(uri) {
  // /api/score/:gid/:period/:uid
  const p = uri.split('/').filter(Boolean);
  if (p.length >= 5 && p[0] === 'api' && p[1] === 'score') {
    return { gid: decodeURIComponent(p[2]), period: decodeURIComponent(p[3]), uid: decodeURIComponent(p[4]) };
  }
  return null;
}
const b64url = {
  toUtf8: (s) => Buffer.from(s, 'base64url').toString('utf8'),
};
async function verifyHmac(b64payload, mac) {
  for (const k of [K_CURRENT, K_PREV]) {
    const key = await cf.kvs().get(k);
    if (!key) continue;
    const expect = crypto.createHmac('sha256', key).update(b64payload).digest('base64url');
    if (expect === mac) return true;
  }
  return false;
}
async function deriveSigK(token_end, gid, uid) {
  const key = await getSecret();
  if (!key) return null;
  return crypto.createHmac('sha256', key)
    .update(`${token_end}|${gid}|${uid}`)
    .digest('base64url');
}
function jsonErr(code, msg) {
  return {
    statusCode: code,
    statusDescription: msg,
    headers: { 'content-type': { value: 'application/json' }, 'cache-control': { value: 'no-store' } },
    body: JSON.stringify({ error: msg }),
  };
}

export async function handler(event) {
  const req = event.request;
  const path = parsePath(req.uri || '');
  if (!path) return req;

  const h = req.headers || {};
  const tokenStart = h['x-token-start']?.value || '';
  const tokenEnd   = h['x-token-end']?.value   || '';
  const player     = h['x-player']?.value      || '';
  const scoreStr   = h['x-score']?.value       || '';
  const timeMsStr  = h['x-time-ms']?.value     || '';
  const updatedAt  = h['x-updated-at']?.value  || '';
  const sig        = h['x-sig']?.value         || '';
  const clearSig   = h['x-clear-sig']?.value   || '';

if (!tokenStart || !tokenEnd || !player || !scoreStr || !timeMsStr || !updatedAt || !sig) {
    return jsonErr(400, 'missing headers');
  }
  const score  = parseInt(scoreStr, 10);
  const timeMs = parseInt(timeMsStr, 10);
  if (!Number.isFinite(score) || !Number.isFinite(timeMs)) return jsonErr(400, 'bad score/time');


  // Validate token_start
  const ps = tokenStart.split('.');
  if (ps.length !== 2) return jsonErr(400, 'bad token_start');
  if (!(await verifyHmac(ps[0], ps[1]))) return jsonErr(403, 'invalid token_start');
  let start;
  try { start = JSON.parse(b64url.toUtf8(ps[0])); } catch { return jsonErr(400, 'bad start payload'); }

  // Validate token_end
  const pe = tokenEnd.split('.');
  if (pe.length !== 2) return jsonErr(400, 'bad token_end');
  if (!(await verifyHmac(pe[0], pe[1]))) return jsonErr(403, 'invalid token_end');
  let end;
  try { end = JSON.parse(b64url.toUtf8(pe[0])); } catch { return jsonErr(400, 'bad end payload'); }

  // Parity checks
  if (start.gid !== path.gid || end.gid !== path.gid) return jsonErr(400, 'gid mismatch');
  if (start.uid !== path.uid || end.uid !== path.uid) return jsonErr(400, 'uid mismatch');
  if (start.sid !== end.sid) return jsonErr(400, 'sid mismatch');



  const now = Date.now();
  const tStartMs = new Date(start.t_start || '').getTime();
  const tEndMs = new Date(end.t_end || '').getTime();
  const maxDurMs = Number(start.max_dur_s || 0) * 1000;
  const updatedAtServer = end.t_end || '';
  // x-updated-at と t_end(ISO8601, UTC) の一致検証（新）
  if (updatedAt !== updatedAtServer) {
    return jsonErr(400, 'updatedAt mismatch');
  }
  if (!tStartMs || !tEndMs || tEndMs <= tStartMs || (tEndMs - tStartMs) > maxDurMs) {
    return jsonErr(403, 'invalid duration');
  }
  // 提出猶予（例：300秒以内）
  if (now - tEndMs > 300000) return jsonErr(403, 'submission timeout');


    // ---- clear_sig 検証（ある場合は強い保証）----
  if (clearSig) {
    const secret = await getSecret();
    if (!secret) return jsonErr(500, 'no secret');

    const calc = crypto.createHmac('sha256', secret)
      .update(`${tokenStart}|${tokenEnd}|${path.gid}|${path.uid}|${score}|${timeMs}|${end.t_end}`)
      .digest('base64url');

    if (calc !== clearSig) return jsonErr(403, 'invalid clear_sig');
  }

  // Re-derive client seed and verify x-sig
  const sigK = await deriveSigK(tokenEnd, path.gid, path.uid);
  if (!sigK) return jsonErr(500, 'no secret');
  const msg = `${player}|${score}|${timeMs}|${updatedAtServer}`;
  const expected = crypto.createHmac('sha256', sigK).update(msg).digest('base64url');
  if (expected !== sig) return jsonErr(403, 'invalid score sig');

  // KVS threshold check (optional簡略; 実装済みなら差し替え)
  // ここでは通過させ、オリジン側で最終確定でもOK 
  // 
  
  // クライアントが同名ヘッダを付けても常に上書き
  req.headers[EDGE_AUTH_HEADER_NAME] = { value: EDGE_AUTH_HEADER_VALUE };
  return req;
}