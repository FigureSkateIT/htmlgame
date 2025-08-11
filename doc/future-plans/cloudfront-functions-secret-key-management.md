はい、その運用がいちばん楽で実用的です。**「デプロイごとにCI/CDからランダム鍵をCloudFront KeyValueStore(KVS)へ投入・ローテーション」**でOKです。

## 方針
- CloudFront FunctionsはKMSやSecrets Managerに直接アクセス不可なので、KVSに鍵を置くのが現実的。
- 関数は実行時にKVSを読み取り検証。
- KVSはCLIで更新可能（ETag利用）。
- 鍵は`k_current`と`k_prev`の二本持ちで切替中のトークンも許容。

## CI/CD手順（例: GitHub Actions）
1. OIDCでAWSロールAssume。
2. ランダム鍵を生成。
3. KVSのETag取得 → `k_prev`を`k_current`で上書き。
4. 新しい鍵を`k_current`にput。
5. FunctionsはKVSから`k_current`と`k_prev`を参照して検証。

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

## Functions側
- Runtime 2.0必須、`require('crypto')`でHMAC計算。
- 検証は`k_current`→失敗したら`k_prev`の順。
- KVSサイズ制限あり（値最大1KB、全体5MB）。
- 関数にKVSを関連付け。

## メリット
- 再デプロイ不要で鍵ローテ。
- 自動ローテで流出リスク低減。
- 解析コスト増。
- CloudFront Functionsだけで低コスト・低レイテンシ。

結論：この運用は安全かつ効率的で、鍵管理のベストプラクティスに近い方法です。