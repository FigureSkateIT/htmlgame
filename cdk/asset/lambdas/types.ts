export interface SortRule {
  by: 'score' | 'timeMs' | 'updatedAt';
  dir: 'asc' | 'desc';
}

export interface GameConfig {
  gameName: string;
  sort: SortRule[];
  topN: number;
}

export type GameConfigList = GameConfig[];

/**
 * DynamoDBのスコアアイテムの型定義
 */
export interface ScoreItem {
  userId: string;
  userName: string;
  score: number;
  timeMs: number;
  updatedAt: string;
  meta?: Record<string, unknown>;
}

// ===== API DTO: get-ranking =====
export interface GetRankingPathParams {
  gameId: string;
  period: string;
}
export interface GetRankingQuery {
  limit?: number; // ?limit=
}
export interface RankingEntry {
  rank: number;
  userId: string;
  userName: string;
  score: number;
  timeMs: number;
  updatedAt: string; // ISO8601
}
export interface GetRankingResponse {
  items: RankingEntry[];
  topN: number; // 応答で実際に返した上限
  totalCandidates: number; // PK配下の総件数
  updatedAt: string; // ISO8601（レスポンス生成時刻）
}

// ===== API DTO: put-score =====
export interface PutScorePathParams {
  gameId: string;
  period: string;
  userId: string;
}
export interface PutScoreHeaders {
  'x-score': string; // 数値文字列
  'x-player': string; // 表示名
  'x-time-ms': string; // 数値文字列
  // 認証ヘッダは環境変数名次第なので明示しない（EDGE_AUTH_HEADER）
}
export interface PutScoreSnapshot {
  score: number;
  timeMs: number;
  updatedAt: string; // ISO8601
}
export interface PutScoreResponse {
  accepted: boolean; // 新記録採用したか
  rankChanged: boolean; // ここでは accepted と同義で返却
  previous: PutScoreSnapshot | null; // 以前の記録（存在しなければ null）
  current: PutScoreSnapshot | null; // 採用なら新記録／不採用なら現行記録
}

// ===== KVS（CloudFront Functionsで参照予定の形） =====
export type KvsOrderKey = 'score' | 'timeMs' | 'updatedAt';
export type KvsOrder = [KvsOrderKey, 'asc' | 'desc'];

export interface KvsThresholdScore {
  score: { min: number };
}
export interface KvsThresholdTime {
  timeMs: { max: number };
}
export interface KvsThresholdUpdatedAt {
  updatedAt: { minEpoch: number };
}
export type KvsThreshold = KvsThresholdScore | KvsThresholdTime | KvsThresholdUpdatedAt;

export interface KvsValue {
  ver: 1;
  order: KvsOrder[];
  thr: KvsThreshold[]; // 例: [{score:{min:..}}, {timeMs:{max:..}}, {date:{minEpoch:..}}]
  topN: number;
  updatedAt: string; // ISO8601
}
