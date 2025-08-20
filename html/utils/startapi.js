// utils/startapi.js
import { getOrCreateUserId } from './identity.js';

const LS_PREFIX = 'score_session_';

export default class StartApi {
  constructor(cfg = {}) {
    this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, ''); // '' で相対 /api
    this.timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 4000;
    this.retries   = Number.isFinite(cfg.retries)   ? cfg.retries   : 1;
    this.retryBaseDelayMs = 200;
  }

  // ゲーム開始時に呼ぶ
  async getStartToken({ gameId }) {
    if (!gameId) throw new Error('gameId required');
    const uid = getOrCreateUserId();
    const url = `${this.baseUrl}/api/get-start/${encodeURIComponent(gameId)}/${encodeURIComponent(uid)}`;

    const res = await this.#fetchWithRetry(url, { method: 'GET' });
    const text = await res.text();
    if (!res.ok) throw new Error(`get-start failed: ${res.status} ${res.statusText} - ${text}`);
    /** { token_start, t_start, max_dur_s, sid, ver, gid, uid } */
    const data = JSON.parse(text);

    // 保存
    const st = {
      uid: data.uid,
      token: data.token_start,
      tStart: data.t_start, // ISOString
      maxDurS: data.max_dur_s,
      sid: data.sid,
      ver: data.ver,
      savedAt: Date.now(),
    };
    localStorage.setItem(this.#lsKey(gameId), JSON.stringify(st));

    return st;
  }

  // 保存済みを取得（なければ null）
  getStoredStart(gameId) {
    try {
      const raw = localStorage.getItem(this.#lsKey(gameId));
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  // 期限切れか（t_start + max_dur_s）
  isExpired(gameId, skewMs = 0) {
    const st = this.getStoredStart(gameId);
    if (!st) return true;
    const tStartMs = new Date(st.tStart).getTime();
    const expireAt = tStartMs + st.maxDurS * 1000;
    return Date.now() + skewMs > expireAt;
  }

  // クリア・送信前の簡易チェック例
  assertFresh(gameId) {
    if (this.isExpired(gameId, 0)) throw new Error('session expired');
  }

  // ====== internal =======
  #lsKey(gid) { return `${LS_PREFIX}${gid}`; }

  async #fetchWithRetry(url, init) {
    let attempt = 0, lastErr;
    while (attempt <= this.retries) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        clearTimeout(t);
        if (res.status >= 500) {
          lastErr = new Error(`HTTP ${res.status}`);
          await new Promise(r => setTimeout(r, Math.min(this.retryBaseDelayMs * 2 ** attempt, 1500)));
          attempt++; continue;
        }
        return res;
      } catch (e) {
        lastErr = e;
        if (attempt >= this.retries) break;
        await new Promise(r => setTimeout(r, Math.min(this.retryBaseDelayMs * 2 ** attempt, 1500)));
        attempt++;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}