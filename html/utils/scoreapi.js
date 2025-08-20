// utils/scoreapi.js  強化版
import { getOrCreateUserId } from './identity.js';
import { openSendScoreModal } from './send-score-modal.js';

const LS_LAST_PLAYER_NAME = 'score_last_player_name';
const LS_SESSION_PREFIX   = 'score_session_'; // startapi が保存 (tokenStart等)
const LS_END_PREFIX       = 'score_end_';     // endapi が保存 (tokenEnd, sigK等)

async function hmacBase64Url(keyStr, msg) {
  // keyStr/sigK は base64url
  const rawKey = Uint8Array.from(atob(keyStr.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', rawKey, { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return b64;
}

export default class ScoreApi {
  constructor(cfg = {}) {
    this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    this.edgeAuthHeaderName = cfg.edgeAuthHeaderName;
    this.edgeAuthToken = cfg.edgeAuthToken;
    this.timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 5000;
    this.retries = Number.isFinite(cfg.retries) ? cfg.retries : 2;
    this.retryBaseDelayMs = Number.isFinite(cfg.retryBaseDelayMs) ? cfg.retryBaseDelayMs : 250;
  }

  async putScore({ gameId, period, userId, score, player, timeMs, extraHeaders }) {
    const url = `${this.baseUrl}/api/score/${encodeURIComponent(gameId)}/${encodeURIComponent(period)}/${encodeURIComponent(userId)}`;
    const headers = {
      'x-score': String(score),
      'x-player': String(player),
      'x-time-ms': String(timeMs),
      ...(extraHeaders || {}),
      ...(this.edgeAuthHeaderName && this.edgeAuthToken ? { [this.edgeAuthHeaderName]: this.edgeAuthToken } : {}),
    };
    const res = await this.#fetchWithRetry(url, { method: 'POST', headers });
    const text = await res.text();
    if (!res.ok) throw new Error(`putScore failed: ${res.status} ${res.statusText} - ${text}`);
    return JSON.parse(text);
  }

  // 送信前に確認ポップアップ + 事前署名ヘッダ付与
  async confirmAndSendScore({ gameId, period, score, timeMs, gameNameForDisplay }) {
    if (!gameId || !period) throw new Error('Missing gameId/period');
    if (!Number.isFinite(score) || !Number.isFinite(timeMs)) throw new Error('Invalid score/timeMs');

    const userId = getOrCreateUserId();
    const lastName = localStorage.getItem(LS_LAST_PLAYER_NAME) || '';
    const ts = new Date();

    // モーダル
    const { confirmed, playerName } = await openSendScoreModal({
      gameName: gameNameForDisplay ?? gameId,
      score, timeMs, timestamp: ts,
      lastSavedName: lastName,
      defaultName: '匿名ユーザ',
    });
    if (!confirmed) return { accepted:false, canceled:true };

    // 保存
    localStorage.setItem(LS_LAST_PLAYER_NAME, playerName);

    // Start/End 保存値を取得
    const sess = JSON.parse(localStorage.getItem(LS_SESSION_PREFIX + gameId) || 'null');
    const end  = JSON.parse(localStorage.getItem(LS_END_PREFIX + gameId)     || 'null');
    if (!sess?.token || !end?.tokenEnd || !end?.sigK) {
    throw new Error('missing start/end token; call getStartToken & getEndToken first');
    }

   // t_end(ISOString) を updatedAt として採用
    const tEndStr = end.t_end || '';
    if (!tEndStr) {
      throw new Error('invalid t_end; missing in end token payload');
    }
    const updatedAt = tEndStr; // 既にISOString形式
    // x-sig = HMAC(sigK, `${player}|${score}|${timeMs}|${updatedAt}`)
    const msg = `${playerName}|${score}|${timeMs}|${updatedAt}`;
    const xSig = await hmacBase64Url(end.sigK, msg);

    const extra = {
    'x-token-start': sess.token,
    'x-token-end':   end.tokenEnd,
    'x-updated-at':  updatedAt,
    'x-sig':         xSig,
    // ← クリア時に作られた署名（存在すれば送る）
    ...(end.clearSig ? { 'x-clear-sig': end.clearSig } : {}),
    };
    return this.putScore({ gameId, period, userId, score, player: playerName, timeMs, extraHeaders: extra });
}

  async getRanking({ gameId, period, limit }) {
    const url = new URL(`${this.baseUrl}/api/ranking/${encodeURIComponent(gameId)}/${encodeURIComponent(period)}`);
    if (Number.isFinite(limit)) url.searchParams.set('limit', String(limit));
    const res = await this.#fetchWithRetry(url.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`getRanking failed: ${res.status} ${res.statusText} - ${text}`);
    return JSON.parse(text);
  }

  async #fetchWithRetry(url, init) {
    let attempt = 0, lastErr;
    while (attempt <= this.retries) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), this.timeoutMs);
        const res = await fetch(url, { ...init, signal: controller.signal });
        clearTimeout(t);
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          await this.#sleep(Math.min(this.retryBaseDelayMs * 2 ** attempt, 3000));
          attempt++; continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt >= this.retries) break;
        await this.#sleep(Math.min(this.retryBaseDelayMs * 2 ** attempt, 3000));
        attempt++;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  #sleep(ms){return new Promise(r=>setTimeout(r,ms));}
}