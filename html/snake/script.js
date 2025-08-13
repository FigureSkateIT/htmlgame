(() => {
    const canvas = document.getElementById('game');
    const ctx = canvas.getContext('2d');
    const scoreEl = document.getElementById('score');
    const statusEl = document.getElementById('status');
    const showGrid = document.getElementById('showGrid');
    const startBtn = document.getElementById('start');
    const btnClear = document.getElementById('btnClear');
    const btnList  = document.getElementById('btnList');
    const btnTop   = document.getElementById('btnTop');
    const gameTimerEl = document.getElementById('gameTimer');
    const effectTimerEl = document.getElementById('effectTimer');
    const baseSpeedSel = document.getElementById('baseSpeed');
    const currentSpeedEl = document.getElementById('currentSpeed');
    const STORAGE = {
    bestScore: 'snakeBestScore',
    bestTimeMs: 'snakeBestTimeMs',
    records: 'snakeRecords' 
    };
    let bestScore = +(localStorage.getItem(STORAGE.bestScore) || 0);
    let bestTimeMs = +(localStorage.getItem(STORAGE.bestTimeMs) || 0); // 0は未記録
    let firstInputPending = false; // 初回入力待ちフラグ（タップ・クリックで開始）

    // Populate base speed selector (10..200)
    const savedBase = +localStorage.getItem('snakeBaseSpeed') || 100;
    for (let s=10; s<=200; s+=10) {
    const opt = document.createElement('option');
    opt.value = s; opt.textContent = s;
    if (s === savedBase) opt.selected = true;
    baseSpeedSel.appendChild(opt);
    }

    // Board settings
    const COLS = 21, ROWS = 13;
    const CELL = Math.floor(Math.min(canvas.width / COLS, canvas.height / ROWS));
    const W = CELL * COLS, H = CELL * ROWS;
    canvas.width = W; canvas.height = H;

    const DIR = { LEFT:{x:-1,y:0,key:['ArrowLeft','a','A']}, UP:{x:0,y:-1,key:['ArrowUp','w','W']}, RIGHT:{x:1,y:0,key:['ArrowRight','d','D']}, DOWN:{x:0,y:1,key:['ArrowDown','s','S']} };

    // Food config
    const FOOD_TYPES = {
    normal: { color: getVar('--food'), points:20, effect: null },
    fast:   { color: getVar('--food-fast'), points:50, effect: {type:'fast', duration:3000} },
    slow:   { color: getVar('--food-slow'), points:30, effect: {type:'slow', duration:3000} },
    };

    let snake, dir, nextDir, foods, score, baseSpeed, speed, playing, dead;
    let effectUntil = 0, effectDelta = 0; // effect timer in ms deadline and delta
    let startTime = 0; // game start timestamp (ms)
    let last = performance.now(), accumulator = 0; // for movement

    function initState() {
    baseSpeed = +baseSpeedSel.value || 100;
    localStorage.setItem('snakeBaseSpeed', baseSpeed);
    speed = baseSpeed; updateSpeedBadge();
      // ★ 初期長さは頭だけ
    const midX = Math.floor(COLS/2), midY = Math.floor(ROWS/2);
    snake = [ {x: midX, y: midY} ];

    dir = DIR.RIGHT; nextDir = DIR.RIGHT;
    score = 0; updateScore();
    foods = spawnInitialFoods();
    effectUntil = 0; effectDelta = 0; updateEffectTimer();
    playing = false; dead = false; accumulator = 0;
    firstInputPending = true;              // ← 追加
    statusEl.textContent = 'Ready — 操作で開始';
    const status2El = document.getElementById('status2');
    if (status2El) status2El.textContent = 'Ready';
    updateGameTimer(0);
    document.body.classList.remove('game-playing');
    }

    function spawnInitialFoods() {
    // 3 normal, 1 fast, 1 slow
    const arr = [];
    const pushType = (type, count) => { for(let i=0;i<count;i++) arr.push(spawnFood(type, arr)); };
    pushType('normal', 10);
    pushType('fast', 3);
    pushType('slow', 3);
    return arr;
    }

    function randomEmptyCell(avoid=[]) {
    let x,y,collides;
    do {
        x = Math.floor(Math.random()*COLS);
        y = Math.floor(Math.random()*ROWS);
        collides = snake.some(s=>s.x===x && s.y===y) || avoid.some(f=>f.x===x && f.y===y);
    } while(collides);
    return {x,y};
    }

    function spawnFood(type, existing) {
    const pos = randomEmptyCell(existing ?? foods ?? []);
    return { type, x: pos.x, y: pos.y };
    }

    function maintainFoodCounts() {
    const counts = {normal:0, fast:0, slow:0};
    foods.forEach(f=>counts[f.type]++);
    const need = { normal: Math.max(0, 5 - counts.normal), fast: Math.max(0, 2 - counts.fast), slow: Math.max(0, 2 - counts.slow) };
    if (need.normal) for(let i=0;i<need.normal;i++) foods.push(spawnFood('normal'));
    if (need.fast) for(let i=0;i<need.fast;i++) foods.push(spawnFood('fast'));
    if (need.slow) for(let i=0;i<need.slow;i++) foods.push(spawnFood('slow'));
    }

    function setDirection(newDir) {
    // ★ まだ開始前（初回入力）なら、その方向で即 Armed→Playing に遷移
    if (firstInputPending && !dead) {
        dir = newDir;
        nextDir = newDir;
        firstInputPending = false;
        playing = true;
        startTime = performance.now();       // ★ ここでタイマースタート
        statusEl.textContent = 'Playing';
        const status2El = document.getElementById('status2');
        if (status2El) status2El.textContent = 'Playing';
        document.body.classList.add('game-playing');
        canvas.focus();
        canvas.tabIndex = 0;
        return;
    } 

    if ((dir===DIR.LEFT && newDir===DIR.RIGHT) || (dir===DIR.RIGHT && newDir===DIR.LEFT) || (dir===DIR.UP && newDir===DIR.DOWN) || (dir===DIR.DOWN && newDir===DIR.UP)) return;
    nextDir = newDir;
    }

    function handleCanvasTap(e) {
        const rect = canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // ヘビ頭の中心座標（ピクセル）
        const head = snake[0];
        const neck = snake.length > 1 ? snake[1] : null;
        const cx = (head.x + 0.5) * CELL;
        const cy = (head.y + 0.5) * CELL;

        const dx = x - cx;
        const dy = y - cy;

        // 現在の進行方向を計算
        if (neck) {
            if (head.x === neck.x) {
                setDirection(dx > 0 ? DIR.RIGHT : DIR.LEFT);
            } else if (head.y === neck.y) {
                setDirection(dy > 0 ? DIR.DOWN : DIR.UP);
            }
        }else{
            if (Math.abs(dx) > Math.abs(dy)) {
                setDirection(dx > 0 ? DIR.RIGHT : DIR.LEFT);
            } else {
                setDirection(dy > 0 ? DIR.DOWN : DIR.UP);
            }
        }
        }

    // Dパッド（画面ボタン）→ setDirection
    function bindDPad() {
        const btns = document.querySelectorAll('.btn-dir');
        btns.forEach(btn => {
            btn.addEventListener('pointerdown', (ev) => {
            const d = btn.getAttribute('data-dir');
            if (d && DIR[d]) setDirection(DIR[d]);
            ev.preventDefault();
            }, {passive:false});
        });
        }

    function fmtSec(ms){ return (ms/1000).toFixed(1) + 's'; }
    function updateBestUI(){
    const bestScoreEl = document.getElementById('bestScore');
    const bestTimeEl  = document.getElementById('bestTime');
    if (bestScoreEl) bestScoreEl.textContent = String(bestScore);
    if (bestTimeEl)  bestTimeEl.textContent  = bestTimeMs ? fmtSec(bestTimeMs) : '—';
    }

    window.addEventListener('keydown', (e) => {
    switch (e.key) {
        case 'ArrowLeft': case 'a': case 'A': setDirection(DIR.LEFT); break;
        case 'ArrowUp': case 'w': case 'W': setDirection(DIR.UP); break;
        case 'ArrowRight': case 'd': case 'D': setDirection(DIR.RIGHT); break;
        case 'ArrowDown': case 's': case 'S': setDirection(DIR.DOWN); break;
        case ' ': initState(); break; // スペースキーでリセット
        case 'r': case 'R': showRecords(); break; // Rキーで最近のスコア
        case 't': case 'T': showLeaderboard(); break; // Tキーでベスト10
        case '-': case '_': changeSpeed(-10); break; // -キーでスピードダウン
        case '+': case '=': changeSpeed(+10); break; // +キーでスピードアップ
    }
    }, {passive:true});

    startBtn.addEventListener('click', () => {
    // Start or Restart
    initState();
    // 初回入力待ち
    //playing = true; statusEl.textContent = 'Playing';
    //startTime = performance.now();
    });

    canvas.addEventListener('pointerdown', handleCanvasTap, {passive:true});
    btnClear?.addEventListener('click', () => {
    if (confirm('ローカル記録（ベスト・履歴）をすべて削除します。よろしいですか？')) {
        clearLocalRecords();
        alert('削除しました');
    }
    });
    btnList?.addEventListener('click', showRecords);
    btnTop?.addEventListener('click', showLeaderboard);

    baseSpeedSel.addEventListener('change', () => {
    // Save preference immediately; will apply next Start
    const val = +baseSpeedSel.value; localStorage.setItem('snakeBaseSpeed', val);
    if (!playing && !dead) { 
        baseSpeed = val;
        speed = val;
        updateSpeedBadge();
    }
    });

    function updateSpeedBadge(){ currentSpeedEl.textContent = `Speed: ${speed}`; }
    
    function changeSpeed(delta) {
        if (!playing && !dead) {
            const newSpeed = Math.max(10, Math.min(200, baseSpeed + delta));
            baseSpeedSel.value = newSpeed;
            baseSpeed = newSpeed;
            speed = newSpeed;
            localStorage.setItem('snakeBaseSpeed', newSpeed);
            updateSpeedBadge();
        }
    }
    function updateScore(){ 
        scoreEl.textContent = score; 
        const score2El = document.getElementById('score2');
        if (score2El) score2El.textContent = score;
    }
    function updateGameTimer(ms){ 
        gameTimerEl.textContent = (ms/1000).toFixed(1)+"s"; 
        const gameTimer2El = document.getElementById('gameTimer2');
        if (gameTimer2El) gameTimer2El.textContent = (ms/1000).toFixed(1)+"s";
    }
    function updateEffectTimer(){
        const text = effectUntil > performance.now() ? 
            (Math.max(0, effectUntil - performance.now())/1000).toFixed(1)+"s" : '—';
        effectTimerEl.textContent = text;
        const effectTimer2El = document.getElementById('effectTimer2');
        if (effectTimer2El) effectTimer2El.textContent = text;
    }

    function applyEffect(effect) {
    if (!effect) return;
    effectUntil = performance.now() + effect.duration;
    
    if (effect.type === 'fast') {
        // スピード50アップまたは2倍のうち、上昇量が少ないほう
        const option1 = baseSpeed + 50;
        const option2 = baseSpeed * 2;
        speed = Math.min(option1, option2);
        effectDelta = speed - baseSpeed;
    } else if (effect.type === 'slow') {
        // スピード50ダウンまたは半減のうち、減少量が少ないほう
        const option1 = baseSpeed - 50;
        const option2 = baseSpeed / 2;
        speed = Math.max(option1, option2);
        effectDelta = speed - baseSpeed;
    }
    
    speed = clamp(speed, 10, 1000);
    updateSpeedBadge();
    }

    function clearEffectIfExpired() {
    if (effectUntil && performance.now() >= effectUntil) {
        effectUntil = 0; effectDelta = 0; speed = baseSpeed; updateSpeedBadge();
    }
    }

    function clamp(v,min,max){ return Math.max(min, Math.min(max,v)); }
    function getVar(name){ return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

    function tick() {
    dir = nextDir;
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (head.x<0 || head.x>=COLS || head.y<0 || head.y>=ROWS) { return gameOver(); }
    if (snake.some((s,i)=> i>0 && s.x===head.x && s.y===head.y)) { return gameOver(); }

    snake.unshift(head);

    // Eat check
    const idx = foods.findIndex(f=> f.x===head.x && f.y===head.y);
    if (idx !== -1) {
        const f = foods.splice(idx,1)[0];
        const cfg = FOOD_TYPES[f.type];
        score += cfg.points; updateScore();
        if (cfg.effect) applyEffect(cfg.effect);
        maintainFoodCounts();
        if (score >= 1000) { score = 1000; return victory(); }
    } else {
        // 蛇の長さが2未満なら尻尾を削除しない（方向制限のため）
        if (snake.length > 2) {
            snake.pop();
        }
    }
    }

    function getRecords(){
    try { return JSON.parse(localStorage.getItem(STORAGE.records) || '[]'); }
    catch { return []; }
    }
    function saveRecords(arr){
    localStorage.setItem(STORAGE.records, JSON.stringify(arr));
    }
    function addRecord(score, elapsedMs, win){
    const recs = getRecords();
    recs.push({
        score,
        timeMs: Math.max(0, Math.floor(elapsedMs||0)),
        win: !!win,
        at: new Date().toISOString()
    });
    saveRecords(recs);
    }

    // 追加：一覧表示（新しい順）
    function showRecords(){
    const recs = getRecords().slice().reverse();
    if (recs.length === 0) { alert('記録はまだありません'); return; }
    const lines = recs.map((r,i)=> {
        const t = fmtSec(r.timeMs);
        const d = r.at.replace('T',' ').slice(0,19);
        return `${i+1}. ${r.score}点 / ${t} / ${r.win?'WIN':'LOSE'} / ${d}`;
    });
    alert(lines.join('\n'));
    }

    // 追加：ベスト10（スコア降順→同点は時間昇順）
    function showLeaderboard(){
    const top = getRecords()
        .slice()
        .sort((a,b)=> (b.score - a.score) || (a.timeMs - b.timeMs))
        .slice(0,10);
    if (top.length === 0) { alert('記録はまだありません'); return; }
    const lines = top.map((r,i)=> `${i+1}. ${r.score}点 / ${fmtSec(r.timeMs)} / ${r.win?'WIN':'LOSE'}`);
    alert(lines.join('\n'));
    }

    function victory(){
    dead = true; playing = false;
    const elapsed = performance.now() - startTime;
    addRecord(score, elapsed, true);

    // ベストスコア更新
    if (score > bestScore) {
        bestScore = score;
        localStorage.setItem(STORAGE.bestScore, String(bestScore));
    }

    // 1000点達成タイムの最短更新（小さいほど良い）
    if (score >= 1000 && (bestTimeMs === 0 || elapsed < bestTimeMs)) {
        bestTimeMs = elapsed;
        localStorage.setItem(STORAGE.bestTimeMs, String(bestTimeMs));
    }

    updateBestUI();
    statusEl.textContent = '🎉 1000点達成!';
    const status2El = document.getElementById('status2');
    if (status2El) status2El.textContent = '🎉 クリア!';
    document.body.classList.remove('game-playing');
    canvas.blur();
    canvas.tabIndex = -1;
    } 
    function gameOver(){
    dead = true; playing = false;
    const elapsed = performance.now() - startTime;  // ← 追加（未定義なら追加）
    addRecord(score, elapsed, false);     

    // ベストスコア更新（達成未満でも上回れば保存）
    if (score > bestScore) {
        bestScore = score;
        localStorage.setItem(STORAGE.bestScore, String(bestScore));
        updateBestUI();
    }

    statusEl.innerHTML = '<span class="bad">Game Over</span>';
    const status2El = document.getElementById('status2');
    if (status2El) status2El.innerHTML = '<span class="bad">Game Over</span>';
    document.body.classList.remove('game-playing');
    canvas.blur();
    canvas.tabIndex = -1;
    }

    function clearLocalRecords(){
    localStorage.removeItem(STORAGE.bestScore);
    localStorage.removeItem(STORAGE.bestTimeMs);
    localStorage.removeItem(STORAGE.records); // ← 追加
    bestScore = 0; bestTimeMs = 0; updateBestUI();
    }

    function draw() {
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = '#0b0e1a'; ctx.fillRect(0,0,W,H);
    if (showGrid.checked) drawGrid();

    // foods
    for (const f of foods) {
        const color = FOOD_TYPES[f.type].color;
        drawCell(f.x, f.y, 0.55, color);
    }

    // snake body
    const bodyColor = getSnakeColor();
    const headColor = getSnakeHeadColor();
    for (let i = snake.length-1; i >= 1; i--) {
        const s = snake[i]; drawCell(s.x, s.y, 0.7, bodyColor);
    }
    const head = snake[0];
    drawCell(head.x, head.y, 0.9, headColor);
    drawEyes(head);
    
    // クリア演出
    if (dead && score >= 1000) {
        drawVictoryEffect();
    }
    }

    function drawGrid(){
    ctx.strokeStyle = getVar('--grid'); ctx.lineWidth = 1; ctx.beginPath();
    for (let x=0; x<=COLS; x++) { ctx.moveTo(x*CELL+0.5,0); ctx.lineTo(x*CELL+0.5,H); }
    for (let y=0; y<=ROWS; y++) { ctx.moveTo(0,y*CELL+0.5); ctx.lineTo(W,y*CELL+0.5); }
    ctx.stroke();
    }

    function drawCell(cx, cy, padScale, color){ const pad=(1-padScale)*CELL*0.5; ctx.fillStyle=color; ctx.fillRect(cx*CELL+pad, cy*CELL+pad, CELL-pad*2, CELL-pad*2); }
    function drawEyes(head){ const cx=head.x*CELL + CELL/2, cy=head.y*CELL + CELL/2; const ex=(dir.x!==0?dir.x:0)*(CELL*0.18), ey=(dir.y!==0?dir.y:0)*(CELL*0.18); ctx.fillStyle='rgba(0,0,0,0.45)'; ctx.beginPath(); ctx.arc(cx-4+ex, cy-4+ey, 3, 0, Math.PI*2); ctx.fill(); ctx.beginPath(); ctx.arc(cx+4+ex, cy-4+ey, 3, 0, Math.PI*2); ctx.fill(); }
    
    function getSnakeColor() {
        if (effectUntil > performance.now()) {
            return effectDelta > 0 ? getVar('--snake-fast') : getVar('--snake-slow');
        }
        return getVar('--snake');
    }
    
    function getSnakeHeadColor() {
        if (effectUntil > performance.now()) {
            return effectDelta > 0 ? getVar('--snake-fast-head') : getVar('--snake-slow-head');
        }
        return getVar('--snake-head');
    }
    
    function drawVictoryEffect() {
        // 半透明の背景
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(0, 0, W, H);
        
        // 大きな絵文字
        ctx.font = '80px serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffd700';
        ctx.fillText('🎉', W/2, H/2 - 20);
        
        // クリア文字
        ctx.font = 'bold 36px sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('クリア！', W/2, H/2 + 40);
    }

    function loop(now){
    const dt = now - last; last = now;
    if (playing && !dead) {
        // Real-time timers independent of speed
        updateGameTimer(now - startTime);
        clearEffectIfExpired(); updateEffectTimer();

        // Movement at variable speed (cells per 10 seconds)
        const step = 10000 / speed; // ms per cell (10秒当たりのマス目進行数)
        accumulator += dt;
        while (accumulator >= step) { accumulator -= step; tick(); }
    }
    draw();
    requestAnimationFrame(loop);
    }

    // --- Boot ---
    initState();
    bindDPad();
    updateBestUI();
    requestAnimationFrame((t)=>{ last=t; requestAnimationFrame(loop); });
})();