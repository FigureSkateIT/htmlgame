import StartApi from '/utils/startapi.js';
import { handleGameEnd } from '/utils/game-end-flow.js';

const startApi = new StartApi({ baseUrl: '' });
const gameId   = 'snake';
const period   = '2025-08';

async function onGameStart(){
  await startApi.getStartToken({ gameId });
  // 画面側のボタンは終局時にハンドリングするので、ここでは無効化のままでもOK
}

async function onGameFinished(score, timeMs, win){
  // start セッションが無い/期限切れなら中断
  const st = startApi.getStoredStart(gameId);
  if (!st || startApi.isExpired(gameId)) {
    alert('セッションが期限切れです。もう一度スタートしてください。');
    return;
  }

  // 終了時フロー
  const res = await handleGameEnd({
    gameId, period, score, timeMs, win,
    tokenStart: st.token,
  });

  if (res.status === 'fraud_ng') {
    alert('不正が検知されました（' + (res.message || 'invalid') + '）');
    // 履歴保存なし
    return;
  }

  // 閾値NGでも recent/top10 は更新済み
  if (!res.showSend) {
    // 送信ボタンを非表示/無効化
    document.getElementById('send-score-btn').disabled = true;
    if (res.message) {
      console.log('[get-end] threshold:', res.message);
      // 必要なら UI に表示
    }
    return;
  }

  // 送信ボタン活性化（confirmAndSendScore は既存の scoreapi.js）
  document.getElementById('send-score-btn').disabled = false;
}
