// @ts-check
/**
 * ====== Local Storage Schema (v1) ======
 * ルート: key = "score_local_v1"
 * games[gameId]: GameLocalState
 *
 * @typedef {{score:number,timeMs:number,win:boolean,updatedAt:string}} PlayLog
 * @typedef {{score:number,timeMs:number,updatedAt:string}} BestSnap
 * @typedef {{score:number,timeMs:number,player:string,updatedAt:string,period:string}} SubmitSnap
 * @typedef {{score:number,timeMs:number,updatedAt:string,period:string}} ServerBestSnap
 * @typedef {{scoreMin?:number,timeMsMax?:number,minEpoch?:number,updatedAt:string,period:string}} ThresholdSnap
 * @typedef {{tokenStart?:string,tStart?:string,tokenEnd?:string,tEnd?:string,sigK?:string,clearSig?:string,updatedAt?:string}} SessionSnap
 *
 * @typedef {Object} GameLocalState
 * @property {PlayLog[]} recent                // 直近ログ（最大30）
 * @property {PlayLog[]} top10                 // 上位10件（score desc, timeMs asc, at desc）
 * @property {BestSnap|undefined} [localBest]    // 上記の先頭
 * @property {SubmitSnap|undefined} [lastSubmit]
 * @property {ServerBestSnap|undefined} [serverBestCache]
 * @property {ThresholdSnap|undefined} [thresholdCache]
 * @property {string|undefined} [lastPlayerName]
 * @property {SessionSnap|undefined} [session]
 *
 * @typedef {{version:1, games: Record<string, GameLocalState>}} LocalRoot
 */
import { loadGameConfig, createComparatorFromConfig,computeLocalRankAndBest } from './rank-utils.js';
const ROOT_KEY = 'score_local_v1';
const MAX_RECENT = 30;

/** @returns {LocalRoot} */
export function loadRoot() {
  try {
    const raw = localStorage.getItem(ROOT_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      if (obj && obj.version === 1 && obj.games && typeof obj.games === 'object') return obj;
    }
  } catch {}
  return { version: 1, games: {} };
}

/** @param {LocalRoot} root */
export function saveRoot(root) {
  localStorage.setItem(ROOT_KEY, JSON.stringify(root));
}

/** @param {string} gameId @returns {GameLocalState} */
export function getGameState(gameId) {
  const root = loadRoot();
  if (!root.games[gameId]) {
    root.games[gameId] = { recent: [], top10: [] };
    saveRoot(root);
  }
  return root.games[gameId];
}

/** @param {string} gameId @param {GameLocalState} next */
export function setGameState(gameId, next) {
  const root = loadRoot();
  root.games[gameId] = next;
  saveRoot(root);
}

/**
* ゲーム別ルールで Top10 を再計算
* - config の updatedAt はローカルの at をマッピングして比較
* @param {string} gameId
* @param {PlayLog[]} logs
* @returns {Promise<PlayLog[]>}
*/
async function recomputeTop10(gameId, logs) {
  const cfg = await loadGameConfig(gameId);
  if (!cfg){
    // フォールバックは従来通り（snake 互換）
    const sorted = logs.slice().sort((a,b) =>
      (b.score - a.score) || (a.timeMs - b.timeMs) || ((b.updatedAt||'').localeCompare(a.updatedAt||''))
    );
    return sorted.slice(0, 10);
  }
  const cmp = createComparatorFromConfig(cfg);
  // Local PlayLog は { score, timeMs, updatedAt } を持つ → comparator 内で updatedAt=at に正規化
  const sorted = logs.slice().sort(cmp);
  return sorted.slice(0, 10);
}

/**
 * プレイログを1件追加（recentを最大30で維持、top10/localBestを再計算）
 * @param {string} gameId
 * @param {{score:number,timeMs:number,win:boolean,updatedAt?:string}} rec
 */
export function addLocalRecord(gameId, rec) {
  const st = getGameState(gameId);
  const updatedAt = rec.updatedAt ?? new Date().toISOString();
  st.recent.push({ score: rec.score, timeMs: Math.max(0, Math.floor(rec.timeMs||0)), win: !!rec.win, updatedAt });
  // truncate
  if (st.recent.length > MAX_RECENT) st.recent.splice(0, st.recent.length - MAX_RECENT);
    (async () => {
      const top10 = await recomputeTop10(gameId, st.recent);
      st.top10 = top10;
      st.localBest = top10[0] ? { score: top10[0].score, timeMs: top10[0].timeMs, updatedAt: top10[0].updatedAt } : undefined;
      setGameState(gameId, st);
    })();
}

/** @param {string} gameId @param {string} name */
export function setLastPlayerName(gameId, name) {
  const st = getGameState(gameId);
  st.lastPlayerName = String(name || '');
  setGameState(gameId, st);
}

export async function getLocalRankInfo(gameId, newRec){
  const st = getGameState(gameId);
  const logs = st.recent || [];
  const { rank, isBest } = await computeLocalRankAndBest(logs, newRec, gameId);
  return { localRank: rank, isBest };
}

/** @param {string} gameId @param {{score:number,timeMs:number,player:string,period:string}} data */
export function updateLastSubmit(gameId, data) {
  const st = getGameState(gameId);
  st.lastSubmit = { score: data.score, timeMs: data.timeMs, player: data.player, updatedAt: new Date().toISOString(), period: data.period };
  setGameState(gameId, st);
}

/** @param {string} gameId @param {{score:number,timeMs:number,period:string}} best */
export function updateServerBest(gameId, best) {
  const st = getGameState(gameId);
  st.serverBestCache = { score: best.score, timeMs: best.timeMs, updatedAt: new Date().toISOString(), period: best.period };
  setGameState(gameId, st);
}

/** @param {string} gameId @param {ThresholdSnap} thr */
export function updateThresholdCache(gameId, thr) {
  const st = getGameState(gameId);
  st.thresholdCache = { ...thr, updatedAt: new Date().toISOString() };
  setGameState(gameId, st);
}

/** @param {string} gameId @param {{tokenStart:string,tStart:string}} start */
export function setStartSession(gameId, start) {
  const st = getGameState(gameId);
  st.session = { ...(st.session||{}), tokenStart: start.tokenStart, tStart: start.tStart, updatedAt: new Date().toISOString() };
  setGameState(gameId, st);
}

/** @param {string} gameId @param {{tokenEnd:string,tEnd:string,sigK:string,clearSig?:string}} end */
export function setEndSession(gameId, end) {
  const st = getGameState(gameId);
  st.session = { ...(st.session||{}), tokenEnd: end.tokenEnd, tEnd: end.tEnd, sigK: end.sigK, clearSig: end.clearSig, updatedAt: new Date().toISOString() };
  setGameState(gameId, st);
}