// @ts-check
import EndApi from './endapi.js';
import { getOrCreateUserId } from './identity.js';
import {
  addLocalRecord,
  setEndSession
} from './local-store.js';

/**
 * ゲーム終了直後の共通フローを実行し、UI側へ「送信ボタン表示可否」とメッセージを返す。
 * - 不正NG: ローカル保存しない / ボタン非表示
 * - 閾値NG: ローカル保存のみ / ボタン非表示
 * - 両方OK: ローカル保存 + セッション保存 / ボタン表示
 *
 * @typedef {Object} EndFlowResult
 * @property {'fraud_ng'|'threshold_ng'|'ok'} status
 * @property {boolean} showSend
 * @property {string=} [message] // NG時の理由
 * @property {{tokenEnd:string,sigK:string,clearSig?:string}|undefined} [session] // 送信用素材
 */

const endApi = new EndApi({ baseUrl: '' });

/**
 * @param {{gameId:string, period:string, score:number, timeMs:number, win:boolean, tokenStart:string}} p
 * @returns {Promise<EndFlowResult>}
 */
export async function handleGameEnd(p) {
  const uid = getOrCreateUserId();

  // ① CloudFront Functions: get-end
  const end = await endApi.getEnd({
    gameId: p.gameId,
    period: p.period,
    userId: uid,
    score: p.score,
    timeMs: p.timeMs,
    tokenStart: p.tokenStart,
  });

  // ① 不正チェック NG → 保存しない
  if (!end.fraud?.valid) {
    return {
      status: 'fraud_ng',
      showSend: false,
      message: end.fraud?.reason || 'invalid',
    };
  }

  // t_end は既にISOString形式
  const finishedAtISO = end.t_end || new Date().toISOString();

  // ② 閾値チェック NG → 履歴だけ保存
  if (end.threshold?.checked && end.threshold.passed === false) {
    addLocalRecord(p.gameId, { score: p.score, timeMs: p.timeMs, win: p.win, updatedAt: finishedAtISO });
    return {
      status: 'threshold_ng',
      showSend: false,
      message: end.threshold?.reason || 'below threshold',
    };
  }

  // ② OK → 履歴保存 + セッション保存
  addLocalRecord(p.gameId, { score: p.score, timeMs: p.timeMs, win: p.win, updatedAt: finishedAtISO });

  if (end.ok && end.token_end && end.sig_k) {
    setEndSession(p.gameId, {
      tokenEnd: end.token_end,
      tEnd: end.t_end || new Date().toISOString(),
      sigK: end.sig_k,
      clearSig: end.clear_sig,
    });
    return {
      status: 'ok',
      showSend: true,
      session: { tokenEnd: end.token_end, sigK: end.sig_k, clearSig: end.clear_sig },
    };
  }

  // 万一のフォールバック（閾値はOKだが token が来ない）
  return {
    status: 'threshold_ng',
    showSend: false,
    message: 'missing tokens',
  };
}
