# Score-apiスタック設計書（CDK拡張版）

> 本書は **cdk-architecture-design.md の共通方針**（命名規約・タグ設計・環境分離・自動化原則 等）を前提に、`score-api` 専用の設計差分だけをまとめた **拡張ドキュメント**です。二段階トークン（CloudFront Functions）と `API Gateway + Lambda + DynamoDB` を **最小コスト**で接続します。

---

## 0. スコープと前提

- **対象スタック**: `ScoreApiStack`
- **目的**: スコア登録/取得APIの提供、及び前段の CloudFront Functions（2段階トークン＋ヘッダ検証）の導入。
- **前提**:
  - すでに **静的サイト用の CloudFront Distribution** が存在し、**DistributionId が SSM**（`/htmlgame/front-stack/cf-dist-id`）に格納済み。
  - `score_api.md` 記載の API 仕様・データモデルに準拠（Top100運用、月間/総合ランキング、PUT/GETのみ）。
  - WAF は **不採用**（固定費回避）。不正遮断は **CloudFront Functions + APIGWスロットリング** で実施。
- **SSM命名規則**: `/htmlgame/{スタック名}/{パラメータ名}`。全てのSSMキーは ``** の **`` で一元管理し、CDK/GitHub Actions ともに同一キーを参照。

---

## 1. ファイル構造（モノレポ想定）

```
repo-root/
├─ cdk/
│  ├─ bin/
│  │  └─ app.ts                       # エントリ（ステージ分岐なし）
│  ├─ lib/
│  │  ├─ score-api-stack.ts           # ← スタック本体（L3未使用）
│  │  └─ score-api/                   # ← スタック専用“関数群”。ここで L2/L1 を作成
│  │     ├─ ssm.ts                    # readParam / exportParam（SSM入出力）
│  │     ├─ ddb.ts                    # createScoreTable()
│  │     ├─ lambdas.ts                # createPutScoreFn / createGetRankingFn / createTrimTopFn
│  │     ├─ api.ts                    # buildHttpApi({putFn,getFn})
│  │     └─ cloudfront.ts             # createCfFunctions / patchCfAssociations（JSONパッチ内包）
│  ├─ package.json
│  └─ cdk.json
│
├─ asset/
│  ├─ lambdas/
│  │  ├─ put-score/handler.ts      # スコア登録（CDK内に移動）
│  │  ├─ get-ranking/handler.ts    # TopN取得（CDK内に移動）
│  │  └─ trim-top/handler.ts       # 日次トリム（CDK内に移動）
│  ├─ package.json
│  └─ cdk.json
│
├─ asset/
│  └─ cf-funcs/
│     ├─ get-start.js                 # 2段階トークン(1)発行（閾値なし）- **実装済み**
│     ├─ get-end.js                   # 2段階トークン(2)発行（start検証＋時間整合）- **実装済み**
│     ├─ validate.js                  # 2トークン検証＋閾値✅→OK時のみOriginへ - **実装済み**
│     ├─ kvs-schema.json              # cfgthr スキーマ参考
│     └─ keys.sample.json             # {active:"A", K1A:"...", K1B:"..."}
│
├─ config/
│  ├─ shared.ts                      # SSMキーの一元管理（CONSTANTS.SSM_PARAMETERS）
│  ├─ game-config/
│  │  └─ snake.json                   # ソート順/TopN（真ソース）
│  └─ paths.json                      # { "API_BASE_PATH": "/api" }
└─ .github/workflows/
   ├─ cdk-deploy.yml                   # OIDC AssumeRole → cdk deploy
   └─ html-deploy.yml                  # 既存（静的サイト）
```

**方針**

- **L3コンストラクトを使わず**、`score-api/` 配下の**関数**から **L2（必要に応じてL1）** を生成。
- **物理IDは固定の Construct ID** を使用（今回 **stage なし**）。命名はコード上の ID を明示して安定化。
- **型定義は各ファイル先頭に最小限**（その関数専用の `interface` をローカルに定義）。共有型は極小化。
- **命名規則の統一**: ファイル名と関数名を一致させる（例：`create-score-table.ts` → `createScoreTable`）。front-stackと同様のパターンを採用。

---

## 2. 本スタックが作る AWS リソース（詳細定義）

本スタックが提供する要素は **HTTP API（PUT/GET）**、**Lambda（put/get/trim）**、**DynamoDB（ScoreTable）**、**CloudFront Functions（get-start / get-end / validate + KVS）**、**SSM パラメータ参照**、および **既存 CloudFront Distribution への FunctionAssociation の upsert** です。固定費を避けつつ、**二段階トークン検証をエッジで完結**させ、**Lambda 実行回数と DDB 読み書き**を最小化します。

> 以下 **2.1〜2.3** に、各 CDK ファイル/Asset 関数の **入力・戻り値・作成リソース・IAM・環境変数・物理ID方針** を説明します。
>
> **実装状況**: 本設計に基づくCDKスタックが完全実装済みです。

**CloudFront Functions**: 二段階トークン仕様に完全準拠し、KVS統合による鍵管理、HMAC署名検証、セッション管理、時間整合性チェック、閾値検証を実装済み。

**Lambda関数**: put-score（スコア登録）、get-ranking（ランキング取得）、trim-top（日次整理）の3関数が実装済み。

**インフラ**: HTTP API（アクセスログ、CORS設定済み）、DynamoDB、EventBridge、SSMパラメータ管理が実装済み。
>
> **CloudFront Functions実装状況**:
> - `get-start.js`: セッションID生成、token_start発行、Cookie設定 - **実装完了**
> - `get-end.js`: token_start検証、token_end発行、時間整合性チェック - **実装完了** 
> - `validate.js`: 二段階トークン検証、スコア署名検証、KVS閾値チェック - **実装完了**
> - KVS統合: `k_current`/`k_prev`による鍵ローテーション対応 - **実装完了**

**本スタックが作る AWS リソース（要点）**

- **API Gateway (HTTP API)**: `ScoreApi`
  - **ルート**: `PUT {API_BASE_PATH}/scores/{gameId}/{period}/{userId}` / `GET {API_BASE_PATH}/ranking/{gameId}/{period}`
  - **ステージ**: `prod`（低RPS例: `rate=2, burst=5`。HTTP APIはステージ単位）
- **Lambda**
  - **PutScoreFn**: スコア採用判定 → `ScoreTable` 更新 →（必要時）**CloudFront Invalidation**
  - **GetRankingFn**: PKのQuery→ソート→TopN返却（`Cache-Control: s-maxage`, `stale-while-revalidate`）
  - **TrimTopFn**: EventBridge（1日1回）→ TopK計算・**101位以降削除**・**閾値(thr)再計算**
- **DynamoDB**
  - **ScoreTable**: `PK=G#${gameId}#P#${period}` / `SK=U#${userId}`（**インデックス無し**）
  - **（任意）IdemTable**: `IdemKey` の短期保持（TTL）
- **CloudFront Functions**
  - `cf-get-start` / `cf-get-end` / `cf-validate`
  - **KeyValueStore (KVS)**: `cfgthr`（ゲーム×期間ごとのしきい値＆並び順ミラー）
- **SSM Parameter 参照**
  - `/htmlgame/front-stack/cf-dist-id`（CloudFront DistributionId）
- **既存 CF Distribution の更新**
  - 既存Distributionへ **FunctionAssociation** の追加/更新（Viewer Request）
  - 実装は **AwsCustomResource + cloudfront****:UpdateDistribution**
  - 既存Distributionへ **FunctionAssociation** の追加/更新（Viewer Request）
  - 実装は **AwsCustomResource + cloudfront****:UpdateDistribution**

---

### 2.1 CDK（lib/score-api-\*）

> **方針**: L3は使わず、スタックは **関数呼び出し**のみ。各関数が **L2（必要時L1）** を生成します。各ブロックに **入力・戻り値・作成リソース・IAM・環境変数・物理ID** を明示します。

#### lib/score-api-stack.ts（スタック本体）

**説明**: スタックの司令塔です。L3は使わず、2.1の関数群（DynamoDB→Lambda→HTTP API→CloudFront Functions→Association→EventBridge）を順に呼び出して、**ScoreTable**、**3つのLambda**、**HTTP API**、**CF Functions + KVS**、（任意で）**日次スケジュール**を構築します。**Outputs は作成せず**、必要情報は **SSM Parameter** にエクスポートします。

- **Input**: apiBasePath（config/paths.json 由来）
- **Reads(SSM)**: CONSTANTS.SSM_PARAMETERS.CF_DIST_ID
- **Creates**: 下記すべてのリソース
- **Writes(SSM)**: CONSTANTS.SSM_PARAMETERS.SCORE_API.* （api-endpoint, table-name, lambda-arns, cf-functions）

#### lib/score-api/ssm.ts（SSM入出力）

**説明**: SSM Parameter Store の **読み出し/書き出し**を行う薄い関数です。命名は `/htmlgame/{スタック名}/{パラメータ名}` に統一し、`config/shared.ts` の `CONSTANTS` を唯一の真実として参照します。余計な `input/` や `export/` のネームスペースは設けません。

- **Interface**: `SsmCtx { stack: Stack }`
- **読み取り**: CloudFront DistributionId を front-stack から参照
- **書き出し**: 本スタックの成果を score-api 名前空間に保存
- **実装**: `lib/score-api/manage-ssm-parameters.ts`

#### lib/score-api/ddb.ts（DynamoDB）

**説明**: **ScoreTable** を 1 つ作成します。キーは `PK=G#${gameId}#P#${period}`, `SK=U#${userId}`。**PAY_PER_REQUEST**、**GSIなし**、**RETAIN**。Top100運用に最適化し、読み書きコストを最小化します。

- **Interface**: `DdbCtx { stack: Stack }`
- **Keys**: PK:`gameName` , SK :`userId`
- **Billing**: PAY_PER_REQUEST
- **実装**: `lib/score-api/create-score-table.ts`

#### lib/score-api/lambdas.ts（Lambda 3種）

**説明**: ランタイムは Node.js 20。以下の 3 関数を作成し、**最小権限**を付与します。

- **PutScoreFn**: 採用判定→テーブル更新→順位変動時のみ **CloudFront Invalidation** 発行。
- **GetRankingFn**: PK Query→ソート→TopN返却。実装側で `Cache-Control: s-maxage, stale-while-revalidate` を付与してキャッシュ効率化。
- **TrimTopFn**: 日次EventBridgeで 101位以降削除＋100位から `thr` を再計算し、**KVS（cfgthr）を更新**。

- **Runtime**: Node.js 20
- **Memory**: 256MB
- **Timeout**: 30秒
- **Bundling**: esbuildで最小化
- **実装**: `lib/score-api/create-lambda-functions.ts` および `cdk/asset/lambdas/*/handler.ts`

#### lib/score-api/api.ts（HTTP API）

**説明**: **HTTP API** を作成し、2 ルートを結線します。

- `PUT {API_BASE_PATH}/scores/{gameId}/{period}/{userId}` → `PutScoreFn`
- `GET {API_BASE_PATH}/ranking/{gameId}/{period}` → `GetRankingFn`

ステージは `prod` 固定で、**低RPSスロットリング**（例: `rate=2, burst=5`）を設定。CORSは必要最小限に（デフォルトは緩め、後で絞る想定）。

- **Stage**: prod
- **Throttling**: rate=2, burst=5
- **CORS**: 必要ヘッダーを許可
- **実装**: `lib/score-api/create-http-api.ts`

#### lib/score-api/cloudfront.ts（CF Functions & Association）

**説明**: **KVS `cfgthr`** と、**CloudFront Functions** 3 種を作成します。既存 Distribution への関連付けは **AwsCustomResource** で **Get→パッチ→Update**（If-Match/ETag）を実行し、**既存のOrigins/Behaviors/Policiesは維持**したまま **FunctionAssociationsのみ upsert** します。JSONパッチはこのファイル内に閉じます。

- **KVS**: cfgthr（閾値データ保存）
- **Functions**: get-start, get-end, validate
- **Association**: AwsCustomResourceで既存Distributionを更新
- **実装**: `lib/score-api/create-cloudfront-functions.ts` および `cdk/asset/cf-funcs/*.js` - **完全実装済み**
- **機能**: KVS統合、HMAC署名、セッション管理、時間整合性チェック、閾値検証

#### lib/score-api/schedule.ts（EventBridge）

**説明**: **日次スケジュール**で `TrimTopFn` を実行します。小規模運用では任意ですが、`thr` 自動更新とデータ整頓のために推奨です。

- **Schedule**: 1日1回
- **Target**: TrimTopFn
- **実装**: `lib/score-api/create-event-schedule.ts`

#### SSMパラメータ（Outputs代替／参照の統一）

**説明**: 後続のフロント/CI/CDが参照する識別子は **SSM Parameter** に書き出します。**命名規則は **`` に統一し、``** の **`` を単一の参照元にします。GitHub Actions も同じキーを使います。

- 参照（既存定義）:
  - `/htmlgame/us-stack/certificate-arn`
  - `/htmlgame/front-stack/s3-bucket`
  - `/htmlgame/front-stack/cf-dist-id`
- 本スタック（score-api）が書き出す推奨キー:
  - `/htmlgame/score-api/api-endpoint`
  - `/htmlgame/score-api/table-name`
  - `/htmlgame/score-api/lambda-put-arn`
  - `/htmlgame/score-api/lambda-get-arn`
  - `/htmlgame/score-api/lambda-trim-arn`
  - `/htmlgame/score-api/cf-functions`（カンマ区切り or JSON）

- **実装**: `writeScoreApiExports` 関数でSSMパラメータに一括出力
- **パラメータ**: api-endpoint, table-name, lambda-arns, cf-functions

---

### 2.2 Asset（Lambda Handlers）

- **put-score/handler.ts**
  - **Input**: APIGW v2 event (Headers: X-Edge-Auth, X-Player, X-Score, Path: {gameId, period, userId})
  - **Process**: 現状取得→採用判定→更新→必要時 CloudFront Invalidation
  - **Output**: `200 { accepted: boolean, rankChanged?: boolean }` / `4xx`
  - **実装**: `cdk/asset/lambdas/put-score/handler.ts`

- **get-ranking/handler.ts**
  - **Input**: APIGW v2 event (Query: limit)
  - **Process**: PK Query→ソート→TopN返却
  - **Output**: `200 { items:[...], topN:number, updatedAt:string }`
  - **実装**: `cdk/asset/lambdas/get-ranking/handler.ts`

- **trim-top/handler.ts**
  - **Input**: EventBridge Schedule event
  - **Process**: 101位以降削除→100位の値から `thr` 再計算→`cfgthr` 更新
  - **Output**: CloudWatch Logs（処理件数/新thr）
  - **実装**: `cdk/asset/lambdas/trim-top/handler.ts`

---

### 2.3 Asset（CloudFront Functions）

- **get-start.js**
  - **Input**: Viewer Request (`/api/get-start`)
  - **Process**: `token_start` 生成、`Set-Cookie: game_sid` 付与
  - **Output**: 直接レスポンス `200 { token_start, exp }`
  - **実装**: `asset/cf-funcs/get-start.js`

- **get-end.js**
  - **Input**: Viewer Request (`/api/get-end`)
  - **Process**: `token_start` 検証＋プレイ時間整合性チェック→`token_end` 発行
  - **Output**: 直接レスポンス `200 { token_end, exp }`
  - **実装**: `asset/cf-funcs/get-end.js`

- **validate.js**
  - **Input**: Viewer Request (`/api/scores/*`)
  - **Process**: `token_end` 検証＋KVS閾値チェック→OKのみOriginへフォワード
  - **Output**: OK=フォワード / NG=4xxレスポンス
  - **実装**: `asset/cf-funcs/validate.js`

---

## 3. CloudFront 関連付け戦略（既存 Distribution を壊さない）

### 3.1 運用前提

- 既存Distributionに **API向けビヘイビア**（例: `/api/*`）があることを前提。
- **静的配信のビヘイビア**（`/*`）には Functions を付けない（誤動作防止）。

### 3.2 結線方針

- **Viewer Request** に以下を紐づけ：
  - `/api/get-start` → `cf-get-start`
  - `/api/get-end`   → `cf-get-end`
  - `/api/scores/*`  → `cf-validate`
- 実装は **AwsCustomResource** で `GetDistributionConfig`→JSONパッチ→`UpdateDistribution`。
  - 既存設定（Origins/Behaviors/Policies）を**完全維持**し、**FunctionAssociations のみ upsert**。
  - ETag を取得し If-Match 指定。**idempotent** な Update。

### 3.3 失敗時のフォールバック

- パッチ適用に失敗した場合は **スタックを失敗**させる（部分更新を避ける）。
- 直前のConfigを **S3へバックアップ**（任意、運用で便利）。

---

## 4. 2段階トークン & KVS（前段防御）

- **呼び出しタイミング**:

  1. **スタート時** → `/api/get-start`（`cf-get-start` が **直レス**）
  2. **クリア時** → `/api/get-end`（`cf-get-end` が **直レス**）
  3. **スコア登録時** → `/api/scores/...`（`cf-validate` が検証→OKのみOriginへ）

- ``: 2段階認証の **1個目トークン** `token_start` を発行。

  - 閾値✅ **なし**。
  - `Set-Cookie: game_sid=<sid>` を発行。レスポンスボディに `token_start` と有効期限。

- ``: `token_start` の**真正性/期限/セッション整合**と、**プレイ時間とタイムスタンプの一致**を検証し、**2個目トークン** `token_end` を発行。

  - 閾値✅ **なし**。

- ``: `/scores` リクエスト時に ``** の検証**を行い、**KVS **``** の閾値**でスコアの妥当性をチェック。

  - OK のみ **Origin（APIGW）へフォワード**。NGは **Functions が 4xx で遮断**。

- **KVS **``: `order`（順位決定優先）, `thr`（TopN下限/上限）, `topN`, `updatedAt` を保持。

  - **日次 **`` が TopN変動に合わせて再計算/更新（CloudFront側で即時参照）。

> Functions は **リクエストボディを参照しない**ため、検証に必要な値は **ヘッダ／Cookie** に集約（`X-Score`, `X-Player`, `X-Sig`, `Cookie: game_sid` 等）。

---

## 5. API 設計（HTTP API）

### 5.1 ルート

- `PUT {API_BASE_PATH}/scores/{gameId}/{period}/{userId}`

  - **Headers**: `X-Token-Start`, `X-Token-End`, `X-Score`, `X-Player`, `X-Sig`, （任意）`X-Idem-Key`
  - **Body**: `{ "meta": { ... } }`（任意）
  - **Lambda**: （1）IdemKeyチェック →（2）現在値取得 →（3）`config/game-config/${gameId}.json` の `sort` で採用判定 →（4）更新 →（5）ランキング変化時のみ CF Invalidate

- `GET {API_BASE_PATH}/ranking/{gameId}/{period}`

  - **Query**: `limit=10..100`（既定100）
  - **Lambda**: PK Query（ページング）→ `sort` に従いソート → 先頭N件 → `Cache-Control: s-maxage=600, stale-while-revalidate=120`

### 5.2 直叩き抑止

- CloudFront → APIGW で固定ヘッダ `X-Edge-Auth: <固定値>` を**Origin Request Policy**で付与。
- Lambda 側で照合。不一致は 403。※ 既存ビヘイビアが未設定なら将来タスク化。

---

## 6. DynamoDB 設計

- **Table**: `ScoreTable`
- **Key**: `PK = G#${gameId}#P#${period}`, `SK = U#${userId}`
- **Attributes**: `score:number`, `timeMs:number`, `userName:string`, `meta:map`, `updatedAt:string`
- **Index**: なし（Top100運用で常時小容量。必要になれば GSI 後付け）
- **更新**: アプリ側比較 → `UpdateExpression` で上書き、（任意）`ver` による楽観ロック
- **日次トリム**: 101位以降を `BatchWrite(Delete)`、100位の値から `thr` 再計算→KVS更新

---

## 7. 設定値＆コスト最適化の勘所

1. **HTTP API 採用**: REST より従量が安く、固定費ゼロ。ステージのレート上限を **低め**に（例 `2 rps / 5 burst`）。
2. **CF Functions で前段完結**: `/get-start` `/get-end` を **オリジンに出さない**。`/scores` も **OK のみ転送**し Lambda 実行を削減。
3. **Top100運用**: 読みは小さく、**インデックス不要**→DDB課金最小。
4. **キャッシュ活用**: `GET /ranking` は **CloudFront キャッシュ**を強制（`s-maxage`）、変化時だけ Invalidate。
5. **KVSの粒度**: `cfgthr#g:${gameId}#p:${period}` に集約し **1キー1KB以下**を維持（コスト/伝播/更新を最小化）。
6. **デプロイ時注入**: 秘密鍵は**ランタイム環境変数不可**→**ビルド注入**＋二重鍵。ソース公開リポジトリには **含めない**。
7. **AwsCustomResource の最小権限**: `cloudfront:GetDistributionConfig` / `UpdateDistribution` / `GetFunction` / `PublishFunction` / `DescribeKeyValueStore` のみ許可。SSM `GetParameter` もスコープ限定。
8. **失敗安全**: CF更新は If-Match（ETag）必須、ロールバック容易化のため **直前ConfigのS3バックアップ**（任意）。
9. **料金目安（個人運用）**: CF Functions \$0〜\$1/月、HTTP APIとLambdaは微少、DDBはTop100維持で数円〜数十円/月。

---



## 9. 運用・デプロイ

- **CI**: OIDC → AssumeRole（`cdk-deploy.yml`）。Secrets から **鍵素材**をビルドに注入（`keys.json` → `get-start.js` 等へ埋め込み）。
- **マイグレーション**: 初回 `TrimTopFn` は **空実行**可能。データが溜まってから本番運用。
- **ローテーション**: `keys.json` の `active` を切替 → `cdk deploy`（両鍵を Functions に保持する実装）
- **モニタ**: APIGW 429・5xx、Lambda エラー、DDB Throttle を CloudWatch アラーム（簡易）。

---

## 10. テスト観点（抜粋）

1. **CF Functions 単体**: ローカルテスト（`cloudfront-js` ランタイム互換）で署名・時刻整合。
2. **E2E（API）**: `/get-start`→`/get-end`→`PUT /scores` の **提出猶予**（例 ≤90秒）検証。
3. **KVS反映**: `TrimTopFn` 後に `cfgthr` が更新され、`validate.js` が閾値で弾けること。
4. **Invalidate**: ランキング変動時のみパス `/ranking/{gameId}/{period}` を無効化。
5. **直叩き拒否**: APIGW直URL（CFバイパス）が 403 になること（`X-Edge-Auth` 未付与）。

---

## 11. タスク（優先度付き）

**P0** - **完了**

- ✅ CDKスタック実装（DynamoDB、Lambda、HTTP API、CloudFront Functions）
- ✅ CloudFront Functions実装（二段階トークン、KVS統合）
- ✅ Lambda関数実装（put-score、get-ranking、trim-top）
- ✅ アクセスログ設定（CloudWatch Logs）
- ✅ CORS設定（自サイト限定）

**P1** - **運用準備**

- KVS初期鍵設定（`scripts/init-kvs-keys.sh`使用）
- CloudFront Distribution Association設定
- 本番デプロイとテスト

**P2** - **監視・運用**

- CloudWatch アラーム設定
- ログ監視ダッシュボード作成

**P3** - **最適化**

- パフォーマンス監視と調整
- コスト最適化

**P4**（将来）

- 複数ゲーム対応
- 高度な不正検知

---

## 12. 既知の制約・リスク

- **既存Distributionの構成前提**（APIビヘイビアの存在）。無い場合は **CDK管理へ移管** or 別Stackで Distribution を L1 で管理する必要あり。
- **Functions はボディ未参照** → **検証はヘッダのみ**。クライアント実装を統一する。
- **KVS 伝播遅延**（数秒〜） → Origin 側で最終判定を継続（二重防御）。
- **HTTP API の機能差**（細粒度レート制限/Usage PlanはREST優位） → 必要になれば移行。

---

### 付録A: ヘッダ規約（/scores）

- `X-Token-Start`, `X-Token-End` … 2段階トークン
- `X-Score: <int>` , `X-Player: <string>` , `X-Sig: <HMAC(T_end, `\${player}|\${score}|\${day}|\${sid}`)>`
- `Cookie: game_sid=<sid>`
- `Origin/Referer: 自サイト`（Functionsで必須）

### 付録B: しきい値（thr）例（cfgthr 値）

```json
{
  "ver": 1,
  "order": [["score","desc"],["timeMs","asc"],["updatedAt","desc"]],
  "thr": [ {"score":{"min":100}}, {"timeMs":{"max":120000}} ],
  "topN": 100,
  "updatedAt": "2025-08-15T12:00:00Z"
}
```



