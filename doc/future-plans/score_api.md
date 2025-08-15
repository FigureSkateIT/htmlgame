# 【要件定義】

- 最小コスト（固定費ほぼゼロ、従量も最小化）。WAFは使わない。
- CloudFront Functions による **二段階トークン**（/get-start, /get-end）。検証OKのみ API へ到達。
- API は **PUT/GET のみ**。POST は使わない。
- **複数ゲーム対応**：共通API・共通DynamoDBで流用可能。
- 登録フィールド：score（数値）、timeMs（数値）、userName、userId、gameId、meta（任意JSON）。
- **月間ランキング**（期間キー=YYYY-MM）と **総合ランキング**（期間キー=ALL）を同一テーブルで管理。
- 主要クエリ：ゲーム＋期間で **score降順／time昇順** のTop取得が多い。
- **Top100以外は削除**（定期トリム・日次）。
- 冪等性：**X-Idem-Key** で重複登録抑止。Lambda側で条件付き更新。
- APIレート制限：API Gateway ステージ/ルートで低RPS設定。
- APIは CloudFront 経由で利用（直叩き対策は前段トークン＋カスタムヘッダ）。

---

# 【設計】

## 1) DynamoDB テーブル図（実データ例つき）

- **テーブル**: `ScoreTable`
- **PK** (string): `G#${gameId}#P#${period}` 例: `G#snake#P#2025-08`, `G#snake#P#ALL`
- **SK** (string): `U#${userId}`  （ユーザIDをSKに置く）
- **二次インデックス**: **無し（LSI/GSIとも不使用）**

**Attributes**

- `userName` (string)
- `meta` (map) — 任意JSON（プレイヤーの表示名やゲーム固有のフラグ等）
- `score` (number)
- `timeMs` (number)
- `updatedAt` (ISO8601)

**設計方針（意図）**

- 各パーティション（ゲーム×期間）内に **1アイテム＝1ユーザ（SK=U#userId）** を保持。
- **ランキング取得はアプリ側（Lambda/JS）でソート**し、上位TopN（既定100）を返す。日次のトリムでPK内を常に<=100件に抑える想定のため、**DB側のソート（LSI）は不要**。
- 将来データ量が増えた場合のみ、**GSIを後付け**して読み性能を強化可能（LSIは後付け不可のため採用しない）。

**サンプル項目（snake / 2025-08）**

| PK                  | SK        | score | timeMs | userName | meta  | updatedAt            |
| ------------------- | --------- | ----- | ------ | -------- | ----- | -------------------- |
| `G#snake#P#2025-08` | `U#userA` | 1020  | 84500  | "Alice"  | {...} | 2025-08-15T12:15:30Z |
| `G#snake#P#2025-08` | `U#userB` | 980   | 80000  | "Bob"    | {...} | 2025-08-15T12:12:10Z |

---

## 1.1) PutScore の推奨処理フロー（LSI無し・属性更新型）

```ts
// 入力: gameId, period, userId, score, timeMs, userName, meta
const pk = `G#${gameId}#P#${period}`;
const key = { PK: pk, SK: `U#${userId}` };

// 1) 現在値を取得
const cur = await ddb.get({ TableName, Key: key });

// 2) ソート規則（S3のGameConfig）をロード（キャッシュTTL 30s）
const order = await loadOrderFromS3(gameId); // 例: [["score","desc"],["timeMs","asc"],["updatedAt","desc"]]

// 3) 採用判定（共通の比較器）
const better = isBetter({score,timeMs,updatedAt:now()}, cur?.Item, order);

// 4) 採用なら Update（※比較はアプリ側で済ませているので素直に更新）
if (better) {
  await ddb.update({
    TableName,
    Key: key,
    UpdateExpression: 'SET #s=:s, #t=:t, #n=:n, #m=:m, #ua=:ua',
    ExpressionAttributeNames: { '#s':'score','#t':'timeMs','#n':'userName','#m':'meta','#ua':'updatedAt' },
    ExpressionAttributeValues: { ':s':score, ':t':timeMs, ':n':userName, ':m':meta||{}, ':ua': new Date().toISOString() }
  });
}
```

> **補足（競合対策の選択肢）**
>
> - **A: IdemKey方式**（1.4節）：同一入力の多重送信を防ぐ（最小実装はこれで十分）。
> - **B: 楽観ロック**：アイテムに `ver` を持ち、`Get`で受けた `ver` に一致する場合のみ `Update`（`ConditionExpression: ver = :prev + SET ver = ver + 1`）。
> - **C: 条件式での数値比較**：ゲーム毎に比較式が異なるため共通化が難しい。必要ならゲーム固有の式を用意（例: `score < :s OR (score = :s AND timeMs > :t)` など）。 実装では `ConditionExpression` に比較ロジックを埋めにくいため、**アプリ側で比較→Update** とし、必要なら **楽観ロック（version属性）** を併用します。

---

## 1.2) GetRanking の処理（Lambda）

- `Query` で **PK=**``** の全アイテム**を取得（ページング対応）。
- 取得アイテムを **アプリ側で **``** に従ってソート** → 先頭 TopN を返却。
- データ数が100超の可能性がある場合は、**TopKヒープ**（K=100）で `O(N log K)` の効率に抑制。
- 応答には `Cache-Control: s-maxage, stale-while-revalidate` を付与して CloudFront キャッシュを活用。

---

## 1.3) Top100管理（トリム）

- 日次バッチ `trim-top`:
  1. `Query` で (gameId, period) の全アイテムをページング取得
  2. **同じ比較器**でソート（またはTopKヒープ）→ **101位以降を BatchWrite(Delete)**
  3. 100位の値から **閾値(thr)** を再計算し、**KVSの **`` を更新（ETag楽観ロック）

---

## 1.4) 冪等性・多重送信対策

- **IdemTable（オプション）**：`X-Idem-Key` を最初の受理で登録（TTL 1〜3分推奨）。以後の同一キーは早期 200/204 でスキップ。
- **楽観ロック（オプション）**：アイテムに `ver` を持たせ、`Get`→`Update ... ConditionExpression: ver = :prev`→`SET ver = ver + 1`。

---

## 1.5) ランキング生成アルゴリズム（優先順ソート→TopK打ち切り）

> **ANDで絞り込むのではなく**、ソート規則の**優先順位に沿って比較**し、上位から**100件に達した時点で打ち切り**る方針。

### ルール定義（S3のGameConfig）

```json
{
  "sort": [
    { "by": "score",   "dir": "desc" },
    { "by": "timeMs",  "dir": "asc"  },
    { "by": "updatedAt","dir": "desc" }
  ],
  "topN": 100
}
```

- `updatedAt` は任意の第3キー（タイブレーク用）。**KVSに入れる必要はない**。

### 実装（Lambda/JS 共通の比較器）

```ts
function buildComparator(rules:{by:'score'|'timeMs'|'updatedAt', dir:'asc'|'desc'}[]) {
  return (a:any,b:any) => {
    for (const r of rules) {
      const av = a[r.by], bv = b[r.by];
      if (av === bv) continue;
      const s = r.dir === 'asc' ? 1 : -1;
      return (av > bv ? 1 : -1) * s;
    }
    // 最終フォールバックで安定化（同値時の揺れ防止）
    return String(a.userId).localeCompare(String(b.userId));
  };
}
```

- 小規模（各PKが数百件以下＝日次トリム後）の場合は **全件ソート→先頭100件** が最もシンプル。
- 規模が大きい場合は **TopKヒープ**（サイズK=100の二分ヒープ）で `O(N log K)` に抑制可能。

### トリムとの相性

- 日次 `trim-top` では同じ比較器を使い、**101位以降を一括削除**。その結果、GET時のデータ量が小さくなり、Lambda/JSのソート負荷・帯域が最小化される。

---

(次の節: リソース一覧以下はそのまま継続します)（IaCで作成）

| 種別                       | 名前（例）                                       | 役割/ポイント                                                                                                                                 |
| ------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| CloudFront Functions     | `cf-get-start`, `cf-get-end`, `cf-validate` | 2段階トークン発行/検証（/get-start, /get-end はFunctionsが直接応答）。`/scores` へのリクエストはヘッダ検証OKのみAPIへフォワード。                                                |
| CloudFront (既存)          | `site-dist`                                 | 静的サイト配信＋APIオリジン（APIGW）へルーティング。`OriginRequestPolicy` でカスタムヘッダ `X-Edge-Auth` を付与。                                                         |
| API Gateway **HTTP API** | `score-api`                                 | 低コスト。**Routes**: `PUT /scores/{gameId}/{period}/{userId}`, `GET /ranking/{gameId}/{period}`。ステージ `prod` にレート制限（例: rate=2 rps, burst=5）。 |
| Lambda                   | `put-score`                                 | スコア登録。ヘッダ/署名軽検証→`ScoreTable`へ条件付き更新→必要ならランキング変化フラグ出力。                                                                                   |
| Lambda                   | `get-ranking`                               | ランキング取得。**PKのQuery**（ページング）→アプリ側ソート→TopN返却。`Cache-Control` を設定。                                                                         |
| DynamoDB                 | `ScoreTable`                                | スコア・自己ベスト保持（1ユーザ=1項目/ゲーム×期間）。**インデックス無し**。                                                                                              |
| DynamoDB                 | `IdemTable`                                 | 冪等キー格納（TTLで自動削除）。※**オプション**                                                                                                             |
| EventBridge + Lambda     | `trim-top`                                  | 日次で各 (gameId, period) の **101件目以降を削除**（Score/Time双方の観点で）。                                                                               |
| CloudWatch Logs          | 各Lambda/APIGW                               | 監視。エラー/429/5xxの簡易アラート。                                                                                                                  |

---

## 3) API仕様書（v1）

### 前段（CloudFront Functions）

- **GET** `/get-start` → `{ token_start }` を返す（Cookie: `game_sid` 発行）。
- **GET** `/get-end?token_start=...` → `token_end` を返す（`token_start` を弱検証）。

### 本API（API Gateway HTTP API）

> すべて CloudFront 経由。CloudFront が `X-Edge-Auth: <固定値>` を付与。直叩きはこのヘッダが無い/不一致のため到達しにくい設計（より強固にする場合は **REST+Private API** へ移行）。

#### 1. PUT `/scores/{gameId}/{period}/{userId}`

- **Headers (必須)**
  - `X-Token-Start`, `X-Token-End` — 2段階トークン
  - `X-Sig` — `HMAC_SHA256(key=T_end, msg="${userId}|${score}|${timeMs}|${period}")`
  - `X-Idem-Key` — 冪等キー（**任意**）
  - `X-Player` — 表示名
  - `Content-Type: application/json`
- **Body (任意)** `{ "meta": { ... 任意JSON ... } }`
- **Logic（Lambda）**: IdemKeyチェック→現在値取得→S3の`order`で比較→良ければ更新
- **Response 200**: `{ updated: true|false, score, timeMs, updatedAt }`

#### 2. GET `/ranking/{gameId}/{period}`

- **Query**: `limit=10..100`（既定: 100）
- **処理**: `ScoreTable` を **PK=G#gameId#P#period** で **Query（ページング）→ S3のGameConfigの **``** に従ってアプリ側でソート → TopN を返却**。
- **Response 200**: `[{ userId, userName, score, timeMs, rank }]`

---

## 4) キャッシュ方針とトップ100管理

### A. CloudFrontキャッシュ（GET /ranking）

- **できるだけキャッシュ**：`Cache-Control: s-maxage=600, stale-while-revalidate=120` などを `get-ranking` が返却。
- **無効化(Invalidate)**：`put-score` が **ランキングに影響があった場合のみ** CloudFrontへ `CreateInvalidation` を実行。
  - 注意：**クエリは無効化キーに含まれない**ため、 `/ranking/{gameId}/{period}` 一括が対象。
  - 精密に無効化したい場合は **RESTful化**：`/ranking/{gameId}/{period}/by/score` と `/by/time` を用意（**推奨**）。
- **Cache Key**：`{gameId, period}` のみ（常に Top100 を返す設計のため `limit` や `by` は含めない）。クライアント側で必要件数に切り出す。

### B. トップ100以外の削除（トリム）

- **日次** EventBridge → `trim-top` Lambda。
- 各 (gameId, period) について：
  1. `Query` で全アイテムをページング取得
  2. **GameConfigの **``**（S3）** でTopNを算出（またはTopKヒープ）
  3. **101位以降を BatchWrite(Delete)**
  4. **100位の値から **``** を再計算**し、**KVS **`` を更新（ETag楽観ロック）

---

## 5) セキュリティ＆レート制限（最小コスト）

- **前段**で 2段階トークン＋ヘッダ署名検証。`/scores` は CloudFront Functions による検証OKのみフォワード。
- **API Gateway (HTTP API)** ステージ/ルートでレート制限（例: `rate=2 rps`, `burst=5`）。
- **直叩き抑止**：CloudFront→APIGWに固定カスタムヘッダ `X-Edge-Auth` を付与し、Lambdaで照合（簡易）。より強固にする場合は **REST+Private API** へ移行し、VPCエンドポイント/Resource Policyで CloudFront からのみ許可。

---

## 5.1) KVS（CloudFront Functions KeyValueStore）同期設計

> 目的：前段での**下限スコア/上限タイム**などの早期フィルタを可能にする（Functionsは**ボディ不可・ネットワーク不可**のため、**KVSに閾値＋並び順を置く**）

**算出元/真ソース**：

- 並び順（order）… **S3 の GameConfig**（GitHub 管理のJSON）
- 閾値（thr）…… **ScoreTable の実データ**から **日次 **``** Lambda** が再計算
- **KVS** は `cfgthr#g:${gameId}#p:${period}` に **order+thr を一体**で保持（5.2参照）

**更新トリガ**：

- **標準（最小運用）**：日次の `trim-top` が TopN（既定100）を計算 → **100位の値から「thr」を導出** → **KVS **``** を更新**（ETag楽観ロック）。
- **拡張（任意）**：`put-score` 採用時に EventBridge で非同期再計算してKVSを準リアルタイム更新（※ホットパスでは実施しない）。

**更新方法（API）**：

- `DescribeKeyValueStore` で **ETag** を取得 → `UpdateKeys` / `PutKey` で更新（楽観ロック）。
- 1値は**1KB以内**、KVS合計は**最大5MB**、1関数に紐づくKVSは**1つ**。

**整合性**：KVSは**数秒オーダの伝播遅延**あり。前段で弾き切れなくても **Origin（Lambda）側で最終判定**して二重防御。

---

## 5.2) KVSデータモデル（①ソート順＋②閾値を含む／複数ゲーム対応）

**方針更新**：CloudFront Functions で**前段フィルタ**を正しく行うため、KVSには**閾値だけでなく、ソート優先順位（昇降）****も含める。S3の GameConfig は真ソースとして同じルールを保持し、KVSは****軽量ミラー**（periodごとの閾値付き）とする。

### キー命名（ネームスペース）

- **ゲーム×期間のルール＋閾値**: `cfgthr#g:${gameId}#p:${period}`\
  例: `cfgthr#g:snake#p:2025-08`, `cfgthr#g:snake#p:ALL`

> ※キーを一つにまとめることで CloudFront Functions からの参照を1回にし、KVSの容量・更新回数を節約します。

### 値のJSONスキーマ（<= 1KB/キー）

```json
{
  "ver": 1,
  "order": [
    ["score",  "desc"],
    ["timeMs", "asc" ],
    ["date",   "desc"]
  ],
  "thr": [
    { "score":  { "min": 100 } },
    { "timeMs": { "max": 20000 } },
    { "date":   { "minEpoch": 1723708800 } }
  ],
  "topN": 100,
  "updatedAt": "2025-08-15T12:05:00Z"
}
```

- `order`: **優先順位配列**（上から第1キー, 第2キー...）。`"asc"|"desc"`。
- `thr`: **同じ並び**でしきい値を記載。各要素は使用するフィールドのみを持ち、未使用なら省略可。
  - `desc` のフィールドは ``** / **``（これ未満は即拒否）
  - `asc` のフィールドは ``** / **``（これ超過は即拒否）
- `date` は数値エポックを採用（Functions内での比較が簡単）。
- `topN`: 一応保持（参考）。
- `ver`/`updatedAt`: バージョンと更新時刻。

> サイズをさらに縮めたい場合は `order` を `[["s","d"],["t","a"],["d","d"]]` のように**短縮キー**（s/t/d, a/d）へ置換可能。

### CloudFront Functions（前段フィルタ）での利用例（擬似）

```js
const raw = kv.get(`cfgthr#g:${gameId}#p:${period}`);
if (raw) {
  const cfg = JSON.parse(raw); // { order, thr, topN }
  const by = (f) => ({ score: +incoming.score, timeMs: +incoming.timeMs, date: +incoming.epoch })[f];
  for (let i = 0; i < cfg.order.length; i++) {
    const [field, dir] = cfg.order[i];
    const limit = cfg.thr[i]?.[field];
    if (!limit) continue; // 閾値未設定ならスキップ
    if (dir === 'desc' && limit.min != null && by(field) < limit.min) deny();
    if (dir === 'asc'  && limit.max != null && by(field) > limit.max) deny();
    if (field === 'date' && limit.minEpoch && by('date') < limit.minEpoch) deny();
    if (field === 'date' && limit.maxEpoch && by('date') > limit.maxEpoch) deny();
  }
}
// ここを通ったらAPIへフォワード（最終判定はOriginで）
```

- **意図**：上位キーから順にチェックし、**しきい値に満たない入力を早期拒否**。TopNの「満たしたら終了」という概念は**算出済しきい値**に折り込まれているため、Functionsは単純比較でOK。

### Lambda/JS 側（最終判定・ランキング生成）

- **S3のGameConfig**（`order`のみ／真ソース）をロードし、
  1. 全件を `order` に従って比較（`updatedAt`等はアイテムの属性で参照）
  2. **TopN** を切り出し
  3. 100位の値から ``** を再計算**（`desc`→min、`asc`→max、date→minEpoch/maxEpoch）し、KVSの `cfgthr#g:...` を更新

### 互換と移行

- 旧 `thr#...` 形式からの移行時は、当面 **両キーを併存**（Functionsで `cfgthr#...` → 無ければ `thr#...` を参照）し、完全移行できたら旧キーを削除。

---

## 5.3) CI/CD の環境変数の扱い（※CloudFront Functionsの環境変数ではありません）

- CI（GitHub Actions 等）で**ビルド時に一時環境変数**を使って、鍵や設定をテンプレートに注入するのはOK。
- **注意**：
  - CIのログへ**値を出力しない**（`set -x`禁止、echo禁止）。
  - アーティファクトはKMS暗号化＆短期保管。
  - OIDCでAssumeRoleし、最小権限ロールでS3/KVS更新のみ許可。
- CloudFront Functions は**実行時の環境変数をサポートしない**ため、鍵は「ビルド時にコードへ定数として注入」し、**二重鍵ローテーション**で無停止切替を行う（前節参照）。

---

## 6) コスト最小化の工夫

- **HTTP API 採用**（RESTより従量が安い）。PUT/GETとも利用可。
- **インデックス無し**で **書き込みコストを最小化**。読みはPK単位（<=100件）なのでアプリ側ソートで十分。
- `IdemTable` TTLで冪等キー自動削除（オプション）。
- `get-ranking` は `ProjectionExpression` で転送量削減、CloudFront キャッシュを活用。
- `trim-top` は日次1回に集約（必要時のみ準リアルタイム反映）。

---

## 7) 本設計の思想・効果・不採用の理由

### なぜ“雑につくらない”のか（思想）

- **まず落とす／まずキャッシュ**：高価な層（API/Lambda/DB）に届く前に、**CloudFront Functions**で 2段階トークン＋KVSのしきい値でふるい落とす。読みは**CloudFrontキャッシュ**で吸収する。
- **データ駆動**：ゲームごとの差異は\*\*GameConfig(JSON)\*\*で表現し、コードは共通化。新作ゲームの追加でコードやDynamoDBスキーマを触らない。
- **作らない勇気**：LSI/GSI・WAF・同期用Lambdaを**最初は持たない**。負荷や要件が出てから**後付け**できる道を残す。

### 効果（“ただのAPIGW+Lambda+DDB”比での差）

- **コスト**：GETはほぼキャッシュ、PUTは前段で不正/低品質を遮断→**API/Lambda/DBのリクエストを削減**。DDBはTop100維持で常に小さく、**インデックス無し**で最小課金。
- **運用**：運用タスクは**日次**``**のみ**に集約（101位以降削除＋KVS更新）。Config更新は**GitHub→S3**で完結。
- **拡張**：**新ゲームはJSON追加だけ**。KVSは日次で自動的に閾値を再導出。
- **セキュリティ**：2段階トークン＋HMAC検証（前段）＋オリジン再検証の**二重防御**。API Gateway のスロットリングも併用。

### 不採用・見送りの理由（現時点）

- **WAF**：月額**約\$5/アカウント**は**個人運用では重い**。今回の脅威モデルは **Functionsの前段防御＋APIGWスロットリング** で十分緩和可能。将来必要なら付加できる。
- **LSI/GSI**：Top100運用でPK内が小さく、**アプリ側ソートで十分**。GSIは**後付け可能**なので、今は採用しない（LSIは後付け不可）。
- **同期Lambda（DDB→KVS）**：更新頻度が低く、**日次trim-top**で十分。Functions増は運用負荷になるため採用しない。
- **SecretsのKVS格納**：KVSは公開寄りのストア。**秘密鍵はデプロイ時に関数へ注入**（二重鍵ローテーション）し、KVSには置かない。

### トレードオフと対策

- **KVS伝播遅延**（数秒〜十数秒）：前段で漏れても**Originで最終判定**。
- **CloudFrontの課金はゼロではない**：それでも**API/Lambda/DBより安い**ため、前段で落とす価値が大きい。
- **秘密の注入**：関数コードに含まれるため、**閲覧権限の最小化＋CloudTrail監査＋自動ローテーション**でリスク低減。

---

# 【タスク】（優先度つき）

## P0（基盤・最小で動くまで）

-

## P1（アプリ実装と結線）

-

## P2（運用自動化）

-

## P3（CI/CDとセキュリティ強化）

-

## P4（将来拡張）

-

