# Start → Clear → Submit の署名フロー

## 用語
- **KVS 秘密鍵**: `k_current` / `k_prev`（CloudFront Functions からのみ参照）
- **token_start**: start関数が発行。`base64url(payload) + '.' + HMAC(secret, payload_b64)`
- **token_end**: end関数が発行。`base64url(payload) + '.' + HMAC(secret, payload_b64)`
- **sig_k**: end関数が返す一時鍵。`HMAC(secret, token_end + '|' + gid + '|' + uid)`。短命・再計算可能で流出OK。

## 1. Start（/api/get-start/:gid/:uid）
- 入力: `gid`, `uid`
- 出力: `token_start`（`{ gid, uid, t_start(ISOString), max_dur_s, sid, ver }` をHMAC署名）
- クライアント保存: `localStorage("score_session_<gid>")`

## 2. Clear（/api/get-end/:gid/:uid）
- 入力: `token_start`
- 検証:
  - `token_start` の HMACが正しいこと
  - `new Date(t_start)` からの経過時間が `max_dur_s` 内
- 出力:
  - `token_end`（`{ gid, uid, sid, t_end(ISOString), ver }` をHMAC署名）
  - `sig_k` = `HMAC(secret, token_end + '|' + gid + '|' + uid)`
- クライアント保存: `localStorage("score_end_<gid>")`

## 3. Submit（/api/score/:gid/:period/:uid）
- クライアントが付けるHTTPヘッダ:
  - `x-score`, `x-time-ms`, `x-player`, `x-day`（任意の区切り日付, 例: YYYY-MM-DD）
  - `x-token-start`（Startの発行物）
  - `x-token-end`（Endの発行物）
  - `x-sig`（下記で定義）
- **x-sig の生成（クライアント）**:
  - 文字列 `msg = "${player}|${score}|${timeMs}|${day}"`
  - キー: `sig_k`（Endでもらった一時鍵）
  - `sig = HMAC(sig_k, msg)` を base64url で
- CloudFront Functions (validate) は:
  - `token_start` と `token_end` を秘密鍵で検証（HMAC/時間/一致性）
  - サーバ側で `sig_k' = HMAC(secret, token_end + '|' + gid + '|' + uid)` を再計算
  - `expected = HMAC(sig_k', msg)` と `x-sig` を比較
  - KVS のしきい値チェック
  - OK ならオリジン（Lambda PutScore）へ `x-edge-auth` を付与しフォワード
