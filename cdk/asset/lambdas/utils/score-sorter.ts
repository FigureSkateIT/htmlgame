// score-sorter.ts
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { GameConfigList, GameConfig, ScoreItem, SortRule } from '../types';

const s3Client = new S3Client({});

// ====== S3 設定キャッシュ（30秒） ===================================================
let configCache: { data: GameConfigList; timestamp: number } | null = null;
const CACHE_TTL_MS = 30 * 1000; // 30秒

/**
 * S3からゲーム設定を読み込む（30秒キャッシュ付き）
 * - 環境変数: S3_BUCKET, GAME_CONFIG_PATH（例: "configs/game-config.json"）
 * - JSON形式: GameConfigList（配列）
 */
export async function loadGameConfig(gameName: string): Promise<GameConfig | null> {
  const now = Date.now();

  if (!configCache || now - configCache.timestamp > CACHE_TTL_MS) {
    const bucket = process.env.S3_BUCKET;
    const key = process.env.GAME_CONFIG_PATH;

    if (!bucket || !key) {
      console.error('Missing required environment variables: S3_BUCKET or GAME_CONFIG_PATH');
      return null;
    }

    try {
      const res = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!res.Body) {
        console.error('Empty response body from S3');
        return null;
      }
      const text = await res.Body.transformToString();
      const list: GameConfigList = JSON.parse(text);
      configCache = { data: list, timestamp: now };
    } catch (err) {
      console.error('Failed to load game config from S3:', err);
      return null;
    }
  }

  return configCache.data.find(c => c.gameName === gameName) || null;
}

// ====== 多段キー comparator 生成（一発ソート用） =====================================

type CompiledRule =
  | { by: 'score' | 'timeMs'; mult: 1 | -1; kind: 'number' }
  | { by: 'updatedAt'; mult: 1 | -1; kind: 'string' };

/** ルールを事前コンパイル（昇順=+1 / 降順=-1、キー型も固定） */
function compileRules(rules: SortRule[]): CompiledRule[] {
  return rules.map(r => ({
    by: r.by,
    mult: r.dir === 'asc' ? 1 : -1,
    kind: r.by === 'updatedAt' ? 'string' : 'number',
  })) as CompiledRule[];
}

/**
 * comparator を生成（GameConfig に従って a,b を比較）
 * - 先に差が出たキーで確定
 * - 完全同値時は userId で安定化
 * - updatedAt は ISO8601 文字列比較（辞書順 = 時系列）
 */
function createComparator(config: GameConfig) {
  const compiled = compileRules(config.sort);

  return (a: ScoreItem, b: ScoreItem): number => {
    for (const r of compiled) {
      if (r.kind === 'number') {
        // score / timeMs
        const va = a[r.by] as number;
        const vb = b[r.by] as number;
        if (va !== vb) return (va > vb ? 1 : -1) * r.mult;
      } else {
        // updatedAt（ISO8601）
        const va = a.updatedAt;
        const vb = b.updatedAt;
        if (va !== vb) return (va > vb ? 1 : -1) * r.mult;
      }
    }
    return a.userId.localeCompare(b.userId);
  };
}

// comparator は gameName + ルール署名でメモ化（軽量最適化）
const comparatorCache = new Map<string, (a: ScoreItem, b: ScoreItem) => number>();
function getComparator(gameName: string, config: GameConfig) {
  const key = `${gameName}|${JSON.stringify(config.sort)}`;
  const cached = comparatorCache.get(key);
  if (cached) return cached;
  const comp = createComparator(config);
  comparatorCache.set(key, comp);
  return comp;
}

// ====== 公開API：ソート & 上位N件抽出 / 1対1優劣判定 ===============================

/**
 * スコア配列を GameConfig の優先順位で一発ソートし、上位N件を返す
 * - 内部で Array.sort(comparator) を1回だけ実行
 */
export async function sortAndTrimScores(
  scoreItems: ScoreItem[],
  gameName: string
): Promise<ScoreItem[]> {
  const config = await loadGameConfig(gameName);
  if (!config) {
    console.error(`Game config not found for: ${gameName}`);
    // フォールバック（最大100件想定）
    return scoreItems.slice(0, 100);
  }
  const comparator = getComparator(gameName, config);
  const sorted = [...scoreItems].sort(comparator);
  return sorted.slice(0, config.topN);
}

/**
 * 新スコアが既存スコアより優秀かどうか（同一プレイヤー更新判定などで使用）
 * - comparator(new, old) < 0 なら new の方が“上位”（優秀）
 */
export async function isBetterScore(
  newer: ScoreItem,
  existing: ScoreItem | null,
  gameName: string
): Promise<boolean> {
  if (!existing) return true;
  const config = await loadGameConfig(gameName);
  if (!config) return true;
  const comparator = getComparator(gameName, config);
  return comparator(newer, existing) < 0;
}
