/**
 * ワードチェイン(ブラウザ版)の画面。
 *
 * 進行の権威はサーバー(server/room.js)。この画面は操作をサーバーへ送り、
 * サーバーから届く通知({t: 種類, ...})に従って盤面を描き直すだけ。
 * 盤面の計算は共通のルール処理(shared/game.js = WordChain)でサーバーと同じように再現する。
 * ボーナスマス・アイテムマスの位置は隠し情報で、取ったときにだけサーバーから知らされる。
 *
 * プレーヤーは id 'p0'..'p3' で識別。色クラスは roster 内の並び順で決まる。
 * 外から来る文字列(名前・単語・チャット)は textContent で入れる。
 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const BASE = location.pathname.replace(/\/[^/]*$/, ''); // 例: /wordchain
  const LEVEL_LABEL = { weak: '弱い', normal: '普通', strong: '強い', strongest: '最強' };

  // ---------------- 状態 ----------------
  let me = null;              // { username, guest, stats, dict }
  let socket = null;
  let phase = 'home';         // home|lobby|confirm|game|paused|over
  let myId = null;            // 観戦中は null
  let spectator = false;
  let roomCode = null;
  let ownerPid = null;
  let vsCpu = false;
  let roster = [];            // [{id, name, cpuLevel, connected}]  turn順
  let game = null;
  let timeLimitSec = 30;      // 0 = 無制限
  let selection = { r: null, c: null, dir: null };
  let pendingMove = null;     // サーバーの判定待ちの手
  let localProposal = null;   // 辞書に無い単語を承認に出すか考えている手
  let approvalPending = false;
  let cellEls = [];
  let itemTargetMode = null;  // { item:'clear'|'block', playerId } | null
  let clearCountdownTimer = null;
  let rematchMine = false;
  let lastCoop = null;
  let customWords = [];
  let canEditDict = false;

  const timer = { remaining: 0, running: false, intervalId: null, lastTick: 0 };

  // ---------------- 参照ヘルパ ----------------
  function entryOf(id) { return roster.find((p) => p.id === id); }
  function nameOf(id) { const e = entryOf(id); return e ? e.name : id; }
  function slotIndex(id) { return roster.findIndex((p) => p.id === id); }
  function colorOf(id) { const i = slotIndex(id); return 'p' + (i < 0 ? 0 : i); }
  function isOwner() { return !!myId && myId === ownerPid; }

  function isMyInputTurn() {
    if (spectator || !game || game.over || phase !== 'game') return false;
    if (pendingMove || approvalPending || localProposal) return false;
    // 「ブロック」使用確認オファーが解決するまでは、新しい手番はまだ始まっていない
    if (game.pendingBlockOffer) return false;
    return WordChain.currentPlayer(game) === myId;
  }

  // ---------------- 通信 ----------------
  function send(msg) { if (socket) socket.emit('msg', msg); }
  function request(event, data) { return new Promise((resolve) => socket.emit(event, data || {}, resolve)); }

  function setRoomInUrl(code, watch) {
    const url = new URL(location.href);
    url.searchParams.delete('join');
    url.searchParams.delete('watch');
    if (code) url.searchParams.set(watch ? 'watch' : 'join', code);
    history.replaceState(null, '', url);
  }

  // ---------------- 画面/モーダル ----------------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }
  function showModal(id) { $(id).classList.remove('hidden'); }
  function hideModal(id) { $(id).classList.add('hidden'); }
  function hideAllModals() {
    ['modal-word', 'modal-approve', 'modal-confirm', 'modal-disconnect',
      'modal-result', 'modal-overlay', 'modal-notice'].forEach(hideModal);
    hideModal('panel-block-offer'); hideModal('panel-history');
  }
  function notice(text) { $('notice-text').textContent = text; showModal('modal-notice'); }
  function overlay(text, withWaitButtons) {
    $('overlay-text').textContent = text;
    $('overlay-wait-buttons').classList.toggle('hidden', !withWaitButtons);
    showModal('modal-overlay');
  }
  function hideOverlay() { hideModal('modal-overlay'); }
  // 非モーダルのフローティングパネル(ブロック使用確認等)をヘッダー部分のドラッグで移動可能にする
  function makeDraggable(panel, handle) {
    let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      panel.style.left = startLeft + 'px';
      panel.style.top = startTop + 'px';
      panel.style.transform = 'none';
      startX = e.clientX; startY = e.clientY;
      dragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const maxLeft = window.innerWidth - panel.offsetWidth;
      const maxTop = window.innerHeight - panel.offsetHeight;
      panel.style.left = Math.max(0, Math.min(maxLeft, startLeft + (e.clientX - startX))) + 'px';
      panel.style.top = Math.max(0, Math.min(maxTop, startTop + (e.clientY - startY))) + 'px';
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }
  function setStatus(t) { $('game-status').textContent = t; }

  // ---------------- 起動 ----------------
  // ログインは共通ゲームロビーで行う。未ログインならロビーへ行き、ログイン後にこのページへ戻る
  function goLogin() { location.href = `/?next=${encodeURIComponent(location.pathname + location.search)}`; }

  async function init() {
    const res = await fetch(`${BASE}/api/me`, { credentials: 'same-origin' }).then((r) => r.json()).catch(() => ({ ok: false }));
    if (!res.ok) { goLogin(); return; }
    me = res;
    $('home-user').textContent = `${me.username} さん`;
    $('dict-status').textContent = `辞書: ${me.dict.total.toLocaleString()} 語`;
    updateRecordDisplays();
    // ページを離れたらすぐ切断する(サーバーがすぐ気づけるように)
    socket = io({ path: `${BASE}/socket.io`, closeOnBeforeunload: true });
    socket.on('connect_error', (err) => { if (err.message === 'unauthorized') goLogin(); });
    socket.on('msg', onMessage);
    socket.on('connect', onConnect);
  }

  let firstConnect = true;
  async function onConnect() {
    // 接続し直したときは、いた部屋に戻る(サーバーは同じユーザーを同じ席に戻す)
    const params = new URLSearchParams(location.search);
    const code = roomCode || params.get('join') || params.get('watch');
    const watch = spectator || (!roomCode && !!params.get('watch'));
    if (!code) { if (firstConnect) showScreen('screen-home'); firstConnect = false; return; }
    firstConnect = false;
    const r = await request(watch ? 'spectate' : 'join', { code });
    if (!r.ok) { notice(r.error || '部屋に入れませんでした。'); resetToHome(); return; }
    roomCode = code.toUpperCase();
    if (watch && !r.rejoined) spectator = true;
    setRoomInUrl(roomCode, spectator);
  }

  // ---------------- 成績 ----------------
  function recordText() {
    if (!me || me.guest || !me.stats) return me && me.guest ? 'ゲストは成績が保存されません' : '';
    const s = me.stats;
    return `友達戦 ${s.win}勝 ${s.lose}敗 ${s.draw}分 / CPU戦 ${s.cpuWin}勝 ${s.cpuLose}敗 ${s.cpuDraw}分`;
  }
  function updateRecordDisplays() {
    $('home-record').textContent = recordText();
    if (game) $('record-line').textContent = recordText();
  }
  async function refreshStats() {
    const res = await fetch(`${BASE}/api/me`, { credentials: 'same-origin' }).then((r) => r.json()).catch(() => null);
    if (res && res.ok) { me = res; updateRecordDisplays(); $('result-record').textContent = recordText(); }
  }

  // ---------------- タイマー(表示のみ。時間切れの判定はサーバー) ----------------
  // ms < 0 は「無制限」
  function setTimerDisplay(ms, running) {
    if (ms < 0) {
      timer.remaining = -1; timer.running = false;
      if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; }
      updateTimerDisplay();
      return;
    }
    timer.remaining = ms; timer.running = running; timer.lastTick = Date.now();
    if (!timer.intervalId) timer.intervalId = setInterval(tick, 200);
    updateTimerDisplay();
  }
  function stopTimer() { timer.running = false; if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; } }
  function tick() {
    if (timer.running) {
      const now = Date.now();
      timer.remaining = Math.max(0, timer.remaining - (now - timer.lastTick));
      timer.lastTick = now;
    }
    updateTimerDisplay();
  }
  function updateTimerDisplay() {
    if (timeLimitSec <= 0) {
      $('timer-bar').style.width = '100%';
      $('timer-bar').classList.remove('low');
      $('timer-text').textContent = '∞';
      return;
    }
    const rem = Math.max(0, timer.remaining);
    const ratio = Math.min(1, rem / (timeLimitSec * 1000));
    $('timer-bar').style.width = `${ratio * 100}%`;
    $('timer-bar').classList.toggle('low', ratio < 0.25);
    const sec = Math.ceil(rem / 1000);
    $('timer-text').textContent = timeLimitSec >= 60
      ? `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` : `${sec}`;
  }

  // ---------------- 盤面描画 ----------------
  function buildBoardDOM() {
    const board = $('board');
    board.replaceChildren();
    cellEls = [];
    const n = game.size;
    const cell = Math.floor((560 - (n - 1) * 3) / n);
    board.style.gridTemplateColumns = `repeat(${n}, ${cell}px)`;
    board.style.gridTemplateRows = `repeat(${n}, ${cell}px)`;
    const font = Math.max(13, Math.floor(cell * 0.5));
    for (let r = 0; r < n; r++) {
      const row = [];
      for (let c = 0; c < n; c++) {
        const el = document.createElement('div');
        el.className = 'cell';
        el.dataset.r = r; el.dataset.c = c;
        el.style.fontSize = `${font}px`;
        if (game.blocked && game.blocked[r][c]) {
          el.classList.add('obstacle');
        } else {
          const ch = game.board[r][c];
          if (ch) { el.textContent = ch; el.classList.add('filled', game.owner[r][c] ? colorOf(game.owner[r][c]) : 'initial'); }
        }
        board.appendChild(el);
        row.push(el);
      }
      cellEls.push(row);
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.id = 'board-overlay';
    const total = n * cell + (n - 1) * 3 + 20;
    svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
    svg.dataset.cell = cell;
    board.appendChild(svg);
  }
  function drawLastWordLine(move, byId) {
    const svg = $('board-overlay');
    if (!svg) return;
    const cell = Number(svg.dataset.cell);
    const step = cell + 3;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--' + colorOf(byId)).trim() || '#fff';
    const len = [...move.word].length;
    const [dr, dc] = WordChain.DIRS[move.dir];
    const cx = (c) => 10 + cell / 2 + step * c;
    const cy = (r) => 10 + cell / 2 + step * r;
    const x1 = cx(move.c), y1 = cy(move.r);
    const x2 = cx(move.c + dc * (len - 1)), y2 = cy(move.r + dr * (len - 1));
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const aLen = Math.min(18, cell * 0.42), aH = Math.min(8, cell * 0.18);
    const bx = x2 - aLen * Math.cos(ang), by = y2 - aLen * Math.sin(ang);
    const p1x = bx - aH * Math.sin(ang), p1y = by + aH * Math.cos(ang);
    const p2x = bx + aH * Math.sin(ang), p2y = by - aH * Math.cos(ang);
    const f = (v) => v.toFixed(1);
    // 座標と色は数値・CSS変数から作った値だけ(外部の文字列は入らない)
    svg.innerHTML =
      `<g stroke="${color}" fill="${color}" opacity="0.75">` +
      `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(bx)}" y2="${f(by)}" stroke-width="4" stroke-linecap="round"/>` +
      `<circle cx="${f(x1)}" cy="${f(y1)}" r="${Math.min(8, cell * 0.16).toFixed(1)}" stroke="none"/>` +
      `<polygon points="${f(x2)},${f(y2)} ${f(p1x)},${f(p1y)} ${f(p2x)},${f(p2y)}" stroke="none"/></g>`;
  }
  function renderPlaced(placed, byId) {
    // 先頭文字から1文字ずつ、拡大→縮小して置く演出 (+ キラッ音)
    placed.forEach(([r, c], i) => {
      const el = cellEls[r][c];
      el.textContent = game.board[r][c];
      el.classList.add('filled', colorOf(byId));
      el.style.opacity = '0';
      setTimeout(() => {
        el.style.opacity = '';
        el.classList.add('placing');
        Sound.sfx('place');
        setTimeout(() => el.classList.remove('placing'), 460);
      }, i * 110);
    });
    if (placed.length) setTimeout(() => Sound.sfx('word'), placed.length * 110 + 40);
  }
  // 陣取りモードの上書き・ワイルドカードの書き換えなど、既存マスの所有者や文字が変わったセルを再描画する
  function renderCaptured(captured, byId) {
    if (!captured || !captured.length) return;
    for (const [r, c] of captured) {
      const el = cellEls[r][c];
      el.textContent = game.board[r][c];
      el.classList.remove('p0', 'p1', 'p2', 'p3', 'initial');
      el.classList.add(colorOf(byId));
    }
  }
  function renderChain() {
    for (const row of cellEls) for (const el of row) el.classList.remove('chain');
    if (game.chain && !game.over) cellEls[game.chain.r][game.chain.c].classList.add('chain');
  }
  function updateBoardInteractivity() {
    for (const row of cellEls) for (const el of row) el.classList.remove('selectable', 'selected');
    if (isMyInputTurn() && !game.chain) {
      for (const [r, c] of WordChain.startCells(game)) cellEls[r][c].classList.add('selectable');
    }
  }
  // お邪魔マスは毎ターン動くことがあるので盤面全体を都度反映する(ボーナスマスは見えない仕様なので描かない)
  function renderHazards() {
    for (let r = 0; r < game.size; r++) {
      for (let c = 0; c < game.size; c++) {
        cellEls[r][c].classList.toggle('obstacle', !!(game.blocked && game.blocked[r][c]));
      }
    }
  }
  let bonusToastTimer = null;
  function showBonusGet(flatValue, multValue, flatCell, multCell) {
    const parts = [];
    if (flatValue) parts.push(`+${flatValue}`);
    if (multValue) parts.push(`×${multValue}`);
    if (parts.length === 0) return;
    $('bonus-toast').textContent = `ボーナスゲット！${parts.join(' ')}`;
    $('bonus-toast').classList.remove('hidden');
    if (bonusToastTimer) clearTimeout(bonusToastTimer);
    bonusToastTimer = setTimeout(() => $('bonus-toast').classList.add('hidden'), 2400);
    Sound.sfx('bonus');
    for (const cell of [flatCell, multCell]) {
      if (!cell) continue;
      const el = cellEls[cell[0]][cell[1]];
      el.classList.add('bonus-flash');
      setTimeout(() => el.classList.remove('bonus-flash'), 1300);
    }
  }
  const ITEM_LABEL = { clear: 'クリア', block: 'ブロック', wildcard: 'ワイルドカード' };
  let itemGetToastTimer = null;
  // アイテムを入手した瞬間の演出(自分が入手したときだけ)
  function showItemGet(itemsGot) {
    if (!itemsGot) return;
    const names = [];
    for (const kind of ['clear', 'block', 'wildcard']) {
      for (let i = 0; i < (itemsGot[kind] || 0); i++) names.push(ITEM_LABEL[kind]);
    }
    if (names.length === 0) return;
    let i = 0;
    const showNext = () => {
      if (i >= names.length) return;
      $('item-get-toast').textContent = `アイテムGET！${names[i]}`;
      $('item-get-toast').classList.remove('hidden');
      Sound.sfx('itemGet');
      if (itemGetToastTimer) clearTimeout(itemGetToastTimer);
      itemGetToastTimer = setTimeout(() => {
        $('item-get-toast').classList.add('hidden');
        i++;
        if (i < names.length) setTimeout(showNext, 200);
      }, 1600);
    };
    showNext();
  }
  // アイテムの対象選択中、クリア対象(お邪魔マス)/ブロック対象(未入力マス)をハイライトする
  function renderItemTargets() {
    for (let r = 0; r < game.size; r++) for (let c = 0; c < game.size; c++) cellEls[r][c].classList.remove('item-target-clear', 'item-target-block');
    if (!itemTargetMode) return;
    if (itemTargetMode.item === 'clear') {
      for (const [r, c] of WordChain.obstacleCellList(game)) cellEls[r][c].classList.add('item-target-clear');
    } else if (itemTargetMode.item === 'block') {
      for (const [r, c] of WordChain.blockableCells(game)) cellEls[r][c].classList.add('item-target-block');
    }
  }
  // アイテムボタンの表示・所持数表示を更新する(「ブロック」「ワイルドカード」は専用ボタンを持たない)
  function updateItemButtons() {
    const wrap = $('item-buttons');
    const invBox = $('item-inventory');
    if (!game || !game.itemsMode || spectator) { wrap.classList.add('hidden'); invBox.classList.add('hidden'); return; }
    wrap.classList.remove('hidden'); invBox.classList.remove('hidden');
    const busy = !!itemTargetMode;
    const inv = (game.items && game.items[myId]) || { clear: 0, block: 0, wildcard: 0 };
    invBox.textContent = `所持アイテム: クリア${inv.clear} / ブロック${inv.block} / ワイルドカード${inv.wildcard}`;
    const canClear = isMyInputTurn() && !busy && inv.clear > 0 && !game.pendingItemUse;
    $('btn-item-clear').disabled = !canClear;
    $('btn-item-clear').classList.toggle('primary', !!itemTargetMode && itemTargetMode.item === 'clear');
    $('btn-item-cancel').classList.toggle('hidden', !itemTargetMode);
  }
  function renderScores() {
    const box = $('scores');
    box.replaceChildren();
    for (const p of roster) {
      const card = document.createElement('div');
      card.className = 'score-card ' + colorOf(p.id);
      if (!game.over && WordChain.currentPlayer(game) === p.id) card.classList.add('turn-active');
      if (!p.connected || !game.active[p.id]) card.classList.add('disconnected');
      const you = p.id === myId ? ' (あなた)' : '';
      const name = document.createElement('div');
      name.className = 'score-name';
      name.textContent = p.name + you + (p.connected ? '' : ' [切断]');
      const val = document.createElement('div');
      val.className = 'score-value';
      val.textContent = game.scores[p.id];
      card.appendChild(name); card.appendChild(val);
      box.appendChild(card);
    }
  }
  function renderTurn() {
    const cur = WordChain.currentPlayer(game);
    $('turn-indicator').textContent = game.over ? 'ゲーム終了'
      : cur === myId ? 'あなたの番です' : `${nameOf(cur)}の番です`;
  }
  function addHistoryWord(word, byId, h) {
    if (h && h.territoryLosses) {
      // 陣取りモードで他プレーヤーのマスを奪った場合、被害者の減点を先に表示しておく
      for (const [pid, lost] of Object.entries(h.territoryLosses)) {
        const lli = document.createElement('li');
        lli.className = 'territory-loss-entry ' + colorOf(pid);
        lli.textContent = `${nameOf(pid)}さん: -${lost}点`;
        $('history').prepend(lli);
      }
    }
    const li = document.createElement('li');
    li.className = colorOf(byId);
    const pts = h && Number.isFinite(h.points) ? h.points : [...word].length;
    const wildcardNote = h && h.wildcardUsed ? ' (ワイルドカード使用)' : '';
    li.textContent = `${nameOf(byId)}: ${word} (+${pts})${wildcardNote}`;
    $('history').prepend(li);
  }
  function addHistoryPass(byId) {
    const li = document.createElement('li');
    li.className = 'pass-entry';
    li.textContent = `${nameOf(byId)}: パス`;
    $('history').prepend(li);
  }
  function addHistoryItem(byId, item) {
    const li = document.createElement('li');
    li.className = colorOf(byId);
    li.textContent = `${nameOf(byId)}: ${item === 'clear' ? 'クリア使用 (お邪魔マスを解除)' : 'ブロック使用 (お邪魔マスを設置)'}`;
    $('history').prepend(li);
  }
  function refreshAll() {
    renderScores(); renderTurn(); renderChain(); renderHazards();
    $('btn-pass').disabled = !isMyInputTurn();
    $('btn-pass').classList.toggle('hidden', spectator);
    updateBoardInteractivity();
    updateItemButtons();
  }
  function renderRoomCode() {
    $('game-room-code-value').textContent = roomCode || '';
    $('game-room-code').classList.remove('hidden');
  }

  // ---------------- 対戦開始・再同期 ----------------
  function beginGameView(opts) {
    timeLimitSec = opts.timeLimit;
    game = WordChain.newGame({
      size: opts.size, players: opts.playerIds, first: opts.first, timeLimit: opts.timeLimit,
      initialCells: opts.initialCells, initialLetters: opts.initialLetters, obstacleCells: opts.obstacleCells,
      territoryMode: opts.scoringMode === 'territory',
      bonusMode: !!opts.bonusMode, obstacleMove: !!opts.obstacleMove, itemsMode: !!opts.itemsMode,
      itemCells: { clear: [], block: [], wildcard: [] }, // 位置は隠し情報(サーバーだけが知っている)
    });
    itemTargetMode = null;
    pendingMove = null; localProposal = null; approvalPending = false;
    selection = { r: null, c: null, dir: null };
    phase = 'game';
    hideAllModals(); hideDirPanel();
    buildBoardDOM();
    $('history').replaceChildren();
    updateRecordDisplays();
    updateChatVisibility();
    showScreen('screen-game');
    renderRoomCode();
    refreshAll();
  }

  function onResync(m) {
    myId = m.you;
    spectator = !m.you;
    roomCode = m.roomCode || roomCode;
    vsCpu = !!m.vsCpu;
    roster = m.players;
    timeLimitSec = m.timeLimit;
    game = WordChain.newGame({
      size: m.size, initialCells: m.initialCells, initialLetters: Array(m.initialCells.length).fill('あ'),
      players: m.players.map((p) => p.id), first: 0, timeLimit: m.timeLimit,
    });
    game.board = m.board; game.owner = m.owner; game.blocked = m.blocked; game.scores = m.scores;
    game.active = m.active; game.turnIdx = m.turnIdx; game.chain = m.chain;
    game.usedWords = new Set(m.used); game.history = m.history; game.over = m.over;
    game.territoryMode = !!m.territoryMode;
    game.bonusMode = !!m.bonusMode;
    game.obstacleMove = !!m.obstacleMove;
    game.itemsMode = !!m.itemsMode; game.items = m.items || {};
    game.itemCells = { clear: [], block: [], wildcard: [] };
    game.pendingBlockOffer = m.pendingBlockOffer || null;
    game.pendingItemUse = m.pendingItemUse ? { ...m.pendingItemUse, expiresAt: Date.now() + m.pendingItemUse.remainingMs } : null;
    phase = m.phase === 'paused' ? 'paused' : m.over ? 'over' : 'game';
    pendingMove = null; localProposal = null; approvalPending = false; itemTargetMode = null;
    hideAllModals(); hideDirPanel();
    buildBoardDOM();
    $('history').replaceChildren();
    game.history.forEach((h) => { h.pass ? addHistoryPass(h.by) : addHistoryWord(h.word, h.by, h); });
    showScreen('screen-game');
    renderRoomCode();
    updateChatVisibility();
    setTimerDisplay(m.remainingMs, m.running);
    refreshAll();
    if (spectator) setStatus('観戦中です。');
    else if (game.pendingBlockOffer) showBlockOfferModal(game.pendingBlockOffer.playerId);
    else if (m.approval) showApproveModal(m.approval.by, m.approval.word);
    else if (phase === 'paused') overlay('ほかのプレーヤーの接続を待っています...');
    else announceTurn();
  }

  function announceTurn() {
    const cur = WordChain.currentPlayer(game);
    if (spectator) { setStatus(`${nameOf(cur)}の番です(観戦中)`); return; }
    if (cur === myId) {
      Sound.sfx('turn');
      if (!WordChain.hasAnyPlacement(game)) setStatus('置ける場所がありません。パスしてください。');
      else if (game.chain) { setStatus('あなたの番です。方向を選んでください。'); selectCell(game.chain.r, game.chain.c); }
      else setStatus('あなたの番です。初期文字のマスを選んでください。');
    } else {
      const e = entryOf(cur);
      setStatus(e && e.cpuLevel ? `${nameOf(cur)}が考えています...` : `${nameOf(cur)}の番です...`);
    }
  }

  // ---------------- サーバーからの通知 ----------------
  function onMessage(m) {
    if (!m || typeof m.t !== 'string') return;
    switch (m.t) {
      case 'welcome':
        myId = m.you; spectator = false; roomCode = m.roomCode; vsCpu = !!m.vsCpu;
        setRoomInUrl(roomCode, false);
        break;
      case 'lobby':
        roster = m.players; ownerPid = m.owner; vsCpu = !!m.vsCpu;
        if (phase === 'home' || phase === 'lobby' || phase === 'confirm') showLobby();
        break;
      case 'config': showConfirm(m); break;
      case 'notice': notice(m.text || ''); if (phase === 'confirm') { phase = 'lobby'; renderLobby(); } break;
      case 'begin':
        roster = m.players;
        beginGameView({
          size: m.size, initialCells: m.initialCells, initialLetters: m.initialLetters, obstacleCells: m.obstacleCells,
          first: m.first, timeLimit: m.timeLimit, playerIds: m.players.map((p) => p.id), scoringMode: m.scoringMode,
          bonusMode: m.bonusMode, obstacleMove: m.obstacleMove, itemsMode: m.itemsMode,
        });
        break;
      case 'resync': onResync(m); break;
      case 'turn': onTurn(m); break;
      case 'timer': setTimerDisplay(m.remainingMs, m.running); break;
      case 'move-applied': onMoveApplied(m); break;
      case 'pass-applied': onPassApplied(m); break;
      case 'item-applied': onItemApplied(m); break;
      case 'item-rejected': notice(m.reason || 'アイテムを使用できませんでした。'); break;
      case 'item-window-start':
        if (game) {
          const expiresAt = Date.now() + m.remainingMs;
          game.pendingItemUse = { playerId: m.by, item: m.item, expiresAt };
          if (m.by === myId) {
            itemTargetMode = { item: 'clear', playerId: m.by };
            renderItemTargets(); updateItemButtons();
          } else {
            setStatus(`${nameOf(m.by)}が「クリア」を使用中...`);
          }
          startClearCountdownUI(expiresAt);
        }
        break;
      case 'block-offer':
        if (game) { game.pendingBlockOffer = { playerId: m.playerId }; refreshAll(); showBlockOfferModal(m.playerId); }
        break;
      case 'approve-start': if (game) showApproveModal(m.by, m.word); break;
      case 'approve-end': hideModal('modal-approve'); approvalPending = false; break;
      case 'needs-approval': onNeedsApproval(m.word); break;
      case 'move-rejected': handleReject(m.reason); break;
      case 'status': setStatus(m.text || ''); break;
      case 'chat': receiveChat(m.from, m.name || nameOf(m.from), m.text); break;
      case 'game-over': onGameOver(m); break;
      case 'player-disc': { const e = entryOf(m.id); if (e) e.connected = false; if (game) renderScores(); break; }
      case 'player-left': {
        if (game) WordChain.removePlayer(game, m.id);
        const e = entryOf(m.id); if (e) e.connected = false;
        if (game) { refreshAll(); setStatus(`${nameOf(m.id)}を除外して継続します。`); }
        break;
      }
      case 'player-rejoined': { const e = entryOf(m.id); if (e) e.connected = true; if (game) refreshAll(); break; }
      case 'paused':
        if (m.waiting) {
          phase = 'paused';
          if ($('modal-disconnect').classList.contains('hidden') && $('overlay-wait-buttons').classList.contains('hidden')) overlay('ほかのプレーヤーが対応を選んでいます...');
        } else {
          phase = 'game'; hideOverlay(); hideModal('modal-disconnect');
          if (game) { refreshAll(); if (!game.over) announceTurn(); }
        }
        break;
      case 'disc-choice':
        hideOverlay();
        $('disconnect-text').textContent = `${m.name}との接続が切れました。どうしますか?`;
        showModal('modal-disconnect');
        break;
      case 'waiting-rejoin': overlay(`${m.name}の再接続を待っています...`, true); break;
      case 'rematch-lobby': hideAllModals(); game = null; phase = 'lobby'; showLobby(); break;
      case 'rematch-progress': $('rematch-status').textContent = `再戦の同意: ${m.got} / ${m.need}`; break;
      case 'bye': stopTimer(); hideAllModals(); notice('部屋が閉じられました。'); resetToHome(); break;
      default: break;
    }
  }

  function onTurn(m) {
    if (!game) return;
    const idx = game.players.indexOf(m.by);
    if (idx >= 0) game.turnIdx = idx;
    pendingMove = null; localProposal = null; approvalPending = false;
    selection = { r: null, c: null, dir: null };
    itemTargetMode = null;
    game.pendingBlockOffer = null; // 'turn' が届いた時点でオファーは解決済み
    game.pendingItemUse = null;
    stopClearCountdownUI();
    hideDirPanel(); hideModal('modal-word'); hideBlockOfferModal();
    setTimerDisplay(m.remainingMs, true);
    if (Array.isArray(m.obstacleCells)) {
      const size = game.size;
      const blocked = Array.from({ length: size }, () => Array(size).fill(false));
      for (const [r, c] of m.obstacleCells) blocked[r][c] = true;
      game.blocked = blocked;
    }
    refreshAll();
    announceTurn();
  }

  function onMoveApplied(m) {
    if (!game) return;
    const idx = game.players.indexOf(m.by);
    if (idx >= 0) game.turnIdx = idx;
    // サーバーが明かしたボーナスマス・アイテムマス(取ったものだけ)を置いてから、同じルールで適用する
    const b = m.bonus || {};
    game.bonusFlatCell = b.flatCell || null; game.bonusFlatValue = b.flatValue || null;
    game.bonusMultCell = b.multCell || null; game.bonusMultValue = b.multValue || null;
    game.itemCells = { clear: [], block: [], wildcard: [], ...(m.itemHits || {}) };
    const move = { r: m.r, c: m.c, dir: m.dir, word: m.word, wildcardIndex: m.wildcardIndex };
    const { placed, captured, flatValue, multValue, itemsGot } = WordChain.applyMove(game, move, m.by);
    game.itemCells = { clear: [], block: [], wildcard: [] };
    game.bonusFlatCell = null; game.bonusMultCell = null;
    renderPlaced(placed, m.by);
    renderCaptured(captured, m.by);
    drawLastWordLine(move, m.by);
    addHistoryWord(m.word, m.by, game.history[game.history.length - 1]);
    if (m.approved) Sound.sfx('approve');
    if (flatValue || multValue) showBonusGet(flatValue, multValue, b.flatCell, b.multCell);
    if (m.by === myId) showItemGet(itemsGot);
    pendingMove = null;
    refreshAll();
  }

  function onPassApplied(m) {
    if (!game) return;
    const idx = game.players.indexOf(m.by);
    if (idx >= 0) game.turnIdx = idx;
    addHistoryPass(m.by);
    WordChain.applyPass(game);
    pendingMove = null;
    refreshAll();
    setStatus(m.timeout ? `${nameOf(m.by)}が時間切れでパスしました。` : `${nameOf(m.by)}がパスしました。`);
  }

  function onItemApplied(m) {
    if (!game) return;
    WordChain.useItem(game, m.by, m.item, m.r, m.c);
    addHistoryItem(m.by, m.item);
    renderHazards();
    itemTargetMode = null;
    if (m.item === 'clear') {
      stopClearCountdownUI();
      refreshSelectionAfterClear();
    }
    renderItemTargets();
    updateItemButtons();
  }

  function onGameOver(m) {
    if (!game) return;
    if (m.scores) game.scores = m.scores;
    game.over = true;
    lastCoop = m.coop || null;
    stopTimer(); phase = 'over';
    stopClearCountdownUI();
    hideDirPanel(); hideModal('modal-word'); hideModal('modal-approve'); hideBlockOfferModal(); hideOverlay(); hideModal('modal-disconnect');
    refreshAll(); showResult(m.winners || WordChain.winners(game));
    const won = lastCoop ? lastCoop.teamWon : (m.winners || []).includes(myId);
    if (!spectator) Sound.sfx(won ? 'win' : 'lose');
    refreshStats();
  }

  // ---------------- 「クリア」のカウントダウン表示 ----------------
  function startClearItem() {
    if ($('btn-item-clear').disabled) return;
    send({ t: 'use-item-start', item: 'clear' });
  }
  function startClearCountdownUI(expiresAt) {
    const el = $('clear-countdown');
    el.classList.remove('hidden');
    if (clearCountdownTimer) clearInterval(clearCountdownTimer);
    const tick = () => {
      const remain = Math.ceil((expiresAt - Date.now()) / 1000);
      if (remain <= 0) {
        stopClearCountdownUI();
        // 猶予切れ: 対象を選べなかった場合は選択状態を解除する(所持数は開始時点で消費済み)
        if (game) game.pendingItemUse = null;
        if (itemTargetMode && itemTargetMode.item === 'clear') {
          itemTargetMode = null; renderItemTargets(); updateItemButtons();
        }
        return;
      }
      el.textContent = String(remain);
      el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
    };
    tick();
    clearCountdownTimer = setInterval(tick, 1000);
  }
  function stopClearCountdownUI() {
    if (clearCountdownTimer) { clearInterval(clearCountdownTimer); clearCountdownTimer = null; }
    $('clear-countdown').classList.add('hidden');
  }

  // ---------------- 「ブロック」使用確認(相手ターン開始時) ----------------
  function showBlockOfferModal(holderId) {
    if (holderId === myId) {
      $('block-offer-text').textContent = 'あなたは「ブロック」を持っています。使いますか?';
      showModal('panel-block-offer');
    } else {
      setStatus(`${nameOf(holderId)}がブロックの使用を検討中です...`);
    }
  }
  function hideBlockOfferModal() { hideModal('panel-block-offer'); }

  // ---------------- 自分の手・承認 ----------------
  function submitMove(move, propose) {
    pendingMove = move;
    hideModal('modal-word'); hideDirPanel(); updateBoardInteractivity();
    setStatus(propose ? '承認を待っています...' : '判定中...');
    send({ t: 'move', r: move.r, c: move.c, dir: move.dir, word: move.word, wildcardIndex: move.wildcardIndex, propose: !!propose });
  }
  function submitPass() {
    hideModal('modal-word'); hideDirPanel(); pendingMove = null;
    send({ t: 'pass' });
    setStatus('パスしました。');
  }
  // 辞書に無い単語だった: 承認を求めるか本人が選ぶ(その間サーバーは時計を止めている)
  function onNeedsApproval(word) {
    const move = pendingMove;
    pendingMove = null;
    if (!move) return;
    localProposal = move;
    $('word-propose-text').textContent = `「${word}」は単語リストにありません。他のプレーヤーに承認を求めますか?`;
    $('word-propose').classList.remove('hidden');
    $('word-buttons').classList.add('hidden');
    $('word-input').disabled = true;
    showModal('modal-word');
  }
  function handleReject(reason) {
    pendingMove = null; localProposal = null; approvalPending = false;
    Sound.sfx('reject');
    if (!game || WordChain.currentPlayer(game) !== myId) { setStatus(reason || '拒否されました。'); return; }
    setStatus(reason || '拒否されました。別の単語を入力してください。');
    refreshAll();
    if (game.chain) selectCell(game.chain.r, game.chain.c);
  }

  function showApproveModal(proposerId, word) {
    $('approve-caption').textContent = `${nameOf(proposerId)}が辞書にない単語を提案しています:`;
    $('approve-word').textContent = word;
    showModal('modal-approve');
  }
  function onApproveClick(ok) {
    hideModal('modal-approve');
    send({ t: 'approve-vote', ok });
    setStatus('承認結果を送信しました。');
  }

  // ---------------- セル選択・方向・入力 ----------------
  function hideDirPanel() { $('dir-panel').classList.add('hidden'); }
  function selectCell(r, c) {
    if (r === null || c === null) return;
    selection.r = r; selection.c = c; selection.dir = null;
    for (const row of cellEls) for (const el of row) el.classList.remove('selected');
    cellEls[r][c].classList.add('selected');
    $('dir-center').textContent = game.board[r][c];
    document.querySelectorAll('.dir-btn').forEach((b) => { b.disabled = !WordChain.canPlaceDir(game, r, c, Number(b.dataset.dir)); });
    $('dir-panel').classList.remove('hidden');
  }
  function computeWordPatternInfo() {
    const { r, c, dir } = selection;
    const L = WordChain.maxLen(game, r, c, dir);
    const cells = WordChain.rayCells(r, c, dir, L);
    const pat = $('word-pattern'); pat.replaceChildren();
    const fixedIndices = [];
    for (let i = 0; i < L; i++) {
      const [cr, cc] = cells[i];
      const p = document.createElement('div');
      const ch = game.board[cr][cc];
      p.className = 'pcell ' + (ch ? 'fixed' : 'empty');
      p.textContent = ch || '';
      pat.appendChild(p);
      if (ch) fixedIndices.push(i);
    }
    return { L, cells, fixedIndices };
  }
  function openWordModal() {
    const { r, c } = selection;
    const { L, cells, fixedIndices } = computeWordPatternInfo();
    $('word-hint').textContent = `「${game.board[r][c]}」から始まる 2〜${L} 文字。文字がある位置はその文字と一致させてください。`;
    const inp = $('word-input');
    inp.value = ''; inp.maxLength = L * 3; inp.dataset.maxHiragana = String(L); inp.disabled = false;
    $('word-error').textContent = '';
    $('word-propose').classList.add('hidden');
    $('word-buttons').classList.remove('hidden');
    localProposal = null;
    setupWildcardField(fixedIndices, cells);
    showModal('modal-word');
    setTimeout(() => inp.focus(), 50);
  }
  // 方向選択・単語入力を開いたまま「クリア」でお邪魔マスが消えた場合、表示だけを最新の盤面に合わせる
  function refreshSelectionAfterClear() {
    if (selection.r !== null && !$('dir-panel').classList.contains('hidden')) {
      document.querySelectorAll('.dir-btn').forEach((b) => {
        b.disabled = !WordChain.canPlaceDir(game, selection.r, selection.c, Number(b.dataset.dir));
      });
    }
    if (selection.dir !== null && !$('modal-word').classList.contains('hidden')) {
      const { r, c } = selection;
      const { L } = computeWordPatternInfo();
      $('word-hint').textContent = `「${game.board[r][c]}」から始まる 2〜${L} 文字。文字がある位置はその文字と一致させてください。`;
      $('word-input').maxLength = L * 3;
      $('word-input').dataset.maxHiragana = String(L);
    }
  }
  // ワイルドカードを持っていて、経路上に既存の文字があるときだけ、書き換え対象を選ぶ欄を出す
  function setupWildcardField(fixedIndices, cells) {
    const field = $('wildcard-field');
    const select = $('wildcard-select');
    const inv = (game.items && game.items[myId]) || { wildcard: 0 };
    select.replaceChildren();
    const none = document.createElement('option'); none.value = ''; none.textContent = '使わない';
    select.appendChild(none);
    if (!game.itemsMode || inv.wildcard <= 0 || fixedIndices.length === 0) {
      field.classList.add('hidden');
      return;
    }
    for (const i of fixedIndices) {
      const [cr, cc] = cells[i];
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${i + 1}文字目「${game.board[cr][cc]}」を書き換える`;
      select.appendChild(opt);
    }
    field.classList.remove('hidden');
  }
  function submitWord() {
    if (!isMyInputTurn() || selection.dir === null) return;
    const raw = WordChain.romajiToHiragana($('word-input').value.trim(), true);
    const word = WordChain.katakanaToHiragana(raw);
    const wcVal = $('wildcard-field').classList.contains('hidden') ? '' : $('wildcard-select').value;
    const wildcardIndex = wcVal === '' ? undefined : Number(wcVal);
    const move = { r: selection.r, c: selection.c, dir: selection.dir, word, wildcardIndex };
    // 盤面上のルールだけ手元で確かめる(辞書の照合・語尾の判定はサーバーが行う)
    const v = WordChain.validateMove(game, move, null);
    if (!v.ok) { $('word-error').textContent = v.reason; return; }
    $('word-error').textContent = '';
    submitMove(move, false);
  }

  // ---------------- 結果・再戦 ----------------
  function showResult(wins) {
    const ranked = roster.slice().sort((a, b) => game.scores[b.id] - game.scores[a.id]);
    const coop = lastCoop;
    if (coop) {
      $('result-title').textContent = coop.teamWon ? 'チームの勝利!' : (coop.teamTotal === coop.cpuScore ? '引き分け' : 'CPUの勝利...');
    } else if (spectator) {
      $('result-title').textContent = wins.length === 1 ? `${nameOf(wins[0])}の勝ち` : '引き分け';
    } else {
      $('result-title').textContent = wins.includes(myId) ? (wins.length === 1 ? 'あなたの勝ち!' : '引き分け (あなたを含む)') : `${nameOf(wins[0])}の勝ち`;
    }
    const box = $('result-detail'); box.replaceChildren();
    const row = (cls, parts) => {
      const d = document.createElement('div');
      d.className = cls;
      for (const [c, t] of parts) { const s = document.createElement('span'); s.className = c; s.textContent = t; d.appendChild(s); }
      box.appendChild(d);
    };
    if (coop) {
      row('rank-row coop-summary-row' + (coop.teamWon ? ' winner' : ''), [['rank-name', 'チーム合計'], ['rank-score', `${coop.teamTotal} 点`]]);
      row('rank-row coop-summary-row' + (!coop.teamWon && coop.teamTotal !== coop.cpuScore ? ' winner' : ''), [['rank-name', `CPU (${nameOf(coop.cpuId)})`], ['rank-score', `${coop.cpuScore} 点`]]);
    }
    let pos = 1;
    ranked.forEach((p, i) => {
      if (i > 0 && game.scores[p.id] < game.scores[ranked[i - 1].id]) pos = i + 1;
      const you = p.id === myId ? ' (あなた)' : '';
      const unit = game.territoryMode ? '点' : '文字';
      row('rank-row' + (wins.includes(p.id) ? ' winner' : ''), [['rank-pos', `${pos}位`], [`rank-name ${colorOf(p.id)}`, p.name + you], ['rank-score', `${game.scores[p.id]} ${unit}`]]);
    });
    $('result-record').textContent = recordText();
    rematchMine = false;
    $('btn-rematch').disabled = false;
    $('btn-rematch').classList.toggle('hidden', spectator);
    $('rematch-status').textContent = spectator ? '' : vsCpu ? '' : '再戦には全員の同意が必要です。';
    showModal('modal-result');
  }
  function onRematchClick() {
    if (rematchMine || spectator) return;
    rematchMine = true; $('btn-rematch').disabled = true;
    send({ t: 'rematch-vote' });
    if (!vsCpu) $('rematch-status').textContent = 'あなたは再戦に同意しました。他のプレーヤーを待っています...';
  }

  // ================= ロビー(部屋の待機画面) =================
  function showLobby() {
    phase = phase === 'confirm' ? 'confirm' : 'lobby';
    hideModal('modal-result');
    $('lobby-title').textContent = isOwner() ? '参加者を待っています' : '入室しました';
    $('lobby-code').textContent = roomCode || '';
    $('lobby-code-wrap').classList.remove('hidden');
    $('lobby-host-controls').classList.toggle('hidden', !isOwner());
    $('btn-lobby-start').classList.toggle('hidden', !isOwner());
    updateSizeLabel();
    renderLobby();
    updateChatVisibility();
    showScreen('screen-lobby');
  }
  function renderLobby() {
    const ul = $('lobby-roster'); ul.replaceChildren();
    roster.forEach((p) => {
      const li = document.createElement('li');
      const dot = document.createElement('span'); dot.className = 'roster-dot ' + colorOf(p.id);
      const nm = document.createElement('span'); nm.textContent = p.name;
      li.appendChild(dot); li.appendChild(nm);
      if (p.id === myId) { const y = document.createElement('span'); y.className = 'roster-you'; y.textContent = 'あなた'; li.appendChild(y); }
      if (p.id === ownerPid) { const h = document.createElement('span'); h.className = 'roster-host'; h.textContent = '部屋主'; if (p.id !== myId) h.style.marginLeft = 'auto'; li.appendChild(h); }
      ul.appendChild(li);
    });
    const n = roster.length;
    if (isOwner()) {
      if (phase === 'confirm') { $('lobby-status').textContent = 'ほかの参加者の確認を待っています...'; $('btn-lobby-start').disabled = true; return; }
      $('lobby-status').textContent = n < 2 ? '参加者を待っています...(最低2人)' : `${n}人が参加中。設定を決めて開始できます。`;
      $('btn-lobby-start').disabled = n < 2;
    } else {
      $('lobby-status').textContent = `${nameOf(ownerPid)}が設定を決めて開始するのを待っています...`;
    }
  }
  function collectSettings(prefix) {
    const v = (id) => $(`${prefix}-${id}`);
    return {
      size: WordChain.clampSize($(prefix === 'lobby' ? 'size-range' : 'offline-size-range').value),
      timeLimit: Number(v('time').value),
      placementMode: v('placement').value,
      initialCount: Number(v('initial-count').value),
      obstacles: v('obstacles').checked,
      obstacleCount: Number(v('obstacle-count').value),
      obstacleMove: v('obstacles').checked && v('obstacle-move').checked,
      scoringMode: v('scoring-mode').value,
      bonusMode: v('bonus-mode').checked,
      itemsMode: v('items-mode').checked,
      itemClearCount: Number(v('item-clear-count').value),
      itemBlockCount: Number(v('item-block-count').value),
      itemWildcardCount: Number(v('item-wildcard-count').value),
      coopMode: v('coop-mode').checked,
      coopCpuLevel: v('coop-cpu-level').value,
    };
  }
  function ownerStartGame() {
    if (!isOwner() || roster.length < 2) return;
    const s = collectSettings('lobby');
    if (s.coopMode && roster.length >= WordChain.MAX_PLAYERS) {
      notice(`協力モードはCPUの1枠を確保するため、参加者は最大${WordChain.MAX_PLAYERS - 1}人までです。`);
      return;
    }
    phase = 'confirm';
    renderLobby();
    send({ t: 'start-config', settings: s });
  }
  function timeText(s) { if (s <= 0) return '無制限'; return s >= 60 ? `${s / 60}分` : `${s}秒`; }
  function showConfirm(m) {
    phase = 'confirm';
    roster = m.players;
    const names = m.players.map((p) => p.name + (p.id === myId ? '(あなた)' : '')).join('、');
    const rows = [
      ['盤面サイズ', `${m.size} × ${m.size}`],
      ['入力時間', timeText(m.timeLimit)],
      ['初期文字の配置', m.placementMode === 'random' ? 'ランダム' : 'デフォルト (中央)'],
      ['初期文字の数', `${m.initialCount} マス`],
      ['お邪魔マス', m.obstacles ? `あり (${m.obstacleCount}マス${m.obstacleMove ? '・移動あり' : ''})` : 'なし'],
      ['対戦モード', m.scoringMode === 'territory' ? '陣取りモード' : '通常モード'],
      ['ボーナスマス', m.bonusMode ? 'あり' : 'なし'],
      ['アイテム', m.itemsMode ? `あり (クリア${m.itemClearCount}・ブロック${m.itemBlockCount}・ワイルドカード${m.itemWildcardCount}を盤面に配置)` : 'なし'],
      ['協力モード', m.coopMode ? `あり (CPU 1体 vs プレーヤー全員、強さ: ${LEVEL_LABEL[m.coopCpuLevel] || '普通'})` : 'なし'],
      [`参加者 (${m.players.length}人)`, names],
    ];
    const box = $('confirm-detail'); box.replaceChildren();
    for (const [k, v] of rows) {
      const d = document.createElement('div'); d.className = 'row';
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('span'); b.textContent = v;
      d.appendChild(a); d.appendChild(b); box.appendChild(d);
    }
    showModal('modal-confirm');
  }

  // ---------------- 共通遷移 ----------------
  function resetToHome() {
    stopTimer();
    stopClearCountdownUI();
    game = null; phase = 'home'; roster = []; myId = null; spectator = false; roomCode = null; ownerPid = null; vsCpu = false;
    pendingMove = null; localProposal = null; approvalPending = false;
    updateRecordDisplays();
    closeChat(); updateChatVisibility();
    hideAllModals();
    setRoomInUrl(null);
    showScreen('screen-home');
  }
  async function leaveRoom() {
    stopTimer(); hideAllModals();
    await request('leave');
    resetToHome();
  }

  // ================= チャット =================
  let chatUnread = 0;
  function updateChatVisibility() {
    const show = !spectator && !!myId && phase !== 'home' && !!game;
    $('chat-bubble').classList.toggle('hidden', !show);
    if (!show) { $('chat-panel').classList.add('hidden'); }
  }
  function openChat() {
    $('chat-panel').classList.remove('hidden');
    chatUnread = 0; $('chat-badge').classList.add('hidden');
    setTimeout(() => $('chat-input').focus(), 30);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  }
  function closeChat() { $('chat-panel').classList.add('hidden'); $('chat-log').replaceChildren(); chatUnread = 0; $('chat-badge').classList.add('hidden'); hideModal('chat-toast'); }
  function toggleChat() { $('chat-panel').classList.contains('hidden') ? openChat() : $('chat-panel').classList.add('hidden'); }
  function appendChatLine(fromId, name, text, mine) {
    const li = document.createElement('li');
    li.className = (mine ? 'mine ' : '') + colorOf(fromId);
    const n = document.createElement('div'); n.className = 'chat-name'; n.textContent = mine ? 'あなた' : name;
    const b = document.createElement('div'); b.className = 'chat-msg'; b.textContent = text;
    li.appendChild(n); li.appendChild(b);
    $('chat-log').appendChild(li);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  }
  let toastTimer = null;
  function receiveChat(fromId, name, text) {
    appendChatLine(fromId, name, text, false);
    Sound.sfx('chat');
    const toast = $('chat-toast');
    toast.replaceChildren();
    const tn = document.createElement('div'); tn.className = 'chat-toast-name'; tn.textContent = name;
    const tm = document.createElement('div'); tm.className = 'chat-toast-msg'; tm.textContent = text;
    toast.appendChild(tn); toast.appendChild(tm);
    toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 4200);
    if ($('chat-panel').classList.contains('hidden')) {
      chatUnread++;
      const badge = $('chat-badge');
      badge.textContent = chatUnread > 9 ? '9+' : String(chatUnread);
      badge.classList.remove('hidden');
    }
  }
  function sendChat() {
    const input = $('chat-input');
    const text = input.value.trim().slice(0, 200);
    if (!text || !myId) return;
    input.value = '';
    appendChatLine(myId, nameOf(myId), text, true);
    send({ t: 'chat', text });
  }

  // ================= 設定 (音量・辞書) =================
  async function openSettings() {
    $('settings-error').textContent = ''; $('settings-add-input').value = ''; $('settings-filter').value = '';
    const bv = Math.round(Sound.getBgmVolume() * 100);
    const sv = Math.round(Sound.getSfxVolume() * 100);
    $('vol-bgm').value = bv; $('vol-bgm-label').textContent = bv + '%';
    $('vol-sfx').value = sv; $('vol-sfx-label').textContent = sv + '%';
    showScreen('screen-settings');
    adoptDictList(await request('dict-list'));
  }
  function adoptDictList(r) {
    if (!r || !Array.isArray(r.words)) return;
    customWords = r.words;
    if (typeof r.canEdit === 'boolean') canEditDict = r.canEdit;
    if (r.info) $('dict-status').textContent = `辞書: ${r.info.total.toLocaleString()} 語`;
    $('settings-add-input').disabled = !canEditDict;
    $('btn-settings-add').disabled = !canEditDict;
    renderSettingsList(r.updatedAt);
  }
  let dictUpdatedAt = 0;
  function renderSettingsList(updatedAt) {
    if (updatedAt !== undefined) dictUpdatedAt = updatedAt;
    const filter = WordChain.katakanaToHiragana($('settings-filter').value.trim());
    const shown = filter ? customWords.filter((w) => w.includes(filter)) : customWords;
    const list = $('settings-word-list'); list.replaceChildren();
    const dt = dictUpdatedAt ? new Date(dictUpdatedAt).toLocaleString('ja-JP') : 'なし';
    $('settings-meta').textContent = `追加済み: ${customWords.length} 語 (表示 ${shown.length}) / 最終更新: ${dt}${canEditDict ? '' : ' / ゲストは閲覧のみ'}`;
    if (shown.length === 0) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = customWords.length === 0 ? 'まだ追加された単語はありません。' : '該当する単語がありません。';
      list.appendChild(li); return;
    }
    for (const w of shown.slice(0, 500)) {
      const li = document.createElement('li');
      const span = document.createElement('span'); span.textContent = w;
      li.appendChild(span);
      if (canEditDict) {
        const del = document.createElement('button'); del.className = 'word-del'; del.textContent = '削除';
        del.addEventListener('click', () => removeSettingsWord(w));
        li.appendChild(del);
      }
      list.appendChild(li);
    }
  }
  async function addSettingsWord() {
    const word = WordChain.katakanaToHiragana(WordChain.romajiToHiragana($('settings-add-input').value.trim(), true));
    const r = await request('dict-add', { word });
    if (!r.ok) { $('settings-error').textContent = r.error || '追加できませんでした。'; return; }
    $('settings-error').textContent = ''; $('settings-add-input').value = '';
    adoptDictList(r);
    $('settings-add-input').focus();
  }
  async function removeSettingsWord(word) {
    if (!confirm(`「${word}」を辞書から削除しますか?(全員の辞書から消えます)`)) return;
    const r = await request('dict-remove', { word });
    if (!r.ok) { $('settings-error').textContent = r.error || '削除できませんでした。'; return; }
    adoptDictList(r);
  }

  // ローマ字直接入力→ひらがな即時変換 (OSのIME変換候補に頼らない)。IME変換中は何もしない
  function liveRomajiConvert(el, maxHiragana, isComposing) {
    if (isComposing) return;
    const raw = el.value;
    let converted = WordChain.romajiToHiragana(raw, false);
    if (typeof maxHiragana === 'number' && [...converted].length > maxHiragana) {
      converted = [...converted].slice(0, maxHiragana).join('');
    }
    if (converted !== raw) el.value = converted;
  }

  // お邪魔マスの数は盤面サイズが変わるたびに上限(全マスの20%)を更新する
  function updateObstacleCountMax(sizeInputId, countInputId, maxLabelId) {
    const size = WordChain.clampSize($(sizeInputId).value);
    const cap = WordChain.maxObstacleCount(size);
    const input = $(countInputId);
    input.max = String(cap);
    if (Number(input.value) > cap) input.value = String(cap);
    if (Number(input.value) < 1 || !input.value) input.value = '1';
    $(maxLabelId).textContent = String(cap);
  }
  function updateSizeLabel() {
    const v = $('size-range').value; $('size-label').textContent = `${v} × ${v}`;
    updateObstacleCountMax('size-range', 'lobby-obstacle-count', 'lobby-obstacle-count-max');
  }
  function updateOfflineSizeLabel() {
    const v = $('offline-size-range').value; $('offline-size-label').textContent = `${v} × ${v}`;
    updateObstacleCountMax('offline-size-range', 'offline-obstacle-count', 'offline-obstacle-count-max');
  }
  // 初期文字の配置(デフォルト/ランダム)によって選べる「初期文字の数」が変わる
  function populateInitialCountOptions(sel, placement) {
    const opts = placement === 'random' ? Array.from({ length: 10 }, (_, i) => i + 1) : [1, 4];
    const prev = Number(sel.value);
    sel.replaceChildren();
    const fallback = opts.includes(4) ? 4 : opts[opts.length - 1];
    for (const n of opts) {
      const o = document.createElement('option');
      o.value = String(n); o.textContent = `${n}マス`;
      if (n === (opts.includes(prev) ? prev : fallback)) o.selected = true;
      sel.appendChild(o);
    }
  }

  // ================= イベント配線 =================
  $('btn-goto-create').addEventListener('click', async () => {
    const r = await request('create', { vsCpu: false });
    if (!r.ok) { notice(r.error || '部屋を作れませんでした。'); return; }
    roomCode = r.roomCode;
    setRoomInUrl(roomCode, false);
  });
  $('btn-goto-join').addEventListener('click', () => { $('join-code').value = ''; $('join-error').textContent = ''; showScreen('screen-join'); $('join-code').focus(); });
  $('btn-goto-offline').addEventListener('click', () => { updateOfflineSizeLabel(); populateInitialCountOptions($('offline-initial-count'), $('offline-placement').value); showScreen('screen-offline'); });
  $('btn-goto-settings').addEventListener('click', openSettings);
  $('btn-join-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-offline-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-settings-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-settings-add').addEventListener('click', addSettingsWord);
  $('settings-add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) addSettingsWord(); });
  $('settings-add-input').addEventListener('input', (e) => liveRomajiConvert($('settings-add-input'), WordChain.SIZE_MAX, e.isComposing));
  $('settings-filter').addEventListener('input', (e) => { liveRomajiConvert($('settings-filter'), undefined, e.isComposing); renderSettingsList(); });
  $('size-range').addEventListener('input', updateSizeLabel);
  $('offline-size-range').addEventListener('input', updateOfflineSizeLabel);
  $('lobby-placement').addEventListener('change', () => populateInitialCountOptions($('lobby-initial-count'), $('lobby-placement').value));
  $('offline-placement').addEventListener('change', () => populateInitialCountOptions($('offline-initial-count'), $('offline-placement').value));
  populateInitialCountOptions($('lobby-initial-count'), $('lobby-placement').value);
  populateInitialCountOptions($('offline-initial-count'), $('offline-placement').value);

  $('btn-offline-start').addEventListener('click', async () => {
    const s = collectSettings('offline');
    s.cpuCount = Number($('offline-cpu-count').value);
    s.cpuLevel = $('offline-cpu-level').value;
    const r = await request('create', { vsCpu: true, settings: s });
    if (!r.ok) { notice(r.error || '対戦を始められませんでした。'); return; }
    roomCode = r.roomCode;
    setRoomInUrl(roomCode, false);
  });

  // お邪魔マスの数(選択欄)は、チェックボックスがONのときだけ表示
  for (const prefix of ['lobby', 'offline']) {
    $(`${prefix}-obstacles`).addEventListener('change', () => {
      const on = $(`${prefix}-obstacles`).checked;
      $(`${prefix}-obstacle-count-field`).classList.toggle('hidden', !on);
      $(`${prefix}-obstacle-move-field`).classList.toggle('hidden', !on);
    });
    $(`${prefix}-obstacle-count`).addEventListener('input', () => {
      const sizeId = prefix === 'lobby' ? 'size-range' : 'offline-size-range';
      const cap = WordChain.maxObstacleCount(WordChain.clampSize($(sizeId).value));
      const el = $(`${prefix}-obstacle-count`);
      if (Number(el.value) > cap) el.value = String(cap);
    });
    $(`${prefix}-items-mode`).addEventListener('change', () => {
      $(`${prefix}-item-counts-field`).classList.toggle('hidden', !$(`${prefix}-items-mode`).checked);
    });
  }
  // CPU対戦で協力モードにしたら、通常のCPU設定を隠して協力モードCPUの強さを出す
  $('offline-coop-mode').addEventListener('change', () => {
    const on = $('offline-coop-mode').checked;
    $('offline-opponent-field').classList.toggle('hidden', on);
    $('offline-cpu-level-field').classList.toggle('hidden', on);
    $('offline-coop-cpu-level-field').classList.toggle('hidden', !on);
  });
  $('lobby-coop-mode').addEventListener('change', () => {
    $('lobby-coop-cpu-level-field').classList.toggle('hidden', !$('lobby-coop-mode').checked);
  });
  // アイテムの回数は0〜9に収める
  for (const id of [
    'offline-item-clear-count', 'offline-item-block-count', 'offline-item-wildcard-count',
    'lobby-item-clear-count', 'lobby-item-block-count', 'lobby-item-wildcard-count',
  ]) {
    $(id).addEventListener('input', () => {
      const el = $(id);
      const n = Number(el.value);
      if (Number.isNaN(n) || n < 0) el.value = '0';
      else if (n > 9) el.value = '9';
    });
  }

  // 音量
  $('vol-bgm').addEventListener('input', (e) => { const v = Number(e.target.value); $('vol-bgm-label').textContent = v + '%'; Sound.setBgmVolume(v / 100); });
  $('vol-sfx').addEventListener('input', (e) => { const v = Number(e.target.value); $('vol-sfx-label').textContent = v + '%'; Sound.setSfxVolume(v / 100); });
  $('vol-sfx').addEventListener('change', () => Sound.sfx('button'));

  // チャット
  $('chat-bubble').addEventListener('click', toggleChat);
  $('chat-close').addEventListener('click', () => $('chat-panel').classList.add('hidden'));
  $('chat-send').addEventListener('click', sendChat);
  $('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) sendChat(); });
  $('chat-toast').addEventListener('click', () => $('chat-toast').classList.add('hidden'));

  // 最初のユーザー操作で音声を有効化しBGM開始 + ボタン効果音
  let audioUnlocked = false;
  document.addEventListener('click', (e) => {
    if (!audioUnlocked) { audioUnlocked = true; try { Sound.unlock(); Sound.startBgm(); } catch { /* 音が出せない環境 */ } }
    const b = e.target.closest && e.target.closest('.btn, .dir-btn, .word-del');
    if (b && !b.disabled) Sound.sfx('button');
  }, true);

  $('btn-join').addEventListener('click', async () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) { $('join-error').textContent = '部屋コードは6文字の英数字です。'; return; }
    $('join-error').textContent = '';
    const r = await request('join', { code });
    if (!r.ok) { $('join-error').textContent = r.error || '入れませんでした。'; return; }
    roomCode = code;
  });
  $('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('btn-copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('lobby-code').textContent); $('lobby-status').textContent = 'コピーしました。'; }
    catch { $('lobby-status').textContent = 'コピーに失敗しました。手動で控えてください。'; }
  });
  $('btn-lobby-invite').addEventListener('click', () => {
    if (window.LobbyBar && window.LobbyBar.socket) window.LobbyBar.openInvite({ game: 'wordchain', roomId: roomCode });
    else notice('ゲームロビーにつながっていません。部屋コードを伝えてください。');
  });
  $('btn-lobby-start').addEventListener('click', ownerStartGame);
  $('btn-lobby-back').addEventListener('click', leaveRoom);

  $('btn-confirm-ok').addEventListener('click', () => { hideModal('modal-confirm'); overlay('開始を待っています...'); send({ t: 'config-ack' }); });
  $('btn-confirm-leave').addEventListener('click', leaveRoom);

  $('btn-disc-wait').addEventListener('click', () => { hideModal('modal-disconnect'); send({ t: 'disc-choice', choice: 'wait' }); });
  $('btn-disc-continue').addEventListener('click', () => { hideModal('modal-disconnect'); send({ t: 'disc-choice', choice: 'continue' }); });
  $('btn-disc-end').addEventListener('click', () => { hideModal('modal-disconnect'); send({ t: 'disc-choice', choice: 'end' }); });
  $('btn-wait-continue').addEventListener('click', () => { hideOverlay(); send({ t: 'disc-choice', choice: 'continue' }); });
  $('btn-wait-end').addEventListener('click', () => { hideOverlay(); send({ t: 'disc-choice', choice: 'end' }); });

  $('btn-leave').addEventListener('click', () => {
    if (!spectator && game && !game.over && !confirm('対戦から退出しますか?(残りの人で対戦が続きます)')) return;
    leaveRoom();
  });
  $('btn-pass').addEventListener('click', () => { if (isMyInputTurn()) submitPass(); });
  $('btn-history').addEventListener('click', () => showModal('panel-history'));
  $('btn-history-close').addEventListener('click', () => hideModal('panel-history'));
  makeDraggable($('panel-block-offer'), $('block-offer-head'));

  $('board').addEventListener('click', (e) => {
    const el = e.target.closest('.cell');
    if (!el || !game) return;
    const r = Number(el.dataset.r), c = Number(el.dataset.c);
    if (itemTargetMode) {
      const { item } = itemTargetMode;
      send({ t: 'use-item', item, r, c });
      itemTargetMode = null;
      renderItemTargets(); updateItemButtons();
      return;
    }
    if (!isMyInputTurn() || game.chain) return;
    if (!WordChain.startCells(game).some(([sr, sc]) => sr === r && sc === c)) return;
    selectCell(r, c);
  });
  $('btn-item-clear').addEventListener('click', startClearItem);
  $('btn-item-cancel').addEventListener('click', () => {
    itemTargetMode = null;
    renderItemTargets(); updateItemButtons();
  });
  $('btn-block-offer-yes').addEventListener('click', () => {
    hideBlockOfferModal();
    const holderId = game && game.pendingBlockOffer && game.pendingBlockOffer.playerId;
    if (!holderId) return;
    itemTargetMode = { item: 'block', playerId: holderId };
    renderItemTargets(); updateItemButtons();
  });
  $('btn-block-offer-no').addEventListener('click', () => {
    hideBlockOfferModal();
    if (!game || !game.pendingBlockOffer) return;
    send({ t: 'decline-block-offer' });
  });
  document.querySelectorAll('.dir-btn').forEach((b) => {
    b.addEventListener('click', () => { if (!isMyInputTurn() || selection.r === null) return; selection.dir = Number(b.dataset.dir); openWordModal(); });
  });
  $('btn-word-ok').addEventListener('click', submitWord);
  $('word-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submitWord(); });
  $('word-input').addEventListener('input', (e) => { const inp = $('word-input'); liveRomajiConvert(inp, Number(inp.dataset.maxHiragana) || undefined, e.isComposing); });
  $('btn-word-cancel').addEventListener('click', () => { hideModal('modal-word'); localProposal = null; });
  $('btn-propose-yes').addEventListener('click', () => {
    if (!localProposal) return;
    const move = localProposal; localProposal = null;
    approvalPending = true;
    submitMove(move, true);
  });
  $('btn-propose-no').addEventListener('click', () => {
    localProposal = null;
    send({ t: 'propose-cancel' });
    $('word-propose').classList.add('hidden'); $('word-buttons').classList.remove('hidden');
    $('word-input').disabled = false; $('word-input').focus();
    refreshAll();
  });
  $('btn-approve-yes').addEventListener('click', () => onApproveClick(true));
  $('btn-approve-no').addEventListener('click', () => onApproveClick(false));

  $('btn-rematch').addEventListener('click', onRematchClick);
  $('btn-result-exit').addEventListener('click', leaveRoom);
  $('btn-notice-ok').addEventListener('click', () => hideModal('modal-notice'));

  init();
})();
