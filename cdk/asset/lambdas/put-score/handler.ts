// lambdas/put-score/handler.ts
import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';

import type { ScoreItem } from '../types';
import { isBetterScore } from '../utils/score-sorter'; // ← これを使う

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cf = new CloudFrontClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
const EDGE_AUTH_HEADER = process.env.EDGE_AUTH_HEADER || 'x-edge-auth';
const CF_DIST_ID = process.env.CF_DIST_ID || undefined;
const EDGE_AUTH_VALUE = process.env.EDGE_AUTH_VALUE || 'valid-edge-request';

function toScoreItemFromInputs(
  userId: string,
  userName: string,
  score: number,
  timeMs: number
): ScoreItem {
  return { userId, userName, score, timeMs, updatedAt: new Date().toISOString() };
}
function toScoreItemFromDdb(raw: Record<string, unknown> | undefined): ScoreItem | null {
  if (!raw) return null;
  return {
    userId: String(raw.SK).replace(/^U#/, ''),
    userName: String(raw.userName),
    score: Number(raw.score),
    timeMs: Number(raw.timeMs),
    updatedAt: String(raw.updatedAt),
    meta: raw.meta,
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    // Normalize headers to lowercase
    const headers: Record<string, string> = {};
    Object.entries(event.headers || {}).forEach(([k, v]) => {
      if (v) headers[k.toLowerCase()] = v;
    });

    // 1) Edge認証
    if (!headers[EDGE_AUTH_HEADER.toLowerCase()]) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }
    if (headers[EDGE_AUTH_HEADER.toLowerCase()] !== EDGE_AUTH_VALUE) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
    }
    // 2) 入力
    const { gameId, period, userId } = event.pathParameters ?? {};
    const score = parseInt(headers['x-score'] || '0', 10);
    const player = headers['x-player'] || '';
    const timeMs = parseInt(headers['x-time-ms'] || '0', 10);
    const updatedAt = headers['x-updated-at'] || '';

    if (!gameId || !period || !userId || !player || !Number.isFinite(score) || !updatedAt) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required parameters' }) };
    }

    // Sanitize inputs to prevent injection
    const sanitizedGameId = String(gameId).replace(/[^a-zA-Z0-9-_]/g, '');
    const sanitizedPeriod = String(period).replace(/[^a-zA-Z0-9-_]/g, '');
    const sanitizedUserId = String(userId).replace(/[^a-zA-Z0-9-_]/g, '');

    const PK = `G#${sanitizedGameId}#P#${sanitizedPeriod}`;
    const SK = `U#${sanitizedUserId}`;

    // 3) 既存記録（1件だけ）
    const got = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: { PK, SK } }));
    const existing = toScoreItemFromDdb(got.Item);

    // 4) 新記録判定（← ここを isBetterScore に置き換え）
    const candidate = toScoreItemFromInputs(userId, player, score, timeMs);
    candidate.updatedAt = updatedAt;
    const accepted = await isBetterScore(candidate, existing, gameId); // gameName=gameId 前提

    // 5) 採用時のみ更新 & Invalidation
    if (accepted) {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { PK, SK },
          UpdateExpression:
            'SET score=:score, timeMs=:timeMs, userName=:userName, updatedAt=:updatedAt',
          ExpressionAttributeValues: {
            ':score': candidate.score,
            ':timeMs': candidate.timeMs,
            ':userName': candidate.userName,
            ':updatedAt': candidate.updatedAt,
          },
        })
      );

      if (CF_DIST_ID) {
        try {
          await cf.send(
            new CreateInvalidationCommand({
              DistributionId: CF_DIST_ID,
              InvalidationBatch: {
                Paths: { Quantity: 1, Items: [`/api/ranking/${gameId}/${period}*`] },
                CallerReference: `score-update-${Date.now()}`,
              },
            })
          );
        } catch (err) {
          console.error('Invalidation failed:', err);
        }
      }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({
        accepted,
        rankChanged: accepted,
        previous: existing
          ? { score: existing.score, timeMs: existing.timeMs, updatedAt: existing.updatedAt }
          : null,
        current: accepted
          ? { score: candidate.score, timeMs: candidate.timeMs, updatedAt: candidate.updatedAt }
          : existing,
        as: 'PutScoreResponse',
      }),
    };
  } catch (err) {
    console.error('put-score error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
