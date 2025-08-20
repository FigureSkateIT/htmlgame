// get-ranking/handler.ts
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import type { ScoreItem } from '../types';

// 共通ユーティリティ（移動後パス）
import { sortAndTrimScores } from '../utils/score-sorter';
import { queryAllByPk } from '../utils/ddb-utils';

const TABLE_NAME = process.env.TABLE_NAME!;
const TOP_N_ENV = parseInt(process.env.TOP_N || '100', 10);

/** DDBアイテム -> ScoreItem へ変換（nullは入力側で排除前提） */
function toScoreItem(raw: Record<string, unknown>): ScoreItem {
  return {
    userId: String(raw.SK).replace(/^U#/, ''),
    userName: String(raw.userName),
    score: Number(raw.score),
    timeMs: Number(raw.timeMs),
    updatedAt: String(raw.updatedAt), // ISO8601前提（文字列比較で時系列OK）
    meta: raw.meta,
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const { gameId, period } = event.pathParameters ?? {};
    if (!gameId || !period) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required parameters' }) };
    }

    // ?limit= は「返す件数の上限」。環境変数TOP_Nを超えない
    const qLimit = parseInt(event.queryStringParameters?.limit ?? '', 10);
    const responseTopN = Number.isFinite(qLimit)
      ? Math.min(Math.max(qLimit, 1), TOP_N_ENV)
      : TOP_N_ENV;

    const PK = `G#${gameId}#P#${period}`;

    // 1) PK配下を全件取得（ページングは ddb-utils に集約）
    const rawItems = await queryAllByPk(PK, { tableName: TABLE_NAME });

    // 2) 型へマップ
    const scoreItems: ScoreItem[] = rawItems.map(toScoreItem);

    // 3) 設定駆動の“一発ソート → 上位N件抽出”
    const topByConfig = await sortAndTrimScores(scoreItems, gameId);

    // 4) クライアント指定 limit でさらにトリム & rank 付与
    const items = topByConfig.slice(0, responseTopN).map((item, idx) => ({
      rank: idx + 1,
      userId: item.userId,
      userName: item.userName,
      score: item.score,
      timeMs: item.timeMs,
      updatedAt: item.updatedAt,
    }));

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 's-maxage=600, stale-while-revalidate=120',
      },
      body: JSON.stringify({
        items,
        topN: responseTopN,
        totalCandidates: scoreItems.length, // 取得候補の総数
        updatedAt: new Date().toISOString(),
        as: 'GetRankingResponse',
      }),
    };
  } catch (err) {
    console.error('get-ranking error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
