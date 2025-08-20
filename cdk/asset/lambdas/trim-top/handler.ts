// lambdas/trim-top/handler.ts
import { ScheduledEvent } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

// CloudFront KeyValue Store 用 SDK（← ここがポイント）
import {
  CloudFrontKeyValueStoreClient,
  DescribeKeyValueStoreCommand,
  PutKeyCommand,
} from '@aws-sdk/client-cloudfront-keyvaluestore';

import type { ScoreItem, GameConfig, SortRule } from '../types';
import { queryAllByPk } from '../utils/ddb-utils';
import { sortAndTrimScores, loadGameConfig } from '../utils/score-sorter';

// ==== Clients ====
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const cf = new CloudFrontKeyValueStoreClient({
  // CloudFront KVS は us-east-1 想定。必要なら環境変数で上書き
  region: process.env.CLOUDFRONT_REGION || 'us-east-1',
});

// ==== Env ====
const TABLE_NAME = process.env.TABLE_NAME!;
const KVS_ARN = process.env.KVS_ARN!; // arn:aws:cloudfront::<acct>:key-value-store/<id>
const DEFAULT_TOP_N = parseInt(process.env.TOP_N || '100', 10);
const PK_PREFIX = process.env.PK_PREFIX || '';
const LIST_PAGE_SIZE = parseInt(process.env.LIST_PAGE_SIZE || '200', 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '25', 10);

// ==== Helpers ====

/** DDB -> ScoreItem（null/undefinedは入力段階で除外前提） */
function toScoreItem(raw: Record<string, unknown>): ScoreItem {
  return {
    userId: String(raw.SK).replace(/^U#/, ''),
    userName: String(raw.userName),
    score: Number(raw.score),
    timeMs: Number(raw.timeMs),
    updatedAt: String(raw.updatedAt), // ISO8601
    meta: raw.meta,
  };
}

/** distinct PK を列挙（必要なら prefix で絞る） */
async function listDistinctPks(): Promise<string[]> {
  const pkSet = new Set<string>();
  let lastKey: Record<string, unknown> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ProjectionExpression: 'PK',
        ExclusiveStartKey: lastKey,
        Limit: LIST_PAGE_SIZE,
        ...(PK_PREFIX
          ? {
              FilterExpression: 'begins_with(PK, :p)',
              ExpressionAttributeValues: { ':p': PK_PREFIX },
            }
          : {}),
      })
    );
    res.Items?.forEach(it => pkSet.add(String(it.PK)));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return Array.from(pkSet);
}

/** DeleteRequest 型 & UnprocessedItems 型（型安全） */
type DeleteRequest = { DeleteRequest: { Key: Record<string, unknown> } };
type RequestMap = Record<string, DeleteRequest[]>;

/** このファイル内専用：型安全な BatchWrite 削除（未処理リトライつき） */
async function batchDeleteAll(requests: Array<{ PK: string; SK: string }>): Promise<void> {
  if (BATCH_SIZE > 25) throw new Error('BATCH_SIZE must be <= 25 for BatchWriteItem');

  for (let i = 0; i < requests.length; i += BATCH_SIZE) {
    const chunk = requests.slice(i, i + BATCH_SIZE);

    let unprocessed: RequestMap = {
      [TABLE_NAME]: chunk.map<DeleteRequest>(it => ({
        DeleteRequest: { Key: { PK: it.PK, SK: it.SK } },
      })),
    };

    let attempt = 0;
    while (unprocessed[TABLE_NAME] && unprocessed[TABLE_NAME].length > 0) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: unprocessed }));

      const nextRaw = res.UnprocessedItems ?? {};
      const nextUnprocessed: RequestMap = Object.fromEntries(
        Object.entries(nextRaw).map(([tbl, reqs]) => [tbl, (reqs ?? []) as DeleteRequest[]])
      );

      unprocessed = nextUnprocessed;

      if (unprocessed[TABLE_NAME]?.length) {
        const delayMs = Math.min(200 * 2 ** attempt, 3000);
        await new Promise(r => setTimeout(r, delayMs));
        attempt++;
      }
    }
  }
}

/** GameConfig.sort -> KVSの order 形式へ変換 */
function buildOrderFromConfig(config: GameConfig | null): [string, 'asc' | 'desc'][] {
  if (!config) {
    // フォールバック（必要に応じて変更可）
    return [
      ['score', 'desc'],
      ['timeMs', 'asc'],
      ['updatedAt', 'desc'],
    ];
  }
  return config.sort.map((r: SortRule) => {
    return [r.by, r.dir] as [string, 'asc' | 'desc'];
  });
}

/** TopN の最下位からしきい値を作る */
function makeThresholdFromBottom(bottom: ScoreItem) {
  return [{ score: bottom.score }, { timeMs: bottom.timeMs }, { updatedAt: bottom.updatedAt }];
}

/** CloudFront KVS に upsert（ETag を取得して IfMatch で PutKey） */
async function upsertKvs(key: string, valueObj: Record<string, unknown>) {
  if (!KVS_ARN) {
    console.warn('[trim-top] KVS_ARN not set; skip KVS update');
    return;
  }
  // 1) ETag 取得
  const desc = await cf.send(new DescribeKeyValueStoreCommand({ KvsARN: KVS_ARN }));
  const eTag = desc.ETag;

  // 2) 値を String に
  const payload = JSON.stringify(valueObj);

  // 3) PutKey（IfMatch 必須）
  await cf.send(
    new PutKeyCommand({
      KvsARN: KVS_ARN,
      Key: key, // ← DynamoDBのPKをそのままKeyとして使用
      Value: payload,
      IfMatch: eTag,
    })
  );

  console.log(`[trim-top] KVS upsert key=${key} Value=${payload}`);
}

// ==== Handler ====
// PKごとに：全件取得 → 設定準拠で一発ソート → TopN以外削除 → KVSへしきい値保存（キー＝PK）
export const handler = async (_event: ScheduledEvent) => {
  console.log('[trim-top] start');

  const pks = await listDistinctPks();
  console.log(`[trim-top] target PKs: ${pks.length}`);

  let totalDeleted = 0;
  let totalKept = 0;

  for (const pk of pks) {
    // 1) 取得
    const rawItems = await queryAllByPk(pk, { tableName: TABLE_NAME });
    if (rawItems.length === 0) {
      console.log(`[trim-top] PK=${pk} : empty, skip`);
      continue;
    }

    // 2) GameConfig 読み込み（gameName は PK = "G#<gameName>#..." を想定）
    const parts = pk.split('#');
    const gameName = parts[1] ?? '';
    const config = await loadGameConfig(gameName);

    // 3) 設定準拠で一発ソート → TopN 抽出
    const scores = rawItems.map(toScoreItem);
    const top = await sortAndTrimScores(scores, gameName); // config?.topN が優先
    const keepSet = new Set(top.map(s => s.userId));

    // 4) TopN以外を削除
    const toDelete = rawItems
      .filter(r => !keepSet.has(String(r.SK).replace(/^U#/, '')))
      .map(r => ({ PK: String(r.PK), SK: String(r.SK) }));

    if (toDelete.length > 0) {
      await batchDeleteAll(toDelete);
      totalDeleted += toDelete.length;
    }
    totalKept += top.length;

    // 5) KVS 更新（キー＝DynamoDBのPK）
    const bottom = top[top.length - 1] ?? null;
    if (bottom) {
      const kvsValue = {
        ver: 1,
        order: buildOrderFromConfig(config),
        thr: makeThresholdFromBottom(bottom),
        topN: config?.topN ?? DEFAULT_TOP_N,
        updatedAt: new Date().toISOString(),
      };

      try {
        await upsertKvs(pk, kvsValue); // ← PK 文字列をそのまま Key に使う
      } catch (e) {
        console.error(`[trim-top] KVS upsert failed for key=${pk}`, e);
        // トリム自体は成功しているので throw はしない
      }
    }

    console.log(`[trim-top] PK=${pk} kept=${top.length} deleted=${toDelete.length}`);
  }

  console.log(`[trim-top] done: deleted=${totalDeleted}, kept=${totalKept}, pks=${pks.length}`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      deletedItems: totalDeleted,
      keptItems: totalKept,
      processedPKs: pks.length,
    }),
  };
};
