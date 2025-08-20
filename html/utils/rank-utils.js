// utils/rank-utils.js
// @ts-check

/** @typedef {{gameName:string, sort:{by:'score'|'timeMs'|'updatedAt', dir:'asc'|'desc'}[], topN:number}} GameConfig */
/** @typedef {GameConfig[]} GameConfigList */

/** @typedef {{score:number,timeMs:number,win?:boolean,at?:string,updatedAt?:string,userId?:string}} LocalItem */
/** @typedef {{by:'score'|'timeMs'|'updatedAt', mult:1|-1, kind:'number'|'string'}} CompiledRule */

const CONFIG_URL = '/config/game-config.json';

let _cfgCache /** @type {GameConfigList|null} */ = null;
let _cfgAt = 0;
const CFG_TTL_MS = 30_000;

/** 設定を取得（30秒キャッシュ） */
export async function loadGameConfig(gameName){
  const now = Date.now();
  if (!_cfgCache || (now - _cfgAt) > CFG_TTL_MS){
    const res = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error('failed to load game-config.json');
    _cfgCache = /** @type {GameConfigList} */ (await res.json());
    _cfgAt = now;
  }
  return _cfgCache.find(c => c.gameName === gameName) || null;
}

/** ルールをコンパイル */
function compileRules(rules){
  /** @type {CompiledRule[]} */
  const out = [];
  for (const r of rules){
    const by = r.by;
    const kind = (by === 'updatedAt') ? 'string' : 'number';
    out.push({
      by,
      mult: r.dir === 'asc' ? 1 : -1,
      kind
    });
  }
  return out;
}

/** LocalItem を比較用の正規形に（updatedAt を必ず埋める） */
function normalizeLocal(item){
  // ローカルは 'at' を持っているので、なければ updatedAt に転記
  const updatedAt = item.updatedAt || item.at || new Date().toISOString();
  return { ...item, updatedAt };
}

/** GameConfig から comparator を生成 */
export function createComparatorFromConfig(config){
  const compiled = compileRules(config.sort);
  return (aRaw, bRaw) => {
    const a = normalizeLocal(aRaw);
    const b = normalizeLocal(bRaw);
    for (const r of compiled){
      if (r.kind === 'number'){
        const va = /** @type {number} */ (a[r.by]);
        const vb = /** @type {number} */ (b[r.by]);
        if (va !== vb) return (va > vb ? 1 : -1) * r.mult;
      }else{
        const va = /** @type {string} */ (a.updatedAt);
        const vb = /** @type {string} */ (b.updatedAt);
        if (va !== vb) return (va > vb ? 1 : -1) * r.mult;
      }
    }
    // 完全同値のときの安定化（userId があれば利用）
    if (a.userId && b.userId && a.userId !== b.userId){
      return a.userId.localeCompare(b.userId);
    }
    return 0;
  };
}

/** 配列をゲーム別ルールでソートして上位N件を返す */
export async function sortAndTrimLocal(items, gameName, N){
  const cfg = await loadGameConfig(gameName);
  if (!cfg) return items.slice(0, N ?? 10);
  const cmp = createComparatorFromConfig(cfg);
  const sorted = [...items].sort(cmp);
  return sorted.slice(0, N ?? cfg.topN ?? 100);
}

/** 新レコードが “より良い” か（同プレイヤー更新判定等に） */
export async function isBetterLocal(newer, existing, gameName){
  if (!existing) return true;
  const cfg = await loadGameConfig(gameName);
  if (!cfg) return true;
  const cmp = createComparatorFromConfig(cfg);
  return cmp(newer, existing) < 0; // “上位” ほど小さい
}

/**
 * 新レコードを含めたときの “ローカル順位(1始まり)” と “自己ベスト判定” を返す
 * - 完全同値（cmp==0）が複数ある場合は、その中の“最上位インデックス”を順位とする
 */
export async function computeLocalRankAndBest(existingLogs, newRec, gameName){
  const cfg = await loadGameConfig(gameName);
  if (!cfg){
    // フォールバック：従来 snake ルール
    const cmp = (a,b) => (b.score - a.score) || (a.timeMs - b.timeMs) || ((b.at||'').localeCompare(a.at||''));
    const arr = [...existingLogs, newRec].sort(cmp);
    const idx = arr.findIndex(x => x === newRec);
    const rank = (idx >= 0 ? idx+1 : null);
    const best = idx === 0;
    return { rank, isBest: best };
  }
  const cmp = createComparatorFromConfig(cfg);
  const arr = [...existingLogs, newRec].sort(cmp);

  // “完全同値集合”の先頭位置を順位にするため、newRec と同値な最初の位置を探す
  const eq = x => cmp(x, newRec) === 0;
  let idx = arr.findIndex(eq);
  if (idx < 0) idx = arr.indexOf(newRec); // 念のため
  const rank = (idx >= 0 ? idx+1 : null);
  const isBest = idx === 0;
  return { rank, isBest };
}
