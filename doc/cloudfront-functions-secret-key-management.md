# CloudFront Functions 秘密鍵管理（実装済み）

> **実装状況**: KVSを使用した秘密鍵管理が完全実装済みです。GitHub Actionsでの自動ローテーション、CloudFront Functionsでのcryptoモジュールを使用したHMAC-SHA256実装が完了しています。

**「KVSへの秘密鍵保存 + CI/CD自動ローテーション」**方式を採用しました。

## 方針
- CloudFront FunctionsはKMSやSecrets Managerに直接アクセス不可なので、KVSに鍵を置くのが現実的。
- 関数は実行時にKVSを読み取り検証。
- KVSはCLIで更新可能（ETag利用）。
- 鍵は`k_current`と`k_prev`の二本持ちで切替中のトークンも許容。

## CI/CD手順（実装済み）
1. OIDCでAWSロールAssume。
2. ランダム鍵を生成。
3. KVSのETag取得 → `k_prev`を`k_current`で上書き。
4. 新しい鍵を`k_current`にput。
5. FunctionsはKVSから`k_current`と`k_prev`を参照して検証。

**実装ファイル**:
- `.github/workflows/manage-kvs-keys.yml` - 統合KVS鍵管理（初期化・ローテーション）
- `scripts/init-kvs-keys.sh` - ローカル初期鍵設定スクリプト

## CLI例
```bash
ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store \
  --kvs-arn "$KVS_ARN" --query ETag --output text)
CURR=$(aws cloudfront-keyvaluestore get-key \
  --kvs-arn "$KVS_ARN" --key k_current --query Value --output text)
RESP=$(aws cloudfront-keyvaluestore put-key \
  --kvs-arn "$KVS_ARN" --key k_prev --value "$CURR" --if-match "$ETAG")
ETAG=$(echo "$RESP" | jq -r .ETag)
NEW=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
aws cloudfront-keyvaluestore put-key \
  --kvs-arn "$KVS_ARN" --key k_current --value "$NEW" --if-match "$ETAG"
```

## Functions側（実装済み）
- Runtime 2.0で`require('crypto')`を使用したHMAC-SHA256実装。
- 検証は`k_current`→失敗したら`k_prev`の順でフォールバック。
- KVSサイズ制限あり（値最大1KB、全体5MB）。
- 関数にKVSを関連付け。
- 実装ファイル: `asset/cf-funcs/*.js`

## メリット
- 再デプロイ不要で鍵ローテ。
- 自動ローテで流出リスク低減。
- 解析コスト増。
- CloudFront Functionsだけで低コスト・低レイテンシ。

## 運用手順

### 自動運用（推奨）
1. CDKデプロイ後、自動でKVS鍵が初期化
2. 毎日午前2時(UTC)に自動ローテーション
3. 手動実行: GitHub Actionsの"Manage CloudFront Functions KVS Keys"

### ローカル初期化（任意）
```bash
# KVS ARNをSSMから取得
KVS_ARN=$(aws ssm get-parameter --name "/htmlgame/score-api/kvs-arn" --query Parameter.Value --output text)

# 初期鍵設定
./scripts/init-kvs-keys.sh $KVS_ARN
```

結論：この実装は安全かつ効率的で、鍵管理のベストプラクティスに準拠した方法です。