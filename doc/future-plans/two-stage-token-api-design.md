# 二段階トークン方式 API 設計（CloudFront Functions だけで前段完結）

## 0. 目的とスコープ
- **目的**：  
  ① JSを実行しない巡回Bot・curl系の**不正スコア送信を前段でブロック**  
  ② **固定費ゼロ/超低コスト**で運用（WAFなし、Lambda@Edgeなし）  
  ③ **複数ゲームに再利用**できる汎用設計（実装部品化）

- **前段処理はすべて CloudFront Functions で完結**（トークン発行・検証・時刻整合・署名検証）。  
  **保存（登録）はオリジン**（推奨：API Gateway→Lambda→DynamoDB）で実施。  
  ※CloudFront Functions は**外部保存ができない**ため、**「検証 OK のリクエストだけ」**をオリジンへフォワードします。

### この方式で**防げる**こと
- トークン未取得の**直叩き**（curl 等）、**リプレイ**（提出猶予外）、**改ざん**（スコアやプレイヤー名の書き換え）
- **Cookie/Referer なし**や UA が粗い **雑Bot**
- 二段階（開始→終了）を踏まない**時系列不整合**

### この方式で**防げない**こと（割り切り）
- **JSを実行するヘッドレスBot**が**正規フローを忠実に再現**して送信するケース  
  （＝実質「ちゃんとクリアしたのと同義」。本設計の対象外）
- ゲームロジック自体を**クライアント側で偽装**（※必要なら将来、サーバ権威の再計算方式へ）

---

## 1. 全体フロー（2段階トークン＋HMAC）

```
GET /get-start  ->  T_start 発行（Functionsが応答、オリジンへ行かない）
GET /get-end    ->  T_start 弱検証 → T_end 発行（Functionsが応答）
PUT /scores/{day}/{player}
                 ->  ヘッダで T_start/T_end/HMAC/整合性 を Functions が前段検証
                 ->  OK のみオリジンへフォワード（登録）
```

- **T_start**（開始トークン）：長めの期限（例：30分）
- **T_end**（終了トークン）：名前入力を考慮して短中期限（例：2分）
- **提出猶予**：`now_edge - t_end ≤ 90秒`（**送信直前に /get-end を叩く設計**が安定）

> すべての検証は **ヘッダ**で実施（CloudFront Functions は**リクエストボディを読めない**ため）。

---

## 2. トークン仕様

### 2.1 共通
- 形式：`<base64url(payload)>.<hmac>`  
- 署名：`hmac = HMAC_SHA256( K1 , base64url(payload) )`  
- エンコード：**base64url**（`+`,`/`,`=` を使わない）
- **K1** は Functions コード内に埋め込み（公開レポジトリには含めない）

### 2.2 `T_start`（/get-start 応答）
```json
payload_start = {
  "sid": "<ランダム>",           // セッションID
  "t_start": 1733870000000,     // Edge時刻(ms)
  "max_dur_s": 1800,            // 最大プレイ 30分など
  "ver": 1
}
```
- 応答ヘッダで `Set-Cookie: game_sid=<sid>; Path=/; HttpOnly; Secure; SameSite=Strict`
- `Cache-Control: no-store`

### 2.3 `T_end`（/get-end 応答）
```json
payload_end = {
  "sid": "<同じsid>",
  "t_end": 1733870185000,       // Edge時刻(ms)
  "ver": 1
}
```
- リクエストに `token_start` を必須（**クエリ** or **ヘッダ**）。  
- Functions で `T_start` の**署名/期限/sid=Cookie一致**を軽検証してから発行。  
- `Cache-Control: no-store`

---

## 3. エンドポイント仕様

### 3.1 `GET /get-start`
- **リクエスト**：なし
- **レスポンス（200）**：
  ```json
  { "token_start": "<p64>.<hmac>" }
  ```
- **Set-Cookie**：`game_sid` を発行  
- **備考**：ここでオリジンには行かない（Functionsが即応答）

### 3.2 `GET /get-end`
- **リクエスト（いずれか）**  
  - クエリ：`?token_start=<...>`
  - ヘッダ：`X-Token-Start: <...>`
- **Functions の弱検証**  
  - `T_start` の HMAC 正当性  
  - `sid` = Cookie `game_sid`  
  - `0 < now_edge - t_start ≤ max_dur_s*1000`
- **レスポンス（200）**：
  ```json
  { "token_end": "<p64>.<hmac>" }
  ```

### 3.3 `PUT /scores/{day}/{player}`（登録）
- **すべてヘッダで検証**（ボディは任意）
  - `X-Token-Start: <T_start>`
  - `X-Token-End:   <T_end>`
  - `X-Player:      <player>`   （URIと一致推奨）
  - `X-Score:       <int>`
  - `X-Day:         <yyyy-mm-dd>`（URIと一致推奨）
  - `X-Sig:         <HMAC_SHA256( key=T_end , msg=\`${player}|${score}|${day}|${sid}\` )>`
  - `Cookie:        game_sid=<sid>`
  - `Origin/Referer: 自サイト`
  - `Content-Type:  application/json`（ボディは任意：保存補助用）
- **Functions の検証手順**
  1. `T_start` / `T_end` の **HMAC 正当性**（K1 で再計算）  
  2. **sid 三点一致**：`T_start.sid == T_end.sid == Cookie.game_sid`  
  3. **時間整合**：  
     - `0 < t_end - t_start ≤ max_dur_s*1000`  
     - `now_edge - t_end ≤ 90,000 ms`（提出猶予）  
     - （任意）`t_end - t_start ≥ min_dur_s*1000`  
  4. **スコア署名一致**：`X-Sig == HMAC(T_end, player|score|day|sid)`  
  5. **追加**：Origin/Referer 必須、`X-Score` 範囲、`Content-Length` 上限
- **検証 OK**：**そのままオリジンへフォワード**（API GW 側で保存）  
- **検証 NG**：**Functions が 403 を返す**（オリジンへ行かない）

> **冪等/重複排除**をするなら、`X-Idem-Key` を追加（`HMAC(T_end, player|day|score|sid)` 等）。  
> DynamoDB 更新時に**条件付き書込み**（前回より高い時のみ更新＋同一 idem は不更新）で二重登録も防げます。

---

## 4. クライアント側（送信例）

```js
// 1) 開始
const tStart = await (await fetch('/get-start', {cache:'no-store'})).json();

// ... ゲームプレイ ...

// 2) 終了直前（名前入力後/送信直前推奨）
const tEnd = await (await fetch('/get-end?token_start=' + encodeURIComponent(tStart.token_start), {cache:'no-store'})).json();

// 3) 送信（PUT）— 署名は WebCrypto で
const encoder = new TextEncoder();
const msg = `${player}|${score}|${day}|${sid}`;
const key = await crypto.subtle.importKey('raw', encoder.encode(tEnd.token_end), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
const sig = b64url(await crypto.subtle.sign('HMAC', key, encoder.encode(msg)));

await fetch(`/scores/${day}/${encodeURIComponent(player)}`, {
  method: 'PUT',
  headers: {
    'content-type': 'application/json',
    'x-token-start': tStart.token_start,
    'x-token-end':   tEnd.token_end,
    'x-player':      player,
    'x-score':       String(score),
    'x-day':         day,
    'x-sig':         sig,
  },
  body: JSON.stringify({ score, player, day }) // 任意
});
```

> **提出猶予**を守るため、**送信直前に /get-end** を叩く運用が安定。  
> 期限切れなら**自動で再取得→再署名→再送**のリトライをUIで。

---

## 5. オリジン側（保存の指針）
- **API Gateway**（CloudFront 経由のみ許可：カスタムヘッダ/ポリシーで直叩き拒否）
- **Lambda**：ヘッダから値を取り出し保存。  
- **DynamoDB**：  
  - PK 例：`SCORE#${day}#${player}`  
  - **条件付き更新**：  
    - 「前回より高い時だけ更新」  
    - 「同一 idemKey は不更新」  
  - TTL を使い、冪等キーの短期記録で重複をさらに抑制可

---

## 6. パラメータ推奨値（目安）
- `max_dur_s`: 600〜1800（10〜30分、ゲーム次第）  
- `提出猶予`: 60〜90秒（名前入力の余裕）  
- `min_dur_s`: 10〜20秒（ゼロ秒クリア排除したい場合のみ）

---

## 7. 実装メモ（CloudFront Functions の癖）
- **ボディは読めない** → **検証に使うデータはすべてヘッダ**へ  
- **レスポンスを Functions 側で生成**可能（/get-start, /get-end はオリジン不要）  
- **キャッシュ無効**：`Cache-Control: no-store`  
- **ヘッダ合計サイズ**：API GW 目安 10KB 程度。今回のトークンと署名なら余裕  
- **秘密鍵 K1**：関数コードに埋め込み（公開しない）、または KeyValueStore（機微情報は慎重に）

---

## 8. エラーレスポンス（例）
- `400 Bad Request`：ヘッダ欠落・形式不正  
- `401 Unauthorized`：Cookie 不一致 / Origin/Referer 不一致  
- `403 Forbidden`：署名不一致 / 時刻不整合 / 提出猶予超過  
- `413 Payload Too Large`：Content-Length 超過（ヒューリスティック）

---

## 9. コスト
- CloudFront Functions のみで**前段完結**。  
- `/get-start` `/get-end` は**オリジン不要**、`/scores` も **前段検証OKのみ**を転送。  
- 個人規模では**月 数十円〜$1 未満**が現実的（固定費なし）。

---

## 10. まとめ
- **二段階トークン＋HMAC**を**CloudFront Functionsだけ**で前段完結。  
- **ヘッダ設計**に寄せることで、**Lambda@Edgeなし**・**WAFなし**・**固定費ゼロ**を達成。  
- 直叩き・雑Bot・改ざんは**API到達前にブロック**、正規プレイBotは**対象外として割り切り**。  
- 保存はオリジンで冪等＋条件付き更新により**多重クリック/重複/低スコア上書き**を抑止。