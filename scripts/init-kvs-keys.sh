#!/bin/bash

# CloudFront Functions KVS初期鍵設定スクリプト

set -euo pipefail

if [ $# -ne 1 ]; then
    echo "Usage: $0 <KVS_ARN>"
    echo "Example: $0 arn:aws:cloudfront::123456789012:key-value-store/KVXXXXXXXX"
    exit 1
fi

KVS_ARN="$1"

echo "Initializing keys for KVS: $KVS_ARN"

# ETag取得
ETAG=$(aws cloudfront-keyvaluestore describe-key-value-store \
  --kvs-arn "$KVS_ARN" --query ETag --output text)
echo "Current ETag: $ETAG"

# 初期鍵を生成
INITIAL_KEY=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
echo "Generated initial key"

# 初期鍵をcurrentに設定
aws cloudfront-keyvaluestore put-key \
  --kvs-arn "$KVS_ARN" --key k_current --value "$INITIAL_KEY" --if-match "$ETAG"

echo "Initial key setup completed successfully"
echo "You can now deploy your CloudFront Functions"