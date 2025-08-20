// ddb-utils.ts
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

let _docClient: DynamoDBDocumentClient | null = null;

/** シングルトンで DocumentClient を取得 */
export function getDocClient(): DynamoDBDocumentClient {
  if (_docClient) return _docClient;
  _docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _docClient;
}

export interface QueryAllByPkOptions {
  tableName: string;
  pageSize?: number;                 // 1回あたりの件数 (既定: env.PAGE_SIZE or 200)
  consistentRead?: boolean;          // 既定 false
  projectionExpression?: string;     // 取得属性を絞る
  expressionAttributeNames?: Record<string, string>; // Projectionで予約語がある場合など
  maxItems?: number;                 // 総取得上限（安全弁）。未指定なら最後まで。
  client?: DynamoDBDocumentClient;   // 別クライアントを使いたい場合
  abortSignal?: AbortSignal;         // 中断したい場合
}

/**
 * PK = :pk のアイテムをページングで最後まで（または maxItems まで）収集して返す。
 * 返り値は **素のDDBアイテム**（変換は呼び出し側）。
 */
export async function queryAllByPk(
  pk: string,
  {
    tableName,
    pageSize = parseInt(process.env.PAGE_SIZE || '200', 10),
    consistentRead = false,
    projectionExpression,
    expressionAttributeNames,
    maxItems,
    client = getDocClient(),
    abortSignal,
  }: QueryAllByPkOptions,
): Promise<any[]> {
  const out: any[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    if (abortSignal?.aborted) break;

    const res = await client.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': pk },
      ExclusiveStartKey: lastKey,
      Limit: pageSize,
      ConsistentRead: consistentRead,
      ProjectionExpression: projectionExpression,
      ExpressionAttributeNames: expressionAttributeNames,
    }));

    if (res.Items?.length) {
      if (maxItems && out.length + res.Items.length > maxItems) {
        const remain = maxItems - out.length;
        out.push(...res.Items.slice(0, Math.max(0, remain)));
        break;
      } else {
        out.push(...res.Items);
      }
    }
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);

  return out;
}