[1] ゲーム終了 (score, timeMs, win)
    |
    v
[2] GetEnd 呼び出し（毎回） // CloudFront Functions
    入力: token_start, score, timeMs, path(:gid/:period/:uid)
    実施: ① 不正検知（HMAC, 有効期間, 乖離チェック）
          ② サーバ閾値チェック（KVS: score/time/date）
    返却: { pass: boolean, reason?, token_end?, t_end?, sig_k?, clear_sig? }

    |
    +--> ①でNG（= 不正）         // reason は下の表参照
    |        |
    |        v
    |    [UI] エラーダイアログ表示（不正検知）
    |    [ローカル] 何も保存しない（recent/top10/ベストも更新しない）
    |    [終わり]
    |
    +--> ①OK && ②NG（= 閾値未達）
    |        |
    |        v
    |    [ローカル] 保存だけ実施（recent 30件維持、top10/ベスト再計算）
    |    [UI] 送信ボタン 非表示（理由を軽く表示可）
    |    [終わり]
    |
    +--> ①OK && ②OK
             |
             v
[3] セッション保存更新（共通: setEndSession）
    - tokenEnd, tEnd, sigK, clearSig を保存
    |
    v
[4] ローカル保存更新（共通: addLocalRecord）
    - recent に追記（最大30件; 古いもの削除）
    - top10 再計算
    - localBest 再計算
    |
    v
[5] 送信ボタンの最終判定
    - 条件（おすすめ簡略）: GetEnd.pass === true && ランキング対象フラグ === true
      （※ローカルの“仮判定”はここでは不要。UX重視で残したいなら AND しても良い）
    -> true なら [UI] 送信ボタン 表示/活性
       false なら 非表示
