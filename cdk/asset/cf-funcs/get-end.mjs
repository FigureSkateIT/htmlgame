// cf-fns/get-end.mjs  (CloudFront Functions Runtime 2.0, ESM)
import crypto from 'crypto';
import cf from 'cloudfront';

const K_CURRENT = 'k_current';
const K_PREV    = 'k_prev';
const VER       = 1;
// 許容誤差(ms)：例 1500ms = 1.5秒
const ALLOWED_DRIFT_MS = 1500;

/**
 * @typedef {Object} EndFraudResult
 * @property {boolean} valid               // 不正チェックに合格か（トークン検証 & 誤差チェック）
 * @property {string}  [reason]            // 不合格理由（例: 'invalid token_start', 'expired start', 'timer drift too large'）
 * @property {number}  [drift]             // |(t_end - t_start) - timeMs| の実測値（ms）
 * @property {number}  [allowedDriftMs]    // 許容誤差（ms）（参考情報）

 * @typedef {Object} EndThresholdResult
 * @property {boolean} checked             // 閾値チェックを実施したか（= fraud.valid 時のみ true）
 * @property {boolean} [passed]            // 閾値を満たしたか（checked=true のときのみ存在）
 * @property {string}  [reason]            // 閾値NG理由（例: 'score below threshold', 'timeMs above threshold', 'date too early'）

 * @typedef {Object} EndResponseBody
 * @property {boolean} ok                  // 全体合否の要約（fraud.valid && threshold.passed を期待値に、途中で止まった場合は false）
 * @property {number}  ver                 // プロトコルバージョン
 * @property {string}  gid                 // ゲームID（パスから）
 * @property {string}  uid                 // ユーザID（パスから）
 * @property {EndFraudResult} fraud        // 不正チェックの詳細結果
 * @property {EndThresholdResult} threshold// 閾値チェックの詳細結果
 * @property {string}  [token_end]         // 閾値OK時に発行（HMAC署名つき）
 * @property {number}  [t_end]             // サーバ側で観測した終了時刻（ms epoch）
 * @property {string}  [sig_k]             // クライアント署名用の短命キー（base64url）
 * @property {string}  [clear_sig]         // クリア署名（token_start/ token_end/ gid/ uid/ score/ timeMs/ t_end をHMAC）
 */

/** 内部: /api/get-end/:gid/:period/:uid を解析 */
function parsePath(uri) {
  const p = (uri || '').split('/').filter(Boolean);
  if (p.length >= 5 && p[0] === 'api' && p[1] === 'get-end') {
    return { gid: decodeURIComponent(p[2]), period: decodeURIComponent(p[3]), uid: decodeURIComponent(p[4]) };
  }
  return null;
}

const b64url = {
  fromUtf8: (s) => Buffer.from(s, 'utf8').toString('base64url'),
  fromJson: (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url'),
  toUtf8:   (b) => Buffer.from(b, 'base64url').toString('utf8'),
};

async function kvGet(name){ return await cf.kvs().get(name); }
async function getSecret() {
  return (await kvGet(K_CURRENT)) || (await kvGet(K_PREV));
}
async function verifyHmac(b64payload, mac) {
  for (const n of [K_CURRENT, K_PREV]) {
    const key = await kvGet(n);
    if (!key) continue;
    const exp = crypto.createHmac('sha256', key).update(b64payload).digest('base64url');
    if (exp === mac) return true;
  }
  return false;
}

function res200(body /** @type {EndResponseBody} */) {
  return {
    statusCode: 200,
    statusDescription: 'OK',
    headers: {
      'content-type':  { value: 'application/json' },
      'cache-control': { value: 'no-store' },
    },
    body: JSON.stringify(body),
  };
}
function res400(msg) {
  return {
    statusCode: 400,
    statusDescription: msg,
    headers: {
      'content-type':  { value: 'application/json' },
      'cache-control': { value: 'no-store' },
    },
    body: JSON.stringify({ error: msg }),
  };
}

function readNum(obj, key){
  const v = obj?.[key]?.value ?? '';
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : NaN;
}

// KVSの閾値から100位相当のスコアを復元
function extractBottomScore(order, thr) {
  const bottom = {};
  for (let i = 0; i < order.length && i < thr.length; i++) {
    const [field] = order[i];
    if (thr[i][field] !== undefined) {
      bottom[field] = thr[i][field];
    }
  }
  return Object.keys(bottom).length > 0 ? bottom : null;
}

// 新スコアが100位より良いかチェック
function isBetterThanBottom(current, bottom, order) {
  for (const [field, dir] of order) {
    const cv = current[field];
    const bv = bottom[field];
    if (cv === undefined || bv === undefined) continue;
    
    if (field === 'updatedAt') {
      // ISO8601文字列比較
      if (cv !== bv) {
        return dir === 'desc' ? cv > bv : cv < bv;
      }
    } else {
      // 数値比較
      if (cv !== bv) {
        return dir === 'desc' ? cv > bv : cv < bv;
      }
    }
  }
  return true; // 完全同値なら通す
}

export async function handler(event) {
  const req = event.request;
  const path = parsePath(req.uri);
  if (!path) return req; // 対象外パスは素通し

  const { gid, period, uid } = path;
  const qs = req.querystring || {};
  const h  = req.headers || {};

  // 入力取得
  const tokenStart = (qs.token_start?.value) || (h['x-token-start']?.value) || '';
  if (!tokenStart) return res400('missing token_start');

  const score  = Number.isFinite(readNum(h,'x-score'))   ? readNum(h,'x-score')   : readNum(qs,'score');
  const timeMs = Number.isFinite(readNum(h,'x-time-ms')) ? readNum(h,'x-time-ms') : readNum(qs,'timeMs');
  if (!Number.isFinite(score) || !Number.isFinite(timeMs)) return res400('missing score/timeMs');

  /** @type {EndFraudResult} */
  const fraud = { valid: false };
  /** @type {EndThresholdResult} */
  const threshold = { checked: false };

  // === ① 不正チェック（トークン＆期限＆誤差） ===========================================
  // token_start 署名形式
  const sp = tokenStart.split('.');
  if (sp.length !== 2) {
    fraud.valid = false;
    fraud.reason = 'bad token_start';
    return res200({ ok: false, ver: VER, gid, uid, fraud, threshold });
  }
  const [p64s, macs] = sp;

  // HMAC 検証
  if (!(await verifyHmac(p64s, macs))) {
    fraud.valid = false;
    fraud.reason = 'invalid token_start';
    return res200({ ok: false, ver: VER, gid, uid, fraud, threshold });
  }

  // payload 解析
  let s;
  try { s = JSON.parse(b64url.toUtf8(p64s)); }
  catch (err) {
    console.error('Token parsing error:', err);
    fraud.valid = false;
    fraud.reason = 'malformed token_start';
    return res200({ ok: false, ver: VER, gid, uid, fraud, threshold });
  }

  const now = Date.now();
  const tStartStr = s.t_start || '';
  const tStartMs = new Date(tStartStr).getTime();
  const maxDurMs = Number(s.max_dur_s || 0) * 1000;
  if (!tStartStr || !maxDurMs || !Number.isFinite(tStartMs) || now < tStartMs || (now - tStartMs) > maxDurMs) {
    fraud.valid = false;
    fraud.reason = 'expired start';
    return res200({ ok: false, ver: VER, gid, uid, fraud, threshold });
  }

  // t_end と誤差チェック
  const t_end = new Date().toISOString();
  const t_endMs = new Date(t_end).getTime();
  const drift = Math.abs((t_endMs - tStartMs) - timeMs);
  if (!Number.isFinite(drift) || drift > ALLOWED_DRIFT_MS) {
    fraud.valid = false;
    fraud.reason = 'timer drift too large';
    fraud.drift = drift;
    fraud.allowedDriftMs = ALLOWED_DRIFT_MS;
    return res200({ ok: false, ver: VER, gid, uid, fraud, threshold, t_end });
  }

  // ここまで来たら ①OK
  fraud.valid = true;
  fraud.drift = drift;
  fraud.allowedDriftMs = ALLOWED_DRIFT_MS;

  // === ② 閾値チェック（KVS） ==========================================================
  threshold.checked = true;

  // KVSキー新形式: htmlgame-thr#g:<gid>#p:<period> （なければ p:all にフォールバック）
  function thrKey(g, p) { return `htmlgame-thr#g:${g}#p:${p}`; }
  const kvKey = thrKey(gid, period);
  let kvsData = null;
 
  try {
    const raw = await cf.kvs().get(kvKey);
    if (raw) kvsData = JSON.parse(raw);
  } catch (err) {
    console.error(`KVS threshold data error for key ${kvKey}:`, err);
    // Continue with null kvsData (no threshold check)
  }

  if (kvsData?.order && kvsData?.thr) {
    // ゲーム設定に基づく比較（新スコアが100位より良いかチェック）
    const currentScore = { score, timeMs, updatedAt: t_end };
    const bottomScore = extractBottomScore(kvsData.order, kvsData.thr);
    
    if (bottomScore && !isBetterThanBottom(currentScore, bottomScore, kvsData.order)) {
      threshold.passed = false;
      threshold.reason = 'score not good enough for ranking';
      return res200({ ok: false, ver: VER, gid, uid, fraud, threshold, t_end });
    }
  }

  // 閾値がなければ通す / あれば全て通過
  threshold.passed = true;

  // === 署名生成（②までOKのときのみ） ================================================
  const secret = await getSecret();
  if (!secret) {
    threshold.passed = false;
    threshold.reason = 'no secret';
    return res200({ ok: false, ver: VER, gid, uid, fraud, threshold, t_end });
  }

  // token_end
  const endPayload = { gid, uid, sid: s.sid, t_end, ver: VER };
  const p64e = b64url.fromJson(endPayload);
  const endMac    = crypto.createHmac('sha256', secret).update(p64e).digest('base64url');
  const token_end = `${p64e}.${endMac}`;

  // sig_k（短命）
  const sig_k = crypto.createHmac('sha256', secret)
    .update(`${token_end}|${gid}|${uid}`)
    .digest('base64url');

  // clear_sig（score/timeMs を含めてバインド）
  const clear_sig = crypto.createHmac('sha256', secret)
    .update(`${tokenStart}|${token_end}|${gid}|${uid}|${score}|${timeMs}|${t_end}`)
    .digest('base64url');

  // すべてOK
  return res200({
    ok: true,
    ver: VER,
    gid,
    uid,
    fraud,
    threshold,
    token_end,
    t_end,
    sig_k,
    clear_sig,
  });
}