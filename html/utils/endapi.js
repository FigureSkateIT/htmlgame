// @ts-check
/**
 * CloudFront Functions /api/get-end のレスポンス型
 * @typedef {Object} EndFraudResult
 * @property {boolean} valid
 * @property {string=} reason
 * @property {number=} drift
 * @property {number=} allowedDriftMs
 *
 * @typedef {Object} EndThresholdResult
 * @property {boolean} checked
 * @property {boolean=} passed
 * @property {string=} reason
 *
 * @typedef {Object} EndResponseBody
 * @property {boolean} ok
 * @property {number}  ver
 * @property {string}  gid
 * @property {string}  uid
 * @property {EndFraudResult} fraud
 * @property {EndThresholdResult} threshold
 * @property {string=} token_end
 * @property {string=} t_end
 * @property {string=} sig_k
 * @property {string=} clear_sig
 */

export default class EndApi {
  constructor(cfg = {}) {
    this.baseUrl = (cfg.baseUrl || '').replace(/\/+$/, '');
    this.timeoutMs = Number.isFinite(cfg.timeoutMs) ? cfg.timeoutMs : 4000;
    this.retries   = Number.isFinite(cfg.retries)   ? cfg.retries   : 1;
    this.retryBaseDelayMs = 200;
  }

  /**
   * ゲーム終了時に呼び出し
   * @param {{gameId:string, period:string, userId:string, score:number, timeMs:number, tokenStart:string}} p
   * @returns {Promise<EndResponseBody>}
   */
  async getEnd(p) {
    const url = new URL(`${this.baseUrl}/api/get-end/${encodeURIComponent(p.gameId)}/${encodeURIComponent(p.period)}/${encodeURIComponent(p.userId)}`, location.origin);
    url.searchParams.set('token_start', p.tokenStart);
    url.searchParams.set('score', String(p.score));
    url.searchParams.set('timeMs', String(p.timeMs));

    const res = await this.#fetchWithRetry(url.toString(), { method: 'GET', headers: { accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) throw new Error(`get-end failed: ${res.status} ${res.statusText} - ${text}`);
    /** @type {EndResponseBody} */
    const data = JSON.parse(text);
    return data;
  }

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
