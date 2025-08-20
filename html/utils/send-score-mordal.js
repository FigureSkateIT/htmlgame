// utils/send-score-modal.js
let __open = false;

/**
 * 送信確認ポップアップを表示し、ユーザーが決定したプレイヤー名を返す。
 * @param {Object} opts
 * @param {string} opts.gameName   表示用のゲーム名
 * @param {number} opts.score      スコア
 * @param {number} opts.timeMs     経過ミリ秒
 * @param {Date|number|string} opts.timestamp  表示用タイムスタンプ（Date, ms, ISOのいずれか）
 * @param {string} [opts.defaultName] ローカル保存が無い場合の初期値（既定: '匿名ユーザ'）
 * @param {string} [opts.lastSavedName] ローカル保存済みの前回名（あれば優先表示）
 * @returns {Promise<{confirmed:boolean, playerName:string}>}
 */
export function openSendScoreModal(opts) {
  const {
    gameName,
    score,
    timeMs,
    timestamp,
    defaultName = '匿名ユーザ',
    lastSavedName = '',
  } = opts || {};

  return new Promise(async (resolve) => {
    if (__open) return resolve({ confirmed:false, playerName: lastSavedName || defaultName });

    __open = true;
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', inset: '0', zIndex: '99999' });
    const root = host.attachShadow({ mode: 'closed' });
    document.body.appendChild(host);

    const [htmlResp, cssResp] = await Promise.all([
      fetch('/utils/send-score-modal.html', { cache: 'no-cache' }),
      fetch('/utils/send-score-modal.css',  { cache: 'no-cache' }),
    ]);
    const html = await htmlResp.text();
    const css  = await cssResp.text();

    const styleEl = document.createElement('style'); styleEl.textContent = css; root.appendChild(styleEl);
    const wrapHolder = document.createElement('div'); wrapHolder.innerHTML = html; root.appendChild(wrapHolder);

    const wrap      = root.querySelector('.backdrop');
    const elGame    = root.querySelector('.js-gameName');
    const elScore   = root.querySelector('.js-score');
    const elTime    = root.querySelector('.js-time');
    const elTs      = root.querySelector('.js-ts');
    const inputName = root.querySelector('.js-name');
    const btnSend   = root.querySelector('.send');
    const btnCancel = root.querySelector('.cancel');

    // 表示値
    elGame.textContent  = String(gameName ?? '');
    elScore.textContent = String(score ?? 0);
    elTime.textContent  = formatTimeMs(timeMs ?? 0);
    elTs.textContent    = formatTimestamp(timestamp);

    // 名前は「前回名 > defaultName」
    inputName.value = (lastSavedName && lastSavedName.trim()) ? lastSavedName : defaultName;

    const cleanup = (ret) => { __open = false; host.remove(); resolve(ret); };
    const send = () => {
      const name = (inputName.value || '').trim();
      if (!name) { inputName.focus(); return; }
      cleanup({ confirmed: true, playerName: name });
    };

    btnSend.addEventListener('click', send);
    btnCancel.addEventListener('click', () => cleanup({ confirmed:false, playerName: inputName.value || '' }));
    inputName.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
      if (e.key === 'Escape') cleanup({ confirmed:false, playerName: inputName.value || '' });
    });

    setTimeout(() => inputName.focus(), 0);
  });
}

function formatTimeMs(ms) {
  ms = Math.max(0, Number(ms) || 0);
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const x = ms % 1000;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(x).padStart(3,'0')}`;
}
function formatTimestamp(ts) {
  let d;
  if (ts instanceof Date) d = ts;
  else if (typeof ts === 'number') d = new Date(ts);
  else if (typeof ts === 'string') d = new Date(ts);
  else d = new Date();
  // ローカルタイム表示（ISO風）
  const pad = (n, l=2)=>String(n).padStart(l,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}