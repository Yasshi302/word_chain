/**
 * アプリ本体: 画面制御・ロビー・N人対戦・ホスト権威の進行管理。
 *
 * mode:
 *   'offline'      1台で2〜4人交代プレイ (ローカルが権威)
 *   'online-host'  ホスト。ゲーム状態の権威。最大3ゲストとスター型接続
 *   'online-guest' ゲスト。意図を送り、ホストの配信で描画する
 *
 * プレーヤーは id 'p0'..'p3' で識別。色クラスは roster 内の並び順で決まる。
 */
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------------- 状態 ----------------
  let mode = 'offline';
  let phase = 'home';         // home|lobby|confirm|game|paused|over
  let myId = null;
  let roster = [];            // [{id, name, connId, connected}]  turn順
  let game = null;
  let timeLimitSec = 30;      // 0 = 無制限
  let boardSize = 8;
  let placementMode = 'default'; // 'default' | 'random' (初期文字の配置)
  let initialCount = 4;           // 初期文字の数
  let obstaclesOn = false;        // お邪魔マスの有無
  let obstacleCount = 4;          // お邪魔マスの数 (1〜全マス数の20%)
  let obstacleMoveOn = false;     // お邪魔マス移動オプションの有無
  let scoringMode = 'normal';     // 'normal' (通常) | 'territory' (陣取り)
  let bonusModeOn = false;        // ボーナスマスオプションの有無
  let itemsModeOn = false;        // アイテム(クリア・ブロック・ワイルドカード)オプションの有無
  let coopModeOn = false;         // 協力モード(CPU1体 vs プレーヤー全員)の有無
  let coopCpuLevel = 'normal';    // 協力モードCPUの強さ ('weak'|'normal'|'strong'|'strongest')
  let savedName = '';             // アプリ終了まで保持する自分の名前 (オンライン)
  let selection = { r: null, c: null, dir: null };
  let pendingMove = null;
  let localProposal = null;
  let cellEls = [];
  let itemTargetMode = null;      // { item:'clear', playerId } | null (「クリア」の対象マスを選んでいる最中)
  let itemClearCount = 1;         // アイテム「クリア」の盤面への配置数 (試合開始前設定)
  let itemBlockCount = 1;         // アイテム「ブロック」の盤面への配置数 (試合開始前設定)
  let itemWildcardCount = 1;      // アイテム「ワイルドカード」の盤面への配置数 (試合開始前設定)
  let clearCountdownTimer = null; // 「クリア」使用受付中のカウントダウン表示用interval
  let myFriendCode = null;        // 自分の恒久フレンドコード (friend-store.jsが生成・保存)
  let friendList = [];            // [{friendId, name, addedAt}]
  let myRoomPassword = null;      // 自分がホストした部屋のパスワード (フレンド招待に使う)
  let pendingInvite = null;       // { roomCode, password } | null (フレンドからの招待を受信中)

  let cpuWordIndex = null;        // CPU用: 先頭文字×文字数でグルーピングした辞書索引
  let cpuStartCharCounts = null;  // CPU用: 先頭文字の頻度 (相手の続けやすさの目安)
  let cpuTimer = null;

  let approval = null;        // 権威側: {proposerId, move, word, need:Set, votes:Map}
  let waitingSlot = null;     // ホスト: 再接続を待つ playerId
  let discInfo = null;
  let confirmAcks = new Set();
  let rematchVotes = new Set();
  let rematchMine = false;

  // 自動更新: ホスト側で「更新中のため再接続を待つ」プレーヤーの予約スロット。
  // ゲーム中切断の waitingSlot とは完全に別の変数にして、フェーズ混線を避ける。
  let updatingSlot = null;
  let updatingTimeoutId = null;
  let lastJoinCode = null;   // ゲスト: 自動更新後に同じ部屋へ再入室するため保持
  let lastJoinPass = null;

  let baseDict = null, customWords = null, customUpdatedAt = 0;
  let baseStartChars = null, startChars = null;
  // 拗音(ゃゅょっ等)を直音(やゆよつ等)に正規化したときの逆引き。
  // 「しゃしん」を「しやしん」と入力しても辞書照合できるようにするため。
  let baseNormIndex = new Map();
  let customNormIndex = new Map();

  const onlineRecord = { win: 0, lose: 0, draw: 0 };
  const offlineWins = [0, 0, 0, 0];
  let offlineDraws = 0;
  let offlineMaxSeen = 2;

  const timer = { remaining: 0, running: false, intervalId: null, lastTick: 0, onTimeout: null };

  // ---------------- 参照ヘルパ ----------------
  const isAuthority = () => mode === 'offline' || mode === 'online-host';
  function entryOf(id) { return roster.find((p) => p.id === id); }
  function idOfConn(connId) { const e = roster.find((p) => p.connId === connId); return e ? e.id : null; }
  function nameOf(id) { const e = entryOf(id); return e ? e.name : id; }
  function slotIndex(id) { return roster.findIndex((p) => p.id === id); }
  function colorOf(id) { const i = slotIndex(id); return 'p' + (i < 0 ? 0 : i); }
  // cpuLevelは協力モードのCPU席('coop')を全員に伝えるためだけに含める
  // (弱い/普通/強い/最強のオフライン専用CPUレベルはネットワークでは使わない)。
  function publicRoster() {
    return roster.map((p) => ({
      id: p.id, name: p.name, cpuLevel: p.cpuLevel === 'coop' ? 'coop' : null,
      friendId: p.friendId || null,
    }));
  }
  function activeIds() { return roster.filter((p) => p.connected).map((p) => p.id); }

  function isCpuTurn() {
    if (!game) return false;
    const e = entryOf(WordChain.currentPlayer(game));
    return !!(e && e.cpuLevel);
  }
  function isMyInputTurn() {
    if (!game || game.over || phase !== 'game') return false;
    if (pendingMove || approval || localProposal) return false;
    // 「ブロック」使用確認オファーが解決するまでは、新しい手番はまだ開始していない扱いにする
    // (相手ターン開始時に時計を止めている間、次の手番プレーヤーが先に動けてしまうのを防ぐ)
    if (game.pendingBlockOffer) return false;
    if (mode === 'offline') return !isCpuTurn();
    return WordChain.currentPlayer(game) === myId;
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
      'modal-result', 'modal-overlay', 'modal-notice', 'modal-block-offer'].forEach(hideModal);
  }
  function notice(text) { $('notice-text').textContent = text; showModal('modal-notice'); }
  function overlay(text) { $('overlay-text').textContent = text; showModal('modal-overlay'); }
  function hideOverlay() { cleanupWaitButtons(); hideModal('modal-overlay'); }
  function setStatus(t) { $('game-status').textContent = t; }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ---------------- 辞書 ----------------
  function inDict(w) { return baseDict.has(w) || customWords.has(w); }
  function dictCount() { return baseDict.size + customWords.size; }
  function buildNormIndex(words) {
    const idx = new Map();
    for (const w of words) {
      const n = WordChain.normalizeSmallKana(w);
      if (n !== w && !idx.has(n)) idx.set(n, w);
    }
    return idx;
  }
  /** 辞書に無くても、拗音→直音の正規化で一致すればその正しい綴りを返す */
  function resolveWord(word) {
    if (inDict(word)) return { word, indict: true };
    const norm = WordChain.normalizeSmallKana(word);
    if (norm !== word) {
      if (baseNormIndex.has(norm)) return { word: baseNormIndex.get(norm), indict: true };
      if (customNormIndex.has(norm)) return { word: customNormIndex.get(norm), indict: true };
    }
    return { word, indict: false };
  }
  function recomputeStartChars() {
    startChars = new Set(baseStartChars);
    for (const w of customWords) startChars.add([...w][0]);
    customNormIndex = buildNormIndex(customWords);
  }
  function adoptCustomDict(d) {
    if (!d || !Array.isArray(d.words)) return;
    customWords = new Set(d.words);
    customUpdatedAt = Number.isFinite(d.updatedAt) ? d.updatedAt : customUpdatedAt;
    recomputeStartChars();
  }
  async function addWordToDict(word) {
    if (baseDict.has(word)) return;
    customWords.add(word); startChars.add([...word][0]);
    try { adoptCustomDict(await window.api.addCustomWord(word)); } catch {}
  }

  async function init() {
    if (!window.api) {
      $('dict-status').textContent = 'このアプリは npm start (Electron) から起動してください。';
      ['btn-goto-create', 'btn-goto-join', 'btn-goto-offline', 'btn-goto-settings'].forEach((b) => { $(b).disabled = true; });
      return;
    }
    try {
      const [txt, custom] = await Promise.all([window.api.loadDictionary(), window.api.getCustomDict()]);
      baseDict = new Set(); baseStartChars = new Set();
      for (const line of txt.split('\n')) {
        const w = line.trim();
        if (w) { baseDict.add(w); baseStartChars.add([...w][0]); }
      }
      baseNormIndex = buildNormIndex(baseDict);
      customWords = new Set(Array.isArray(custom.words) ? custom.words : []);
      customUpdatedAt = Number.isFinite(custom.updatedAt) ? custom.updatedAt : 0;
      recomputeStartChars();
      $('dict-status').textContent = `辞書: ${dictCount().toLocaleString()} 語`;
    } catch {
      $('dict-status').textContent = '辞書の読み込みに失敗しました。';
    }
    updateRecordDisplays();
    try {
      const friendData = await window.api.getFriendData();
      myFriendCode = friendData.myFriendCode;
      friendList = Array.isArray(friendData.friends) ? friendData.friends : [];
      renderFriendList();
      // フレンドからの招待を常時受け付ける(ホーム・ロビー・対戦中を問わず起動中は有効)。
      // 失敗しても対戦自体はブロックしないベストエフォートの機能。
      Presence.start(myFriendCode, friendList, { onInvite: handleIncomingInvite });
    } catch {}
    await tryAutoResume();
  }

  // ---------------- 成績 ----------------
  function recordText() {
    if (mode === 'offline') {
      const parts = [];
      for (let i = 0; i < offlineMaxSeen; i++) parts.push(`P${i + 1} ${offlineWins[i]}勝`);
      return `成績: ${parts.join(' / ')} / 分 ${offlineDraws}`;
    }
    return `対戦成績: ${onlineRecord.win}勝 ${onlineRecord.lose}敗 ${onlineRecord.draw}分`;
  }
  function updateRecordDisplays() {
    const parts = [];
    if (onlineRecord.win + onlineRecord.lose + onlineRecord.draw > 0) {
      parts.push(`オンライン: ${onlineRecord.win}勝 ${onlineRecord.lose}敗 ${onlineRecord.draw}分`);
    }
    if (offlineWins.some((w) => w > 0) || offlineDraws > 0) {
      const op = [];
      for (let i = 0; i < offlineMaxSeen; i++) op.push(`P${i + 1} ${offlineWins[i]}勝`);
      parts.push(`オフライン: ${op.join(' / ')} / 分 ${offlineDraws}`);
    }
    $('home-record').textContent = parts.join('　');
    if (game) $('record-line').textContent = recordText();
  }
  function countResult() {
    if (game.counted) return;
    game.counted = true;
    const wins = WordChain.winners(game);
    if (mode === 'offline') {
      offlineMaxSeen = Math.max(offlineMaxSeen, roster.length);
      if (wins.length === 1) offlineWins[slotIndex(wins[0])]++;
      else offlineDraws++;
    } else {
      const amWin = wins.includes(myId);
      if (amWin && wins.length === 1) onlineRecord.win++;
      else if (amWin) onlineRecord.draw++;
      else onlineRecord.lose++;
    }
    updateRecordDisplays();
  }

  // ---------------- タイマー ----------------
  // ms < 0 は「無制限」を表す (時間切れによる自動パスを行わない)。
  function startTimer(ms, onTimeout) {
    if (ms < 0) {
      timer.remaining = -1; timer.running = false; timer.onTimeout = null;
      if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; }
      updateTimerDisplay();
      return;
    }
    timer.remaining = ms; timer.running = true; timer.onTimeout = onTimeout || null; timer.lastTick = Date.now();
    if (timer.intervalId) clearInterval(timer.intervalId);
    timer.intervalId = setInterval(tick, 200);
    updateTimerDisplay();
  }
  function pauseTimer() { timer.running = false; updateTimerDisplay(); }
  function resumeTimer() { timer.running = true; timer.lastTick = Date.now(); updateTimerDisplay(); }
  function stopTimer() { timer.running = false; if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; } }
  function setTimerDisplay(ms, running) {
    if (ms < 0) {
      timer.remaining = -1; timer.running = false; timer.onTimeout = null;
      if (timer.intervalId) { clearInterval(timer.intervalId); timer.intervalId = null; }
      updateTimerDisplay();
      return;
    }
    timer.remaining = ms; timer.running = running; timer.lastTick = Date.now(); timer.onTimeout = null;
    if (!timer.intervalId) timer.intervalId = setInterval(tick, 200);
    updateTimerDisplay();
  }
  function tick() {
    if (timer.running) {
      const now = Date.now();
      timer.remaining -= now - timer.lastTick;
      timer.lastTick = now;
    }
    updateTimerDisplay();
    if (timer.running && timer.remaining <= 0) {
      timer.running = false;
      if (typeof timer.onTimeout === 'function') timer.onTimeout();
    }
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
    board.innerHTML = '';
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
  // 陣取りモードでの上書き・ワイルドカードでの書き換えなど、既存マスの所有者や文字が
  // 変わったセルを再描画する(buildBoardDOMは初回しか塗らないため、ここで反映する)。
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
  // お邪魔マスの移動は毎ターン動的に変わるため、盤面全セルを都度反映する。
  // ボーナスマスはプレーヤーからは見えない仕様のため、ここでは描画しない。
  function renderHazards() {
    for (let r = 0; r < game.size; r++) {
      for (let c = 0; c < game.size; c++) {
        cellEls[r][c].classList.toggle('obstacle', !!(game.blocked && game.blocked[r][c]));
      }
    }
  }
  let bonusToastTimer = null;
  // ボーナスマスを取得した瞬間の演出: 該当マスを一瞬だけ点滅させ、
  // 「ボーナスゲット！+N ×N」のトーストを表示し、効果音を鳴らす。
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
  // アイテムマスを入手した瞬間の演出: 画面中心に「アイテムGET!〇〇〇」を表示し、効果音を鳴らす。
  // 1手で複数入手した場合は種類ごとに順番に表示する。
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
  // アイテムボタンの表示・有効/無効・所持数表示を更新する。「ブロック」は専用のボタンを持たず、
  // 相手ターン開始時の使用確認モーダル(showBlockOfferModal)からのみ使用できる。
  // 「ワイルドカード」も専用ボタンを持たず、単語入力モーダル内から使用する。
  function updateItemButtons() {
    const wrap = $('item-buttons');
    const invBox = $('item-inventory');
    if (!game || !game.itemsMode) { wrap.classList.add('hidden'); invBox.classList.add('hidden'); return; }
    wrap.classList.remove('hidden'); invBox.classList.remove('hidden');
    const busy = !!itemTargetMode;
    const viewerId = mode === 'offline' ? WordChain.currentPlayer(game) : myId;
    const inv = (game.items && game.items[viewerId]) || { clear: 0, block: 0, wildcard: 0 };
    invBox.textContent = `所持アイテム: クリア${inv.clear} / ブロック${inv.block} / ワイルドカード${inv.wildcard}`;
    const canClear = isMyInputTurn() && !busy && inv.clear > 0 && !game.pendingItemUse;
    $('btn-item-clear').disabled = !canClear;
    $('btn-item-clear').classList.toggle('primary', !!itemTargetMode && itemTargetMode.item === 'clear');
    $('btn-item-cancel').classList.toggle('hidden', !itemTargetMode);
  }
  function renderScores() {
    const box = $('scores');
    box.innerHTML = '';
    for (const p of roster) {
      const card = document.createElement('div');
      card.className = 'score-card ' + colorOf(p.id);
      if (!game.over && WordChain.currentPlayer(game) === p.id) card.classList.add('turn-active');
      if (!p.connected || !game.active[p.id]) card.classList.add('disconnected');
      const you = (mode !== 'offline' && p.id === myId) ? ' (あなた)' : '';
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
      : (mode !== 'offline' && cur === myId) ? 'あなたの番です' : `${nameOf(cur)}の番です`;
  }
  // h: 履歴エントリ (game.history[i] 相当)。{points, territoryLosses, wildcardUsed} を参照する。
  function addHistoryWord(word, byId, h) {
    if (h && h.territoryLosses) {
      // 陣取りモードで他プレーヤーのマスを奪った場合、被害者の減点を先に表示しておく
      // (prependの都合上、単語本体より先に追加すると単語の直下に並ぶ)
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

  // ---------------- 進行 ----------------
  function beginLocalGame(opts) {
    timeLimitSec = opts.timeLimit; boardSize = opts.size;
    // ロースター内にCPU席(通常の強さ別CPU、または協力モードのCPU)が1つでもあれば、
    // 権威側(オフライン、またはオンラインならホスト)がCPUの手を選ぶための辞書索引を用意する。
    if (roster.some((p) => p.cpuLevel)) {
      cpuWordIndex = CPU.buildWordIndex([baseDict, customWords]);
      cpuStartCharCounts = CPU.buildStartCharCounts([baseDict, customWords]);
    } else {
      cpuWordIndex = null; cpuStartCharCounts = null;
    }
    game = WordChain.newGame({
      size: opts.size, players: opts.playerIds, first: opts.first, timeLimit: opts.timeLimit,
      initialCells: opts.initialCells, initialLetters: opts.initialLetters, obstacleCells: opts.obstacleCells,
      territoryMode: opts.scoringMode === 'territory',
      bonusMode: !!opts.bonusMode, obstacleMove: !!opts.obstacleMove, itemsMode: !!opts.itemsMode,
      itemClearCount: opts.itemClearCount, itemBlockCount: opts.itemBlockCount, itemWildcardCount: opts.itemWildcardCount,
    });
    itemTargetMode = null;
    pendingMove = null; localProposal = null; approval = null;
    selection = { r: null, c: null, dir: null };
    phase = 'game';
    hideAllModals(); hideDirPanel();
    buildBoardDOM();
    $('history').innerHTML = '';
    updateRecordDisplays();
    updateChatVisibility();
    showScreen('screen-game');
    renderRoomCode();
    refreshAll();
    onTurnStart();
  }
  // オンライン対戦中に接続が切れた場合、戻る際に部屋コードが分からなくなるのを防ぐため
  // 対戦画面にも部屋コードを表示する(オフラインでは非表示)
  function renderRoomCode() {
    const el = $('game-room-code');
    if (mode === 'offline') { el.classList.add('hidden'); return; }
    $('game-room-code-value').textContent = Net.getRoomCode() || '';
    el.classList.remove('hidden');
  }

  // ---------------- フレンド ----------------
  function friendOf(friendId) { return friendList.find((f) => f.friendId === friendId); }
  function renderFriendList() {
    $('my-friend-code').textContent = myFriendCode || '';
    const ul = $('friend-list');
    ul.innerHTML = '';
    if (friendList.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'まだフレンドがいません。';
      ul.appendChild(li);
    } else {
      for (const f of friendList) {
        const li = document.createElement('li');
        const nm = document.createElement('span'); nm.textContent = f.name;
        const btn = document.createElement('button');
        btn.className = 'btn small'; btn.textContent = '削除';
        btn.addEventListener('click', async () => {
          const data = await window.api.removeFriend(f.friendId);
          friendList = Array.isArray(data.friends) ? data.friends : [];
          Presence.setFriendList(friendList);
          renderFriendList();
        });
        li.appendChild(nm); li.appendChild(btn);
        ul.appendChild(li);
      }
    }
    Presence.setFriendList(friendList);
    renderLobbyFriendInvite();
  }
  // ロビー(ホスト)で、まだ参加していないフレンドに部屋への招待を送るボタン一覧を描画する
  function renderLobbyFriendInvite() {
    const wrap = $('lobby-invite-friends');
    if (mode !== 'online-host' || phase !== 'lobby' || friendList.length === 0) {
      wrap.classList.add('hidden');
      return;
    }
    wrap.classList.remove('hidden');
    const ul = $('lobby-friend-list');
    ul.innerHTML = '';
    for (const f of friendList) {
      const li = document.createElement('li');
      const nm = document.createElement('span'); nm.textContent = f.name;
      const btn = document.createElement('button');
      btn.className = 'btn small'; btn.textContent = '招待';
      btn.addEventListener('click', () => {
        btn.disabled = true; btn.textContent = '送信中...';
        const roomCode = Net.getRoomCode();
        Presence.sendInvite(f.friendId, savedName, roomCode, myRoomPassword || '', (res) => {
          btn.disabled = false;
          btn.textContent = res.ok ? '招待済み' : 'オフライン';
          setTimeout(() => { btn.textContent = '招待'; }, 3000);
        });
      });
      li.appendChild(nm); li.appendChild(btn);
      ul.appendChild(li);
    }
  }
  function handleIncomingInvite({ fromFriendId, fromName, roomCode, password }) {
    const friend = friendOf(fromFriendId);
    const displayName = (friend && friend.name) || fromName || 'フレンド';
    $('invite-banner-text').textContent = `${displayName}さんから対戦の招待が届きました。`;
    $('invite-banner').classList.remove('hidden');
    pendingInvite = { roomCode, password };
    Sound.sfx('chat');
  }
  function refreshAll() {
    renderScores(); renderTurn(); renderChain(); renderHazards();
    $('btn-pass').disabled = !isMyInputTurn();
    updateBoardInteractivity();
    updateItemButtons();
  }
  function onTurnStart() {
    selection = { r: null, c: null, dir: null };
    // itemTargetModeは特定のプレーヤー(playerId)に紐づくため、手番が変わったら
    // (自動パス等で選択中だった場合)持ち越さないようにリセットする
    itemTargetMode = null;
    stopClearCountdownUI();
    hideDirPanel(); hideModal('modal-word'); hideBlockOfferModal();
    refreshAll();
    if (game.over) { onGameOver(); return; }
    // 「ブロック」使用確認オファーが開いている間は、新しい手番のタイマーを開始せず
    // (相手ターン開始時に時計を止める)、オファーが解決されるまで待つ。
    // ここで明示的にタイマーを止めないと、直前の手番の古いタイマーが動いたままになり、
    // オファー中に誤って時間切れ(相手の自動パス)が発生してしまう。
    if (isAuthority() && game.pendingBlockOffer) {
      const holderId = game.pendingBlockOffer.playerId;
      if (entryOf(holderId) && entryOf(holderId).cpuLevel) {
        // CPUはアイテムを使う判断ロジックを持たないため、常に自動的に見送る
        authorityDeclineBlockOffer(holderId);
        return;
      }
      pauseTimer();
      if (mode === 'online-host') {
        Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: false });
        Net.broadcast({ t: 'block-offer', playerId: holderId });
      }
      showBlockOfferModal(holderId);
      return;
    }
    const cur = WordChain.currentPlayer(game);
    if (isAuthority()) {
      const ms = timeLimitSec > 0 ? timeLimitSec * 1000 : -1;
      startTimer(ms, authorityTimeout);
      if (mode === 'online-host') {
        Net.broadcast({
          t: 'turn', by: cur, remainingMs: ms,
          bonusFlatCell: game.bonusFlatCell, bonusFlatValue: game.bonusFlatValue,
          bonusMultCell: game.bonusMultCell, bonusMultValue: game.bonusMultValue,
          obstacleCells: WordChain.obstacleCellList(game),
        });
      }
    }
    if (isAuthority() && isCpuTurn()) {
      setStatus(`${nameOf(cur)}が考えています...`);
      scheduleCpuTurn();
      return;
    }
    if (isMyInputTurn()) {
      if (mode !== 'offline') Sound.sfx('turn');
      if (!WordChain.hasAnyPlacement(game)) setStatus('置ける場所がありません。パスしてください。');
      else if (game.chain) { setStatus('前の単語の末尾から続けます。方向を選んでください。'); selectCell(game.chain.r, game.chain.c); }
      else setStatus('初期文字のマスから開始する文字を選んでください。');
    } else setStatus(`${nameOf(cur)}の番です...`);
  }

  // ---------------- CPU (オフライン) ----------------
  function scheduleCpuTurn() {
    if (cpuTimer) clearTimeout(cpuTimer);
    const cur = WordChain.currentPlayer(game);
    const level = entryOf(cur).cpuLevel;
    const delay = 700 + Math.random() * 1100;
    cpuTimer = setTimeout(() => {
      cpuTimer = null;
      if (!game || game.over || phase !== 'game') return;
      if (WordChain.currentPlayer(game) !== cur) return; // 状況が変わっていれば何もしない
      const move = level === 'coop'
        ? CPU.chooseCoopMove(game, cpuWordIndex, startChars, cpuStartCharCounts, entryOf(cur).coopLevel)
        : CPU.chooseMove(game, cpuWordIndex, startChars, level, cpuStartCharCounts);
      if (!move) { authorityPass(cur, false); return; }
      authorityHandleMove(cur, { r: move.r, c: move.c, dir: move.dir, word: move.word });
    }, delay);
  }
  // 協力モード(CPU1体 vs プレーヤー全員)のとき、チーム合計スコアとCPUのスコアを比較する。
  // 協力モードでなければnull。
  function coopResult() {
    const coopCpu = roster.find((p) => p.cpuLevel === 'coop');
    if (!coopCpu) return null;
    const teamTotal = roster.filter((p) => p.id !== coopCpu.id).reduce((sum, p) => sum + (game.scores[p.id] || 0), 0);
    const cpuScore = game.scores[coopCpu.id] || 0;
    return { coopCpu, teamTotal, cpuScore, teamWon: teamTotal > cpuScore };
  }
  function onGameOver() {
    stopTimer(); countResult(); phase = 'over'; refreshAll(); showResult();
    const coop = coopResult();
    const won = coop ? coop.teamWon : (mode === 'offline') || WordChain.winners(game).includes(myId);
    Sound.sfx(won ? 'win' : 'lose');
  }

  // ---------------- 権威: 手・パス ----------------
  function authorityTimeout() {
    if (!isAuthority() || !game || game.over || approval || phase !== 'game') return;
    authorityPass(WordChain.currentPlayer(game), true);
  }
  // お邪魔マスの移動・次のボーナスマスの抽選 (権威側のみ実行し、'turn'配信で結果をゲストへ伝える。
  // ゲストが独自に乱数を引くと選ばれるマスがホストとずれてしまうため、ここでは呼ばない)
  function advanceHazards() {
    WordChain.relocateObstacles(game);
    const bonus = WordChain.pickBonusCells(game);
    game.bonusFlatCell = bonus.flat ? bonus.flat.cell : null;
    game.bonusFlatValue = bonus.flat ? bonus.flat.value : null;
    game.bonusMultCell = bonus.multiplier ? bonus.multiplier.cell : null;
    game.bonusMultValue = bonus.multiplier ? bonus.multiplier.value : null;
  }
  function authorityApplyMove(move, byId, approved) {
    const { placed, captured, flatValue, multValue, itemsGot } = WordChain.applyMove(game, move, byId);
    const flatCell = flatValue ? game.bonusFlatCell : null;
    const multCell = multValue ? game.bonusMultCell : null;
    renderPlaced(placed, byId);
    renderCaptured(captured, byId);
    drawLastWordLine(move, byId);
    addHistoryWord(move.word, byId, game.history[game.history.length - 1]);
    if (approved) Sound.sfx('approve');
    if (flatValue || multValue) showBonusGet(flatValue, multValue, flatCell, multCell);
    showItemGet(itemsGot);
    advanceHazards();
    if (mode === 'online-host') {
      Net.broadcast({
        t: 'move-applied', by: byId, r: move.r, c: move.c, dir: move.dir, word: move.word,
        wildcardIndex: move.wildcardIndex, approved: !!approved,
      });
    }
    onTurnStart();
  }
  function authorityPass(byId, timeout) {
    if (!game || game.over || WordChain.currentPlayer(game) !== byId) return;
    addHistoryPass(byId);
    WordChain.applyPass(game);
    if (!game.over) advanceHazards();
    if (mode === 'online-host') Net.broadcast({ t: 'pass-applied', by: byId });
    setStatus(timeout ? `${nameOf(byId)}が時間切れでパスしました。` : `${nameOf(byId)}がパスしました。`);
    if (game.over && mode === 'online-host') Net.broadcast({ t: 'game-over', scores: game.scores, winners: WordChain.winners(game) });
    onTurnStart();
  }
  function authorityHandleMove(byId, move) {
    if (!game || game.over || WordChain.currentPlayer(game) !== byId) return;
    // 拗音(ゃゅょっ等)を直音で入力していても、辞書上の正しい綴りに直してから判定する
    const resolved = resolveWord(move.word);
    const rmove = resolved.word === move.word ? move : { ...move, word: resolved.word };
    const v = WordChain.validateMove(game, rmove, startChars);
    if (!v.ok) { rejectTo(byId, v.reason); return; }
    if (resolved.indict) authorityApplyMove(rmove, byId, false);
    else startApproval(byId, rmove);
  }
  function rejectTo(byId, reason) {
    if (mode === 'online-host' && byId !== myId) {
      const e = entryOf(byId);
      if (e && e.connId) Net.sendTo(e.connId, { t: 'move-rejected', reason });
    } else {
      handleLocalReject(reason);
    }
  }

  // ---------------- 権威: アイテム使用 (手番は消費しない) ----------------
  // 使用可否(自分の手番か、「ブロック」の使用確認オファー中か)はWordChain.useItem内で判定する
  function authorityUseItem(byId, item, r, c) {
    if (!game || game.over) return;
    const wasBlockOffer = item === 'block';
    const res = WordChain.useItem(game, byId, item, r, c);
    if (!res.ok) { rejectItemTo(byId, res.reason); return; }
    addHistoryItem(byId, item);
    renderHazards();
    itemTargetMode = null;
    if (item === 'clear') {
      stopClearCountdownUI();
      // カウントダウン中に止めていた入力時間を再開する
      resumeTimer();
      if (mode === 'online-host') Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: true });
    }
    renderItemTargets();
    updateItemButtons();
    if (mode === 'online-host') Net.broadcast({ t: 'item-applied', by: byId, item, r, c });
    // 「ブロック」はオファーの解決によって保留していたターン開始処理(タイマー開始・'turn'配信)を進める
    if (wasBlockOffer) onTurnStart();
  }
  function rejectItemTo(byId, reason) {
    if (mode === 'online-host' && byId !== myId) {
      const e = entryOf(byId);
      if (e && e.connId) Net.sendTo(e.connId, { t: 'item-rejected', reason });
    } else {
      notice(reason || 'アイテムを使用できませんでした。');
    }
  }
  function guestApplyItem(m) {
    if (!game) return;
    WordChain.useItem(game, m.by, m.item, m.r, m.c);
    addHistoryItem(m.by, m.item);
    renderHazards();
    itemTargetMode = null;
    if (m.item === 'clear') stopClearCountdownUI();
    renderItemTargets();
    updateItemButtons();
  }

  // ---------------- 権威: 「クリア」の使用受付開始 (5秒の猶予) ----------------
  function startClearItem() {
    if ($('btn-item-clear').disabled) return;
    const playerId = mode === 'offline' ? WordChain.currentPlayer(game) : myId;
    if (mode === 'online-guest') Net.sendHost({ t: 'use-item-start', item: 'clear' });
    else authorityStartClearWindow(playerId);
  }
  function authorityStartClearWindow(playerId) {
    if (!game || game.over) return;
    const res = WordChain.startClearWindow(game, playerId);
    if (!res.ok) { rejectItemTo(playerId, res.reason); return; }
    if (mode === 'offline' || playerId === myId) {
      itemTargetMode = { item: 'clear', playerId };
      renderItemTargets();
      updateItemButtons();
    } else {
      setStatus(`${nameOf(playerId)}が「クリア」を使用中...`);
    }
    startClearCountdownUI(res.expiresAt);
    // カウントダウン中は入力時間を止める(成功時・猶予切れ時のいずれでも再開する)
    pauseTimer();
    if (mode === 'online-host') {
      Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: false });
      Net.broadcast({ t: 'item-window-start', by: playerId, item: 'clear', expiresAt: res.expiresAt });
    }
    setTimeout(resumeTimerAfterClearWindow, WordChain.CLEAR_ITEM_WINDOW_MS);
  }
  // 「クリア」の使用受付の猶予が切れた場合(対象を選べなかった場合)も入力時間を再開する。
  // 猶予内に成功していた場合(authorityUseItem側で既に再開済み)に再度呼ばれても、
  // resumeTimer()は何度呼んでも安全(既に動いている場合は無害)なので問題ない。
  function resumeTimerAfterClearWindow() {
    if (!isAuthority() || !game || game.over) return;
    resumeTimer();
    if (mode === 'online-host') Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: true });
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

  // ---------------- 権威: 「ブロック」使用確認オファー (相手ターン開始時) ----------------
  function showBlockOfferModal(holderId) {
    if (mode === 'offline' || holderId === myId) {
      $('block-offer-text').textContent = mode === 'offline'
        ? `${nameOf(holderId)}さん、「ブロック」を使いますか?`
        : 'あなたは「ブロック」を持っています。使いますか?';
      showModal('modal-block-offer');
    } else {
      setStatus(`${nameOf(holderId)}がブロックの使用を検討中です...`);
    }
  }
  function hideBlockOfferModal() { hideModal('modal-block-offer'); }
  function authorityDeclineBlockOffer(byId) {
    if (!game || !game.pendingBlockOffer || game.pendingBlockOffer.playerId !== byId) return;
    WordChain.declineBlockOffer(game, byId);
    onTurnStart(); // オファーが閉じたので、保留していたターン開始処理を進める
  }

  // 承認 (権威)
  function startApproval(proposerId, move) {
    // CPU(協力モード等)は承認の投票をしない(できない)ため、必要な承認者から除外する
    // (除外しないと、CPUの票が永遠に来ずゲームが進行不能になる)
    const need = new Set(activeIds().filter((id) => id !== proposerId && !entryOf(id).cpuLevel));
    approval = { proposerId, move, word: move.word, need, votes: new Map() };
    if (need.size === 0) { finishApproval(true); return; } // 投票できる相手がいない(切断等)場合は自動承認する
    pauseTimer();
    if (mode === 'online-host') {
      Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: false });
      for (const id of need) { const e = entryOf(id); if (e && e.connId) Net.sendTo(e.connId, { t: 'approve-start', by: proposerId, word: move.word }); }
      if (proposerId !== myId) { const pe = entryOf(proposerId); if (pe && pe.connId) Net.sendTo(pe.connId, { t: 'status', text: '他のプレーヤーの承認を待っています...' }); }
    }
    if (need.has(myId) || mode === 'offline') showApproveModal(proposerId, move.word);
    if (proposerId === myId) setStatus('他のプレーヤーの承認を待っています...');
  }
  function recordVote(voterId, ok) {
    if (!approval) return;
    if (mode === 'offline') { finishApproval(ok); return; }
    if (!approval.need.has(voterId) || approval.votes.has(voterId)) return;
    approval.votes.set(voterId, ok);
    if (!ok) { finishApproval(false); return; }
    let all = true;
    for (const id of approval.need) if (approval.votes.get(id) !== true) { all = false; break; }
    if (all) finishApproval(true);
  }
  async function finishApproval(ok) {
    if (!approval) return;
    const { proposerId, move, word } = approval;
    approval = null;
    if (mode === 'online-host') Net.broadcast({ t: 'approve-end' });
    hideModal('modal-approve');
    if (ok) {
      await addWordToDict(word);
      authorityApplyMove(move, proposerId, true);
    } else {
      Sound.sfx('reject');
      resumeTimer();
      if (mode === 'online-host') Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: true });
      rejectTo(proposerId, '拒否されました。別の単語を入力してください。');
    }
  }

  // ---------------- ローカル入力 ----------------
  function submitLocalMove(move) {
    if (mode === 'online-guest') {
      pendingMove = move;
      hideModal('modal-word'); hideDirPanel(); updateBoardInteractivity();
      setStatus(inDict(move.word) ? '判定中...' : '承認を待っています...');
      Net.sendHost({ t: 'move', r: move.r, c: move.c, dir: move.dir, word: move.word, wildcardIndex: move.wildcardIndex });
    } else {
      hideModal('modal-word'); hideDirPanel();
      authorityHandleMove(WordChain.currentPlayer(game), move);
    }
  }
  function submitLocalPass() {
    if (mode === 'online-guest') { hideModal('modal-word'); hideDirPanel(); pendingMove = null; Net.sendHost({ t: 'pass' }); setStatus('パスしました。'); }
    else authorityPass(WordChain.currentPlayer(game), false);
  }
  function handleLocalReject(reason) {
    pendingMove = null; localProposal = null;
    const cur = WordChain.currentPlayer(game);
    const mine = (mode === 'offline') || (cur === myId);
    if (mode === 'online-guest') Sound.sfx('reject');
    if (!mine) { setStatus(reason || '拒否されました。'); return; }
    const timeLeft = (mode === 'online-guest') ? true : (timeLimitSec <= 0 || timer.remaining > 1000);
    if (timeLeft) {
      setStatus(reason || '拒否されました。別の単語を入力してください。');
      if (isAuthority()) resumeTimer();
      refreshAll();
      if (game.chain) selectCell(game.chain.r, game.chain.c);
    } else {
      submitLocalPass();
    }
  }

  // ---------------- 承認モーダル ----------------
  function showApproveModal(proposerId, word) {
    $('approve-caption').textContent = mode === 'offline'
      ? `${nameOf(proposerId)}以外のプレーヤーが確認してください。提案された単語:`
      : `${nameOf(proposerId)}が辞書にない単語を提案しています:`;
    $('approve-word').textContent = word;
    showModal('modal-approve');
  }
  function onApproveClick(ok) {
    hideModal('modal-approve');
    if (isAuthority()) recordVote(myId, ok);
    else { Net.sendHost({ t: 'approve-vote', ok }); setStatus('承認結果を送信しました。'); }
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
  function openWordModal() {
    const { r, c, dir } = selection;
    const L = WordChain.maxLen(game, r, c, dir);
    const cells = WordChain.rayCells(r, c, dir, L);
    const pat = $('word-pattern'); pat.innerHTML = '';
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
  // ワイルドカードを所持していて、経路上に既存の文字(通常は完全一致が必須なマス)が
  // あるときだけ、書き換え対象を選ぶセレクトを表示する。
  function setupWildcardField(fixedIndices, cells) {
    const field = $('wildcard-field');
    const select = $('wildcard-select');
    const playerId = mode === 'offline' ? WordChain.currentPlayer(game) : myId;
    const inv = (game.items && game.items[playerId]) || { wildcard: 0 };
    select.innerHTML = '<option value="">使わない</option>';
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
    const v = WordChain.validateMove(game, move, startChars);
    if (!v.ok) { $('word-error').textContent = v.reason; return; }
    $('word-error').textContent = '';
    if (resolveWord(word).indict || mode === 'online-guest') {
      submitLocalMove(move); // guestは辞書外もホストに任せる (ホストが承認進行)
    } else {
      if (isAuthority()) { pauseTimer(); if (mode === 'online-host') Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: false }); }
      localProposal = move;
      $('word-propose-text').textContent = `「${word}」は単語リストにありません。他のプレーヤーに承認を求めますか?`;
      $('word-propose').classList.remove('hidden');
      $('word-buttons').classList.add('hidden');
      $('word-input').disabled = true;
    }
  }

  // ---------------- 結果・再戦 ----------------
  function showResult() {
    const wins = WordChain.winners(game);
    const ranked = roster.slice().sort((a, b) => game.scores[b.id] - game.scores[a.id]);
    const coop = coopResult();
    if (coop) {
      $('result-title').textContent = coop.teamWon ? 'チームの勝利!' : (coop.teamTotal === coop.cpuScore ? '引き分け' : 'CPUの勝利...');
    } else if (mode === 'offline') $('result-title').textContent = wins.length === 1 ? `${nameOf(wins[0])}の勝ち!` : '引き分け';
    else $('result-title').textContent = wins.includes(myId) ? (wins.length === 1 ? 'あなたの勝ち!' : '引き分け (あなたを含む)') : `${nameOf(wins[0])}の勝ち`;
    const box = $('result-detail'); box.innerHTML = '';
    if (coop) {
      const teamRow = document.createElement('div');
      teamRow.className = 'rank-row coop-summary-row' + (coop.teamWon ? ' winner' : '');
      teamRow.innerHTML = `<span class="rank-name">チーム合計</span><span class="rank-score">${coop.teamTotal} 点</span>`;
      const cpuRow = document.createElement('div');
      cpuRow.className = 'rank-row coop-summary-row' + (!coop.teamWon && coop.teamTotal !== coop.cpuScore ? ' winner' : '');
      cpuRow.innerHTML = `<span class="rank-name">CPU (${escapeHtml(coop.coopCpu.name)})</span><span class="rank-score">${coop.cpuScore} 点</span>`;
      box.appendChild(teamRow); box.appendChild(cpuRow);
    }
    let pos = 1;
    ranked.forEach((p, i) => {
      if (i > 0 && game.scores[p.id] < game.scores[ranked[i - 1].id]) pos = i + 1;
      const row = document.createElement('div');
      row.className = 'rank-row' + (wins.includes(p.id) ? ' winner' : '');
      const you = (mode !== 'offline' && p.id === myId) ? ' (あなた)' : '';
      const unit = game.territoryMode ? '点' : '文字';
      row.innerHTML = `<span class="rank-pos">${pos}位</span><span class="rank-name ${colorOf(p.id)}">${escapeHtml(p.name + you)}</span><span class="rank-score">${game.scores[p.id]} ${unit}</span>`;
      // オンラインで、CPUではない他プレーヤーで、フレンドコードが分かっていて未登録なら「フレンドに登録」を出す
      if (mode !== 'offline' && p.id !== myId && !p.cpuLevel && p.friendId && p.friendId !== myFriendCode && !friendOf(p.friendId)) {
        const addBtn = document.createElement('button');
        addBtn.className = 'btn small'; addBtn.textContent = 'フレンドに登録';
        addBtn.addEventListener('click', async () => {
          const data = await window.api.addFriend(p.friendId, p.name);
          friendList = Array.isArray(data.friends) ? data.friends : [];
          Presence.setFriendList(friendList);
          addBtn.disabled = true; addBtn.textContent = '登録済み';
        });
        row.appendChild(addBtn);
      }
      box.appendChild(row);
    });
    $('result-record').textContent = recordText();
    rematchVotes = new Set(); rematchMine = false;
    $('btn-rematch').disabled = false;
    $('rematch-status').textContent = mode === 'offline' ? '' : '再戦には全員の同意が必要です。';
    showModal('modal-result');
  }
  function onRematchClick() {
    if (mode === 'offline') { startNewGameLocal(); return; }
    if (rematchMine) return;
    rematchMine = true; $('btn-rematch').disabled = true;
    if (mode === 'online-host') { rematchVotes.add(myId); checkRematch(); }
    else { Net.sendHost({ t: 'rematch-vote', ok: true }); $('rematch-status').textContent = 'あなたは再戦に同意しました。他のプレーヤーを待っています...'; }
  }
  function checkRematch() {
    const need = activeIds();
    const got = need.filter((id) => rematchVotes.has(id)).length;
    $('rematch-status').textContent = `再戦の同意: ${got} / ${need.length}`;
    Net.broadcast({ t: 'rematch-progress', got, need: need.length });
    if (got >= need.length && need.length >= 2) {
      hideModal('modal-result');
      Net.broadcast({ t: 'rematch-lobby' });
      goToLobbyAsHost(true);
    }
  }

  // ================= オフライン =================
  function startOffline() {
    mode = 'offline'; myId = null;
    coopModeOn = $('offline-coop-mode').checked;
    const n = Math.min(Number($('offline-count').value), coopModeOn ? WordChain.MAX_PLAYERS - 1 : WordChain.MAX_PLAYERS);
    boardSize = WordChain.clampSize($('offline-size-range').value);
    timeLimitSec = Number($('offline-time').value);
    placementMode = $('offline-placement').value === 'random' ? 'random' : 'default';
    initialCount = Number($('offline-initial-count').value);
    obstaclesOn = $('offline-obstacles').checked;
    obstacleCount = Number($('offline-obstacle-count').value);
    obstacleMoveOn = obstaclesOn && $('offline-obstacle-move').checked;
    scoringMode = $('offline-scoring-mode').value === 'territory' ? 'territory' : 'normal';
    bonusModeOn = $('offline-bonus-mode').checked;
    itemsModeOn = $('offline-items-mode').checked;
    itemClearCount = Number($('offline-item-clear-count').value);
    itemBlockCount = Number($('offline-item-block-count').value);
    itemWildcardCount = Number($('offline-item-wildcard-count').value);
    const opponent = coopModeOn ? 'human' : $('offline-opponent').value;
    const cpuLevel = $('offline-cpu-level').value;
    roster = [];
    for (let i = 0; i < n; i++) {
      const isCpu = opponent === 'cpu' && i > 0;
      roster.push({
        id: 'p' + i,
        name: isCpu ? `CPU (${CPU.LEVEL_LABEL[cpuLevel]})` : `プレーヤー${i + 1}`,
        connId: null, connected: true,
        cpuLevel: isCpu ? cpuLevel : null,
      });
    }
    if (coopModeOn) {
      const coopLevel = $('offline-coop-cpu-level').value;
      roster.push({ id: 'p' + n, name: `CPU (${CPU.LEVEL_LABEL[coopLevel]})`, connId: null, connected: true, cpuLevel: 'coop', coopLevel });
    }
    startNewGameLocal();
  }
  function startNewGameLocal() {
    const initialCells = WordChain.generateInitialCells(boardSize, placementMode, initialCount);
    const initialLetters = WordChain.randomLetters(initialCells.length);
    const obstacleCells = obstaclesOn ? WordChain.generateObstacleCells(boardSize, initialCells, obstacleCount) : [];
    beginLocalGame({
      size: boardSize, initialCells, initialLetters, obstacleCells,
      first: randInt(roster.length), timeLimit: timeLimitSec, playerIds: roster.map((p) => p.id),
      scoringMode, bonusMode: bonusModeOn, obstacleMove: obstacleMoveOn, itemsMode: itemsModeOn,
      itemClearCount, itemBlockCount, itemWildcardCount,
    });
  }
  function randInt(max) { const b = new Uint32Array(1); crypto.getRandomValues(b); return b[0] % max; }

  // ================= 自動更新 =================
  // 取得元は常にGitHub Releases (main.js/updater.js)。対戦相手から直接コードを
  // 受け取って実行することは一切しない。失敗しても対戦はブロックせず現行版で続行する。
  function showUpdateBanner(text) {
    $('update-banner-text').textContent = text;
    $('update-banner-bar').style.width = '0%';
    $('update-banner').classList.remove('hidden');
  }
  function updateUpdateBannerText(text) { $('update-banner-text').textContent = text; }
  function updateUpdateBannerProgress(received, total) {
    if (!total) return;
    const pct = Math.max(0, Math.min(100, Math.round((received / total) * 100)));
    $('update-banner-bar').style.width = pct + '%';
  }
  function hideUpdateBanner() { $('update-banner').classList.add('hidden'); }

  let updateProgressUnsub = null;
  function wireUpdateProgressListener() {
    if (!window.api || !window.api.onUpdateDownloadProgress || updateProgressUnsub) return;
    updateProgressUnsub = window.api.onUpdateDownloadProgress(({ received, total }) => {
      updateUpdateBannerProgress(received, total);
    });
  }

  /**
   * 最新版を確認し、必要なら自動更新する。
   * 更新が成立してアプリがまもなく終了する場合に true を返す (呼び出し側はそこで処理を止める)。
   * role='guest' のときは onUpdateDetected をダウンロード開始前に呼び、
   * ホストへ「更新中」を伝える機会を与える。
   */
  async function checkAndApplyUpdateIfNeeded(role, roomInfo, onUpdateDetected) {
    if (!window.api || typeof window.api.checkUpdate !== 'function') return false;
    let info;
    try { info = await window.api.checkUpdate(); } catch { return false; }
    if (!info || !info.ok || !info.needsUpdate) return false;

    if (typeof onUpdateDetected === 'function') { try { onUpdateDetected(); } catch { /* ignore */ } }
    showUpdateBanner(`最新バージョン(${info.latest})があります。最新化中・・・`);
    wireUpdateProgressListener();

    let dl;
    try { dl = await window.api.downloadUpdate({ downloadUrl: info.downloadUrl, size: info.size }); }
    catch { dl = null; }
    if (!dl || !dl.ok) { hideUpdateBanner(); return false; }

    if (role === 'guest' && roomInfo && window.api.saveResumeIntent) {
      try { await window.api.saveResumeIntent(roomInfo); } catch { /* ignore */ }
    }

    updateUpdateBannerText('最新化が完了しました。再起動します...');
    let applied;
    try { applied = await window.api.applyUpdate({ downloadedPath: dl.path }); }
    catch { applied = null; }
    if (!applied || !applied.ok) { hideUpdateBanner(); return false; }
    return true; // アプリはまもなく終了・再起動する
  }

  /** アプリ起動直後: 前回「更新のため再入室」を予約していれば自動的に部屋へ戻る */
  async function tryAutoResume() {
    if (!window.api || typeof window.api.getResumeIntent !== 'function') return;
    let intent;
    try { intent = await window.api.getResumeIntent(); } catch { return; }
    if (!intent || intent.role !== 'guest' || !intent.roomCode || !intent.password) return;
    savedName = intent.myName || savedName;
    lastJoinCode = intent.roomCode; lastJoinPass = intent.password;
    mode = 'online-guest'; myId = null; roster = []; phase = 'lobby';
    $('lobby-title').textContent = '再接続中...';
    $('lobby-code-wrap').classList.add('hidden');
    $('lobby-host-controls').classList.add('hidden');
    $('btn-lobby-start').classList.add('hidden');
    $('lobby-status').textContent = '最新化が完了しました。部屋に再接続しています...';
    showScreen('screen-lobby');
    Net.joinRoom(intent.roomCode, intent.password, guestEvents());
  }

  /** ホスト: ロビーの更新中プレーヤーの状態を全員に配信する */
  function broadcastUpdateStatus() {
    Net.broadcast({ t: 'updated', players: roster.map((p) => ({ id: p.id, name: p.name, updating: !!p.updating })) });
  }

  /** ホスト: 更新中スロットが一定時間戻らなければ諦めてロビーから外す (対戦を止めないための安全策) */
  function armUpdatingTimeout(id) {
    if (updatingTimeoutId) clearTimeout(updatingTimeoutId);
    updatingTimeoutId = setTimeout(() => {
      if (updatingSlot !== id) return;
      const name = nameOf(id);
      updatingSlot = null;
      roster = roster.filter((p) => p.id !== id);
      Net.broadcast({ t: 'lobby', players: publicRoster() });
      renderLobby();
      notice(`${name}の最新化が完了しなかったため、ロビーから外れました。`);
    }, 3 * 60 * 1000);
  }
  function disarmUpdatingTimeout() {
    if (updatingTimeoutId) { clearTimeout(updatingTimeoutId); updatingTimeoutId = null; }
  }

  // ================= オンライン: ホスト =================
  function hostEvents() {
    return {
      onRoomReady: (code) => { $('lobby-code').textContent = code; renderLobby(); },
      onError: (msg) => { notice(msg); resetToHome(); },
      onGuestAuthed: (connId) => hostGuestAuthed(connId),
      onGuestClosed: (connId) => hostGuestClosed(connId),
      onGuestMessage: (connId, m) => hostOnMessage(connId, m),
    };
  }
  function freeSlot() { for (let i = 1; i <= 3; i++) if (!roster.some((p) => p.id === 'p' + i)) return 'p' + i; return null; }
  function hostGuestAuthed(connId) {
    if (updatingSlot && (phase === 'lobby' || phase === 'confirm')) {
      const e = entryOf(updatingSlot);
      if (e) {
        e.connId = connId; e.connected = true; e.updating = false;
        const resumed = updatingSlot; updatingSlot = null; disarmUpdatingTimeout();
        Net.sendTo(connId, { t: 'welcome', you: resumed });
        broadcastUpdateStatus();
        Net.broadcast({ t: 'lobby', players: publicRoster() });
        renderLobby();
        return;
      }
      updatingSlot = null; disarmUpdatingTimeout(); // 該当スロットが既に無い -> 通常の新規参加として処理
    }
    if (phase === 'lobby' || phase === 'confirm') {
      const slot = freeSlot();
      if (!slot) { Net.closeGuest(connId); return; }
      roster.push({ id: slot, name: `プレーヤー${Number(slot.slice(1)) + 1}`, connId, connected: true, updating: false });
      Net.sendTo(connId, { t: 'welcome', you: slot });
      Net.broadcast({ t: 'lobby', players: publicRoster() });
      renderLobby();
    } else if ((phase === 'game' || phase === 'paused') && waitingSlot) {
      const e = entryOf(waitingSlot);
      if (!e) { Net.closeGuest(connId); return; }
      e.connId = connId; e.connected = true;
      const rejoined = waitingSlot; waitingSlot = null; discInfo = null;
      Net.sendTo(connId, { t: 'welcome', you: rejoined, rejoined: true });
      Net.sendTo(connId, resyncPayload());
      Net.broadcast({ t: 'player-rejoined', id: rejoined });
      hideOverlay(); hideModal('modal-disconnect');
      phase = 'game';
      Net.broadcast({ t: 'paused', waiting: false });
      resumeTimer();
      Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: true });
      setStatus(`${nameOf(rejoined)}が再接続しました。`);
      refreshAll();
    } else {
      Net.closeGuest(connId);
    }
  }
  function hostGuestClosed(connId) {
    const id = idOfConn(connId);
    if (!id) return;
    const e = entryOf(id);
    if (phase === 'lobby' || phase === 'confirm') {
      if (e && e.updating) {
        // 更新のため意図的に切断しているだけ。rosterからは外さず再接続を待つ
        e.connId = null; e.connected = false;
        renderLobby();
        return;
      }
      roster = roster.filter((p) => p.id !== id);
      Net.broadcast({ t: 'lobby', players: publicRoster() });
      renderLobby();
      if (phase === 'confirm') maybeAllConfirmed();
    } else if (phase === 'game' || phase === 'paused') {
      if (e) e.connected = false;
      handleInGameDisconnect(id);
    } else if (phase === 'over') {
      if (e) e.connected = false;
      if (rematchVotes.size) checkRematch();
    }
  }
  function handleInGameDisconnect(id) {
    if (approval) { approval = null; Net.broadcast({ t: 'approve-end' }); hideModal('modal-approve'); }
    phase = 'paused'; pauseTimer();
    Net.broadcast({ t: 'player-disc', id });
    Net.broadcast({ t: 'paused', waiting: true });
    Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: false });
    discInfo = { id };
    $('disconnect-text').textContent = `${nameOf(id)}との接続が切れました。どうしますか?`;
    showModal('modal-disconnect');
    refreshAll();
  }
  function hostDisc(choice) {
    hideModal('modal-disconnect');
    if (!discInfo) return;
    const id = discInfo.id;
    if (choice === 'wait') {
      waitingSlot = id;
      overlay(`${nameOf(id)}の再接続を待っています...`);
      showWaitButtons();
    } else if (choice === 'continue') {
      waitingSlot = null; discInfo = null;
      WordChain.removePlayer(game, id);
      Net.broadcast({ t: 'player-left', id });
      hideOverlay();
      phase = 'game';
      Net.broadcast({ t: 'paused', waiting: false });
      if (game.over) authorityBroadcastOverAndShow();
      else { setStatus(`${nameOf(id)}を除外して継続します。`); onTurnStart(); }
    } else if (choice === 'end') {
      waitingSlot = null; discInfo = null;
      authorityBroadcastOverAndShow();
    }
  }
  function authorityBroadcastOverAndShow() {
    game.over = true;
    Net.broadcast({ t: 'game-over', scores: game.scores, winners: WordChain.winners(game) });
    hideOverlay();
    onGameOver();
  }
  function showWaitButtons() {
    const box = $('modal-overlay').querySelector('.modal-box');
    if (box.querySelector('.wait-btns')) return;
    const div = document.createElement('div');
    div.className = 'menu-buttons wait-btns';
    div.style.marginTop = '16px';
    const bc = document.createElement('button'); bc.className = 'btn'; bc.textContent = '残りで継続する';
    bc.onclick = () => { discInfo = { id: waitingSlot }; cleanupWaitButtons(); hostDisc('continue'); };
    const be = document.createElement('button'); be.className = 'btn warn'; be.textContent = 'ゲームを終了する';
    be.onclick = () => { discInfo = { id: waitingSlot }; cleanupWaitButtons(); hostDisc('end'); };
    div.appendChild(bc); div.appendChild(be);
    box.appendChild(div);
  }
  function cleanupWaitButtons() { const d = $('modal-overlay') && $('modal-overlay').querySelector('.wait-btns'); if (d) d.remove(); }

  function resyncPayload() {
    return {
      t: 'resync', size: game.size, board: game.board, owner: game.owner, blocked: game.blocked, initialCells: game.initialCells,
      scores: game.scores, active: game.active, players: publicRoster(), turnIdx: game.turnIdx, chain: game.chain,
      used: [...game.usedWords], history: game.history, timeLimit: game.timeLimit, over: game.over, remainingMs: timer.remaining,
      territoryMode: game.territoryMode,
      bonusMode: game.bonusMode,
      bonusFlatCell: game.bonusFlatCell, bonusFlatValue: game.bonusFlatValue,
      bonusMultCell: game.bonusMultCell, bonusMultValue: game.bonusMultValue,
      obstacleMove: game.obstacleMove, itemsMode: game.itemsMode, items: game.items, itemCells: game.itemCells,
      pendingBlockOffer: game.pendingBlockOffer, pendingItemUse: game.pendingItemUse,
    };
  }
  function hostOnMessage(connId, m) {
    const id = idOfConn(connId);
    if (!id) return;
    switch (m.t) {
      case 'hello': {
        const e = entryOf(id);
        if (e) {
          if (typeof m.friendId === 'string') e.friendId = m.friendId;
          if (typeof m.name === 'string' && m.name.trim()) e.name = m.name.trim().slice(0, 12);
          Net.broadcast({ t: 'lobby', players: publicRoster() });
          renderLobby();
        }
        break;
      }
      case 'dict-sync': hostOnDictSync(m); break;
      case 'updating': {
        const e = entryOf(id);
        if (e && (phase === 'lobby' || phase === 'confirm')) {
          e.updating = true;
          updatingSlot = id;
          armUpdatingTimeout(id);
          broadcastUpdateStatus();
          renderLobby();
        }
        break;
      }
      case 'config-ack': if (phase === 'confirm') { confirmAcks.add(id); maybeAllConfirmed(); } break;
      case 'move':
        if (phase === 'game') {
          authorityHandleMove(id, { r: m.r, c: m.c, dir: m.dir, word: m.word, wildcardIndex: m.wildcardIndex });
        }
        break;
      case 'pass': if (phase === 'game') authorityPass(id, false); break;
      case 'use-item': if (phase === 'game') authorityUseItem(id, m.item, m.r, m.c); break;
      case 'use-item-start': if (phase === 'game') authorityStartClearWindow(id); break;
      case 'decline-block-offer': if (phase === 'game') authorityDeclineBlockOffer(id); break;
      case 'approve-vote': if (approval) recordVote(id, m.ok); break;
      case 'rematch-vote': if (phase === 'over' && m.ok) { rematchVotes.add(id); checkRematch(); } break;
      case 'chat': hostRelayChat(connId, id, m.text); break;
      default: break;
    }
  }
  function hostRelayChat(fromConnId, fromId, text) {
    const clean = String(text).slice(0, 200);
    receiveChat(fromId, nameOf(fromId), clean);           // ホスト自身の画面に表示
    Net.broadcast({ t: 'chat', from: fromId, name: nameOf(fromId), text: clean }, fromConnId); // 送信者以外へ中継
  }
  async function hostOnDictSync(m) {
    const union = new Set(customWords);
    for (const w of m.words) if (!baseDict.has(w)) union.add(w);
    const merged = Math.max(customUpdatedAt, m.updatedAt);
    try { adoptCustomDict(await window.api.setCustomDict({ updatedAt: merged, words: [...union] })); }
    catch { customWords = union; customUpdatedAt = merged; recomputeStartChars(); }
    $('dict-status').textContent = `辞書: ${dictCount().toLocaleString()} 語`;
    Net.broadcast({ t: 'dict-sync', updatedAt: customUpdatedAt, words: [...customWords] });
  }
  function goToLobbyAsHost(rematch, hostName) {
    mode = 'online-host'; myId = 'p0'; phase = 'lobby';
    if (!rematch) roster = [{ id: 'p0', name: hostName || 'プレーヤー1', connId: null, connected: true, friendId: myFriendCode }];
    else roster = roster.filter((p) => p.connected && p.cpuLevel !== 'coop'); // 協力モードのCPU席は次のロビーに持ち越さない
    hideAllModals();
    $('lobby-title').textContent = '相手を待っています (ホスト)';
    $('lobby-code-wrap').classList.remove('hidden');
    $('lobby-host-controls').classList.remove('hidden');
    $('btn-lobby-start').classList.remove('hidden');
    updateSizeLabel();
    if (rematch) Net.broadcast({ t: 'lobby', players: publicRoster() });
    renderLobby();
    renderLobbyFriendInvite();
    showScreen('screen-lobby');
  }
  function renderLobby() {
    const ul = $('lobby-roster'); ul.innerHTML = '';
    roster.forEach((p) => {
      const li = document.createElement('li');
      const dot = document.createElement('span'); dot.className = 'roster-dot ' + colorOf(p.id);
      const nm = document.createElement('span'); nm.textContent = p.name;
      li.appendChild(dot); li.appendChild(nm);
      if (p.updating) { const u = document.createElement('span'); u.className = 'roster-updating'; u.textContent = '(最新化中)'; li.appendChild(u); }
      if (mode !== 'offline' && p.id === myId) { const y = document.createElement('span'); y.className = 'roster-you'; y.textContent = 'あなた'; li.appendChild(y); }
      if (p.id === 'p0') { const h = document.createElement('span'); h.className = 'roster-host'; h.textContent = 'ホスト'; if (!(mode !== 'offline' && p.id === myId)) h.style.marginLeft = 'auto'; li.appendChild(h); }
      ul.appendChild(li);
    });
    if (mode === 'online-host') {
      const n = roster.length;
      const updatingNames = roster.filter((p) => p.updating).map((p) => p.name);
      if (updatingNames.length) {
        $('lobby-status').textContent = `${updatingNames.join('、')}が最新化中です。しばらくお待ちください...`;
        $('btn-lobby-start').disabled = true;
      } else {
        $('lobby-status').textContent = n < 2 ? 'ゲストの参加を待っています...(最低2人)' : `${n}人が参加中。設定を決めて開始できます。`;
        $('btn-lobby-start').disabled = n < 2;
      }
    }
  }
  function hostStartGame() {
    const n = roster.length;
    if (n < 2) return;
    boardSize = WordChain.clampSize($('size-range').value);
    timeLimitSec = Number($('lobby-time').value);
    placementMode = $('lobby-placement').value === 'random' ? 'random' : 'default';
    initialCount = Number($('lobby-initial-count').value);
    obstaclesOn = $('lobby-obstacles').checked;
    obstacleCount = Number($('lobby-obstacle-count').value);
    obstacleMoveOn = obstaclesOn && $('lobby-obstacle-move').checked;
    scoringMode = $('lobby-scoring-mode').value === 'territory' ? 'territory' : 'normal';
    bonusModeOn = $('lobby-bonus-mode').checked;
    itemsModeOn = $('lobby-items-mode').checked;
    itemClearCount = Number($('lobby-item-clear-count').value);
    itemBlockCount = Number($('lobby-item-block-count').value);
    itemWildcardCount = Number($('lobby-item-wildcard-count').value);
    coopModeOn = $('lobby-coop-mode').checked;
    coopCpuLevel = $('lobby-coop-cpu-level').value;
    if (coopModeOn && n >= WordChain.MAX_PLAYERS) {
      notice(`協力モードはCPUの1枠を確保するため、参加者は最大${WordChain.MAX_PLAYERS - 1}人までです。`);
      return;
    }
    phase = 'confirm';
    confirmAcks = new Set([myId]);
    Net.broadcast({
      t: 'config', size: boardSize, timeLimit: timeLimitSec, players: publicRoster(),
      placementMode, initialCount, obstacles: obstaclesOn, obstacleCount, scoringMode,
      bonusMode: bonusModeOn, obstacleMove: obstacleMoveOn, itemsMode: itemsModeOn,
      itemClearCount, itemBlockCount, itemWildcardCount, coopMode: coopModeOn, coopCpuLevel,
    });
    $('lobby-status').textContent = 'ゲストの確認を待っています...';
    $('btn-lobby-start').disabled = true;
    maybeAllConfirmed();
  }
  function maybeAllConfirmed() {
    if (phase !== 'confirm') return;
    const need = activeIds();
    if (need.length < 2) { phase = 'lobby'; $('btn-lobby-start').disabled = false; renderLobby(); notice('参加者が足りなくなりました。'); return; }
    if (need.every((id) => confirmAcks.has(id))) {
      if (coopModeOn && !roster.some((p) => p.cpuLevel === 'coop')) {
        roster.push({
          id: 'p' + roster.length, name: `CPU (${CPU.LEVEL_LABEL[coopCpuLevel]})`,
          connId: null, connected: true, cpuLevel: 'coop', coopLevel: coopCpuLevel,
        });
      }
      const first = randInt(roster.length);
      const initialCells = WordChain.generateInitialCells(boardSize, placementMode, initialCount);
      const initialLetters = WordChain.randomLetters(initialCells.length);
      const obstacleCells = obstaclesOn ? WordChain.generateObstacleCells(boardSize, initialCells, obstacleCount) : [];
      Net.broadcast({
        t: 'begin', size: boardSize, initialCells, initialLetters, obstacleCells,
        timeLimit: timeLimitSec, players: publicRoster(), first, scoringMode,
        bonusMode: bonusModeOn, obstacleMove: obstacleMoveOn, itemsMode: itemsModeOn,
        itemClearCount, itemBlockCount, itemWildcardCount,
      });
      beginLocalGame({
        size: boardSize, initialCells, initialLetters, obstacleCells,
        first, timeLimit: timeLimitSec, playerIds: roster.map((p) => p.id), scoringMode,
        bonusMode: bonusModeOn, obstacleMove: obstacleMoveOn, itemsMode: itemsModeOn,
        itemClearCount, itemBlockCount, itemWildcardCount,
      });
    }
  }

  // ================= オンライン: ゲスト =================
  function guestEvents() {
    return {
      onJoined: async () => {
        phase = 'lobby';
        $('lobby-title').textContent = '入室しました';
        $('lobby-code-wrap').classList.add('hidden');
        $('lobby-host-controls').classList.add('hidden');
        $('btn-lobby-start').classList.add('hidden');
        $('lobby-status').textContent = 'ホストの開始を待っています...';
        showScreen('screen-lobby');
        Net.sendHost({ t: 'hello', name: savedName, friendId: myFriendCode });
        Net.sendHost({ t: 'dict-sync', updatedAt: customUpdatedAt, words: [...customWords] });
        // 対戦部屋に入った時点で最新版か確認する (取得元は常にGitHub Releases)
        await checkAndApplyUpdateIfNeeded(
          'guest',
          { role: 'guest', roomCode: lastJoinCode, password: lastJoinPass, myName: savedName },
          () => Net.sendHost({ t: 'updating' }),
        );
      },
      onAuthFail: () => { notice('パスワードが違います。'); showScreen('screen-join'); },
      onError: (msg) => { notice(msg); resetToHome(); },
      onClosed: () => { stopTimer(); hideAllModals(); Net.leave(); notice('ホストとの接続が切れました。'); resetToHome(); },
      onMessage: (m) => guestOnMessage(m),
    };
  }
  function guestOnMessage(m) {
    switch (m.t) {
      case 'welcome': myId = m.you; break;
      case 'lobby': roster = m.players.map((p) => ({ ...p, connId: null, connected: true, updating: false })); renderLobby(); break;
      case 'updated':
        m.players.forEach((mp) => { const e = entryOf(mp.id); if (e) e.updating = mp.updating; });
        renderLobby();
        break;
      case 'dict-sync': { const merged = mergeDictLocal(m); persistDict(merged); break; }
      case 'config': guestShowConfirm(m); break;
      case 'begin':
        roster = m.players.map((p) => ({ ...p, connId: null, connected: true }));
        beginLocalGame({
          size: m.size, initialCells: m.initialCells, initialLetters: m.initialLetters, obstacleCells: m.obstacleCells,
          first: m.first, timeLimit: m.timeLimit, playerIds: m.players.map((p) => p.id), scoringMode: m.scoringMode,
          bonusMode: m.bonusMode, obstacleMove: m.obstacleMove, itemsMode: m.itemsMode,
          itemClearCount: m.itemClearCount, itemBlockCount: m.itemBlockCount, itemWildcardCount: m.itemWildcardCount,
        });
        break;
      case 'turn': guestOnTurn(m); break;
      case 'timer': setTimerDisplay(m.remainingMs, m.running); break;
      case 'move-applied': guestApplyMove(m); break;
      case 'pass-applied': guestApplyPass(m); break;
      case 'item-applied': guestApplyItem(m); break;
      case 'item-rejected': notice(m.reason || 'アイテムを使用できませんでした。'); break;
      case 'item-window-start':
        if (game) {
          game.pendingItemUse = { playerId: m.by, item: m.item, expiresAt: m.expiresAt };
          if (m.by === myId) {
            itemTargetMode = { item: 'clear', playerId: m.by };
            renderItemTargets(); updateItemButtons();
          } else {
            setStatus(`${nameOf(m.by)}が「クリア」を使用中...`);
          }
          startClearCountdownUI(m.expiresAt);
        }
        break;
      case 'block-offer':
        if (game) { game.pendingBlockOffer = { playerId: m.playerId }; showBlockOfferModal(m.playerId); }
        break;
      case 'approve-start': if (game) showApproveModal(m.by, m.word); break;
      case 'approve-end': hideModal('modal-approve'); break;
      case 'move-rejected': handleLocalReject(m.reason); break;
      case 'status': setStatus(m.text || ''); break;
      case 'chat': receiveChat(m.from, m.name || nameOf(m.from), m.text); break;
      case 'game-over': guestGameOver(m); break;
      case 'player-disc': { const e = entryOf(m.id); if (e) e.connected = false; if (game) renderScores(); break; }
      case 'player-left': if (game) WordChain.removePlayer(game, m.id); { const e = entryOf(m.id); if (e) e.connected = false; } if (game) refreshAll(); break;
      case 'player-rejoined': { const e = entryOf(m.id); if (e) e.connected = true; if (game) refreshAll(); break; }
      case 'paused': m.waiting ? (phase = 'paused', overlay('ホストが対応を選んでいます...')) : (phase = 'game', hideOverlay()); break;
      case 'resync': guestResync(m); break;
      case 'rematch-lobby': guestRematchLobby(); break;
      case 'rematch-progress': $('rematch-status').textContent = `再戦の同意: ${m.got} / ${m.need}`; break;
      case 'bye': stopTimer(); hideAllModals(); Net.leave(); notice('ホストが退出しました。'); resetToHome(); break;
      default: break;
    }
  }
  function mergeDictLocal(m) { const union = new Set(customWords); for (const w of m.words) if (!baseDict.has(w)) union.add(w); return { updatedAt: Math.max(customUpdatedAt, m.updatedAt), words: [...union] }; }
  async function persistDict(merged) {
    try { adoptCustomDict(await window.api.setCustomDict(merged)); } catch { adoptCustomDict(merged); }
    $('dict-status').textContent = `辞書: ${dictCount().toLocaleString()} 語`;
  }
  function guestShowConfirm(m) {
    phase = 'confirm';
    roster = m.players.map((p) => ({ ...p, connId: null, connected: true }));
    const names = m.players.map((p) => p.name + (p.id === myId ? '(あなた)' : '')).join('、');
    $('confirm-detail').innerHTML =
      `<div class="row"><span>盤面サイズ</span><span>${m.size} × ${m.size}</span></div>` +
      `<div class="row"><span>入力時間</span><span>${timeText(m.timeLimit)}</span></div>` +
      `<div class="row"><span>初期文字の配置</span><span>${m.placementMode === 'random' ? 'ランダム' : 'デフォルト (中央)'}</span></div>` +
      `<div class="row"><span>初期文字の数</span><span>${m.initialCount} マス</span></div>` +
      `<div class="row"><span>お邪魔マス</span><span>${m.obstacles ? `あり (${m.obstacleCount}マス${m.obstacleMove ? '・移動あり' : ''})` : 'なし'}</span></div>` +
      `<div class="row"><span>対戦モード</span><span>${m.scoringMode === 'territory' ? '陣取りモード' : '通常モード'}</span></div>` +
      `<div class="row"><span>ボーナスマス</span><span>${m.bonusMode ? 'あり' : 'なし'}</span></div>` +
      `<div class="row"><span>アイテム</span><span>${m.itemsMode ? `あり (クリア${m.itemClearCount}・ブロック${m.itemBlockCount}・ワイルドカード${m.itemWildcardCount}を盤面に配置)` : 'なし'}</span></div>` +
      `<div class="row"><span>協力モード</span><span>${m.coopMode ? `あり (CPU 1体 vs プレーヤー全員、強さ: ${CPU.LEVEL_LABEL[m.coopCpuLevel] || '普通'})` : 'なし'}</span></div>` +
      `<div class="row"><span>参加者 (${m.players.length}人)</span><span>${escapeHtml(names)}</span></div>`;
    showModal('modal-confirm');
  }
  function timeText(s) { if (s <= 0) return '無制限'; return s >= 60 ? `${s / 60}分` : `${s}秒`; }
  function guestOnTurn(m) {
    if (!game) return;
    const idx = game.players.indexOf(m.by);
    if (idx >= 0) game.turnIdx = idx;
    pendingMove = null; localProposal = null;
    selection = { r: null, c: null, dir: null };
    itemTargetMode = null;
    game.pendingBlockOffer = null; // 'turn'が届いた時点でオファーは解決済み
    stopClearCountdownUI();
    hideDirPanel(); hideModal('modal-word'); hideBlockOfferModal();
    setTimerDisplay(m.remainingMs, true);
    game.bonusFlatCell = m.bonusFlatCell || null;
    game.bonusFlatValue = m.bonusFlatValue || null;
    game.bonusMultCell = m.bonusMultCell || null;
    game.bonusMultValue = m.bonusMultValue || null;
    if (Array.isArray(m.obstacleCells)) {
      const size = game.size;
      const blocked = Array.from({ length: size }, () => Array(size).fill(false));
      for (const [r, c] of m.obstacleCells) blocked[r][c] = true;
      game.blocked = blocked;
    }
    refreshAll();
    const cur = WordChain.currentPlayer(game);
    if (cur === myId) {
      if (m.remainingMs >= 0) timer.onTimeout = guestSelfPass; // 自分の番なら時間切れで自分からパスを送る (無制限は対象外)
      Sound.sfx('turn');
      if (!WordChain.hasAnyPlacement(game)) setStatus('置ける場所がありません。パスしてください。');
      else if (game.chain) { setStatus('あなたの番です。方向を選んでください。'); selectCell(game.chain.r, game.chain.c); }
      else setStatus('あなたの番です。初期文字のマスを選んでください。');
    } else setStatus(`${nameOf(cur)}の番です...`);
  }
  function guestSelfPass() {
    if (mode !== 'online-guest' || !game || game.over) return;
    if (WordChain.currentPlayer(game) !== myId) return;
    if (pendingMove || approval) return; // 送信済み/承認中は二重に送らない
    pendingMove = null; localProposal = null;
    hideModal('modal-word'); hideDirPanel();
    Net.sendHost({ t: 'pass' });
    setStatus('時間切れでパスしました。');
  }
  function guestApplyMove(m) {
    if (!game) return;
    const idx = game.players.indexOf(m.by);
    if (idx >= 0) game.turnIdx = idx;
    const move = { r: m.r, c: m.c, dir: m.dir, word: m.word, wildcardIndex: m.wildcardIndex };
    const { placed, captured, flatValue, multValue, itemsGot } = WordChain.applyMove(game, move, m.by);
    const flatCell = flatValue ? game.bonusFlatCell : null;
    const multCell = multValue ? game.bonusMultCell : null;
    renderPlaced(placed, m.by);
    renderCaptured(captured, m.by);
    drawLastWordLine(move, m.by);
    addHistoryWord(m.word, m.by, game.history[game.history.length - 1]);
    if (m.approved) { Sound.sfx('approve'); if (!inDict(m.word)) addWordToDict(m.word); }
    if (flatValue || multValue) showBonusGet(flatValue, multValue, flatCell, multCell);
    showItemGet(itemsGot);
    pendingMove = null;
    refreshAll();
  }
  function guestApplyPass(m) {
    if (!game) return;
    const idx = game.players.indexOf(m.by);
    if (idx >= 0) game.turnIdx = idx;
    addHistoryPass(m.by);
    WordChain.applyPass(game);
    refreshAll();
  }
  function guestGameOver(m) {
    if (!game) return;
    if (m.scores) game.scores = m.scores;
    game.over = true;
    onGameOver();
  }
  function guestResync(m) {
    roster = m.players.map((p) => ({ ...p, connId: null, connected: true }));
    timeLimitSec = m.timeLimit; boardSize = m.size;
    game = WordChain.newGame({
      size: m.size, initialCells: m.initialCells, initialLetters: Array(m.initialCells.length).fill('あ'),
      players: m.players.map((p) => p.id), first: 0, timeLimit: m.timeLimit,
    });
    game.board = m.board; game.owner = m.owner; game.blocked = m.blocked; game.scores = m.scores;
    game.active = m.active; game.turnIdx = m.turnIdx; game.chain = m.chain;
    game.usedWords = new Set(m.used); game.history = m.history; game.over = m.over;
    game.territoryMode = !!m.territoryMode;
    game.bonusMode = !!m.bonusMode;
    game.bonusFlatCell = m.bonusFlatCell || null; game.bonusFlatValue = m.bonusFlatValue || null;
    game.bonusMultCell = m.bonusMultCell || null; game.bonusMultValue = m.bonusMultValue || null;
    game.obstacleMove = !!m.obstacleMove;
    game.itemsMode = !!m.itemsMode; game.items = m.items || {};
    game.itemCells = m.itemCells || { clear: [], block: [], wildcard: [] };
    game.pendingBlockOffer = m.pendingBlockOffer || null;
    game.pendingItemUse = m.pendingItemUse || null;
    phase = 'game'; hideAllModals();
    buildBoardDOM();
    $('history').innerHTML = '';
    game.history.forEach((h) => { h.pass ? addHistoryPass(h.by) : addHistoryWord(h.word, h.by, h); });
    showScreen('screen-game');
    renderRoomCode();
    setTimerDisplay(m.remainingMs, false);
    refreshAll();
    setStatus('再接続しました。ホストの再開を待っています...');
  }
  function guestRematchLobby() {
    hideAllModals(); phase = 'lobby';
    $('lobby-title').textContent = '再戦の準備中';
    $('lobby-code-wrap').classList.add('hidden');
    $('lobby-host-controls').classList.add('hidden');
    $('btn-lobby-start').classList.add('hidden');
    $('lobby-status').textContent = 'ホストが次のゲームを設定しています...';
    renderLobby();
    showScreen('screen-lobby');
  }

  // ---------------- 共通遷移 ----------------
  function resetToHome() {
    stopTimer();
    stopClearCountdownUI();
    if (cpuTimer) { clearTimeout(cpuTimer); cpuTimer = null; }
    game = null; phase = 'home'; roster = []; myId = null; myRoomPassword = null;
    approval = null; waitingSlot = null; discInfo = null; pendingMove = null; localProposal = null;
    updatingSlot = null; disarmUpdatingTimeout(); hideUpdateBanner();
    cleanupWaitButtons(); updateRecordDisplays();
    closeChat(); updateChatVisibility();
    showScreen('screen-home');
  }
  function leaveEverything() { stopTimer(); hideAllModals(); Net.leave(); resetToHome(); }

  // ================= チャット (オンライン) =================
  let chatUnread = 0;
  function updateChatVisibility() {
    const show = (mode === 'online-host' || mode === 'online-guest') && phase !== 'home' && game;
    $('chat-bubble').classList.toggle('hidden', !show);
    if (!show) { $('chat-panel').classList.add('hidden'); }
  }
  function openChat() {
    $('chat-panel').classList.remove('hidden');
    chatUnread = 0; $('chat-badge').classList.add('hidden');
    setTimeout(() => $('chat-input').focus(), 30);
    $('chat-log').scrollTop = $('chat-log').scrollHeight;
  }
  function closeChat() { $('chat-panel').classList.add('hidden'); $('chat-log').innerHTML = ''; chatUnread = 0; $('chat-badge').classList.add('hidden'); hideModal('chat-toast'); }
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
    // ポップアップ表示
    $('chat-toast').innerHTML = `<div class="chat-toast-name"></div><div class="chat-toast-msg"></div>`;
    $('chat-toast').querySelector('.chat-toast-name').textContent = name;
    $('chat-toast').querySelector('.chat-toast-msg').textContent = text;
    $('chat-toast').classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('chat-toast').classList.add('hidden'), 4200);
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
    if (!text || !(mode === 'online-host' || mode === 'online-guest')) return;
    input.value = '';
    appendChatLine(myId, nameOf(myId), text, true);
    if (mode === 'online-host') Net.broadcast({ t: 'chat', from: myId, name: nameOf(myId), text });
    else Net.sendHost({ t: 'chat', text });
  }

  // ================= 設定 (音量・辞書編集) =================
  async function openSettings() {
    $('settings-error').textContent = ''; $('settings-add-input').value = ''; $('settings-filter').value = '';
    // 音量スライダーを現在値に
    const bv = Math.round(Sound.getBgmVolume() * 100);
    const sv = Math.round(Sound.getSfxVolume() * 100);
    $('vol-bgm').value = bv; $('vol-bgm-label').textContent = bv + '%';
    $('vol-sfx').value = sv; $('vol-sfx-label').textContent = sv + '%';
    renderSettingsList(); showScreen('screen-settings');
    let hasBackup = false;
    try { hasBackup = window.api && window.api.hasBackup ? await window.api.hasBackup() : false; } catch { hasBackup = false; }
    $('btn-rollback').classList.toggle('hidden', !hasBackup);
  }
  async function onRollbackClick() {
    if (!window.api || !window.api.rollbackUpdate) return;
    $('btn-rollback').disabled = true;
    const result = await window.api.rollbackUpdate();
    if (!result || !result.ok) {
      $('btn-rollback').disabled = false;
      notice('前のバージョンに戻せませんでした。');
    }
    // 成功時はまもなくアプリが再起動する
  }
  function renderSettingsList() {
    const filter = WordChain.katakanaToHiragana($('settings-filter').value.trim());
    const all = [...customWords].sort();
    const shown = filter ? all.filter((w) => w.includes(filter)) : all;
    const list = $('settings-word-list'); list.innerHTML = '';
    const dt = customUpdatedAt ? new Date(customUpdatedAt).toLocaleString('ja-JP') : 'なし';
    $('settings-meta').textContent = `追加済み: ${all.length} 語 (表示 ${shown.length}) / 最終更新: ${dt}`;
    if (shown.length === 0) {
      const li = document.createElement('li'); li.className = 'empty';
      li.textContent = all.length === 0 ? 'まだ追加された単語はありません。' : '該当する単語がありません。';
      list.appendChild(li); return;
    }
    for (const w of shown) {
      const li = document.createElement('li');
      const span = document.createElement('span'); span.textContent = w;
      const del = document.createElement('button'); del.className = 'word-del'; del.textContent = '削除';
      del.addEventListener('click', () => removeSettingsWord(w));
      li.appendChild(span); li.appendChild(del); list.appendChild(li);
    }
  }
  async function addSettingsWord() {
    const word = WordChain.katakanaToHiragana(WordChain.romajiToHiragana($('settings-add-input').value.trim(), true));
    if (!WordChain.WORD_RE.test(word)) { $('settings-error').textContent = `ひらがな2〜${WordChain.SIZE_MAX}文字で入力してください。`; return; }
    if (baseDict.has(word)) { $('settings-error').textContent = 'その単語は基本辞書に既に含まれています。'; return; }
    if (customWords.has(word)) { $('settings-error').textContent = 'その単語は既に追加されています。'; return; }
    $('settings-error').textContent = ''; $('settings-add-input').value = '';
    try { adoptCustomDict(await window.api.addCustomWord(word)); } catch {}
    renderSettingsList(); $('settings-add-input').focus();
  }
  async function removeSettingsWord(word) { try { adoptCustomDict(await window.api.removeCustomWord(word)); } catch {} renderSettingsList(); }

  // ローマ字直接入力→ひらがな即時変換 (OSのIME変換候補に頼らない)。
  // maxHiragana指定時は、変換後のひらがな文字数を超えた分を切り詰める。
  // IME変換中(isComposing)は競合を避けるため何もしない。
  function liveRomajiConvert(el, maxHiragana, isComposing) {
    if (isComposing) return;
    const raw = el.value;
    let converted = WordChain.romajiToHiragana(raw, false);
    if (typeof maxHiragana === 'number' && [...converted].length > maxHiragana) {
      converted = [...converted].slice(0, maxHiragana).join('');
    }
    if (converted !== raw) el.value = converted;
  }

  // お邪魔マスの数(手入力)は盤面サイズが変わるたびに上限(全マスの20%)を更新し、
  // 現在値がそれを超えていれば切り詰める。
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

  // 初期文字の配置(デフォルト/ランダム)によって選べる「初期文字の数」の候補が変わる
  function populateInitialCountOptions(sel, placement) {
    const opts = placement === 'random' ? Array.from({ length: 10 }, (_, i) => i + 1) : [1, 4];
    const prev = Number(sel.value);
    sel.innerHTML = '';
    const fallback = opts.includes(4) ? 4 : opts[opts.length - 1];
    for (const n of opts) {
      const o = document.createElement('option');
      o.value = String(n); o.textContent = `${n}マス`;
      if (n === (opts.includes(prev) ? prev : fallback)) o.selected = true;
      sel.appendChild(o);
    }
  }

  // ================= イベント配線 =================
  $('btn-goto-create').addEventListener('click', () => { $('create-name').value = savedName; $('create-password').value = ''; $('create-error').textContent = ''; showScreen('screen-create'); $('create-name').focus(); });
  $('btn-goto-join').addEventListener('click', () => { $('join-name').value = savedName; $('join-code').value = ''; $('join-password').value = ''; $('join-error').textContent = ''; showScreen('screen-join'); $('join-name').focus(); });
  $('btn-goto-offline').addEventListener('click', () => { updateOfflineSizeLabel(); populateInitialCountOptions($('offline-initial-count'), $('offline-placement').value); showScreen('screen-offline'); });
  $('btn-goto-settings').addEventListener('click', openSettings);
  $('btn-goto-friends').addEventListener('click', () => {
    $('friend-add-code').value = ''; $('friend-add-name').value = ''; $('friend-add-error').textContent = '';
    renderFriendList();
    showScreen('screen-friends');
  });
  $('btn-friends-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-copy-friend-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(myFriendCode || ''); }
    catch { /* クリップボードが使えない環境では何もしない */ }
  });
  $('btn-friend-add').addEventListener('click', async () => {
    const code = $('friend-add-code').value.trim().toLowerCase();
    const name = $('friend-add-name').value.trim();
    if (!Presence.CODE_RE.test(code)) {
      $('friend-add-error').textContent = `フレンドコードは${Presence.CODE_LEN}文字の英数字です。`;
      return;
    }
    if (code === myFriendCode) { $('friend-add-error').textContent = '自分自身は登録できません。'; return; }
    if (!name) { $('friend-add-error').textContent = '表示名を入力してください。'; return; }
    const data = await window.api.addFriend(code, name);
    friendList = Array.isArray(data.friends) ? data.friends : [];
    $('friend-add-code').value = ''; $('friend-add-name').value = ''; $('friend-add-error').textContent = '';
    renderFriendList();
  });
  $('btn-invite-join').addEventListener('click', () => {
    if (!pendingInvite) return;
    const { roomCode, password } = pendingInvite;
    $('invite-banner').classList.add('hidden');
    pendingInvite = null;
    leaveEverything();
    showScreen('screen-join');
    startJoinFlow(roomCode, password, savedName);
  });
  $('btn-invite-dismiss').addEventListener('click', () => {
    $('invite-banner').classList.add('hidden');
    pendingInvite = null;
  });
  $('btn-create-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-join-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-offline-back').addEventListener('click', () => showScreen('screen-home'));
  $('btn-settings-back').addEventListener('click', () => { $('dict-status').textContent = `辞書: ${dictCount().toLocaleString()} 語`; showScreen('screen-home'); });
  $('btn-rollback').addEventListener('click', onRollbackClick);
  $('btn-settings-add').addEventListener('click', addSettingsWord);
  $('settings-add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) addSettingsWord(); });
  $('settings-add-input').addEventListener('input', (e) => liveRomajiConvert($('settings-add-input'), WordChain.SIZE_MAX, e.isComposing));
  $('settings-filter').addEventListener('input', (e) => { liveRomajiConvert($('settings-filter'), undefined, e.isComposing); renderSettingsList(); });
  $('size-range').addEventListener('input', updateSizeLabel);
  $('offline-size-range').addEventListener('input', updateOfflineSizeLabel);
  $('btn-offline-start').addEventListener('click', startOffline);
  $('lobby-placement').addEventListener('change', () => populateInitialCountOptions($('lobby-initial-count'), $('lobby-placement').value));
  $('offline-placement').addEventListener('change', () => populateInitialCountOptions($('offline-initial-count'), $('offline-placement').value));
  populateInitialCountOptions($('lobby-initial-count'), $('lobby-placement').value);
  populateInitialCountOptions($('offline-initial-count'), $('offline-placement').value);

  // お邪魔マスの数(選択欄)は、チェックボックスがONのときだけ表示
  $('lobby-obstacles').addEventListener('change', () => {
    const on = $('lobby-obstacles').checked;
    $('lobby-obstacle-count-field').classList.toggle('hidden', !on);
    $('lobby-obstacle-move-field').classList.toggle('hidden', !on);
  });
  $('offline-obstacles').addEventListener('change', () => {
    const on = $('offline-obstacles').checked;
    $('offline-obstacle-count-field').classList.toggle('hidden', !on);
    $('offline-obstacle-move-field').classList.toggle('hidden', !on);
  });
  // お邪魔マスの数(手入力)は、盤面サイズに応じた上限(全マスの20%)を超えないようその場で切り詰める
  $('lobby-obstacle-count').addEventListener('input', () => {
    const cap = WordChain.maxObstacleCount(WordChain.clampSize($('size-range').value));
    const el = $('lobby-obstacle-count');
    if (Number(el.value) > cap) el.value = String(cap);
  });
  $('offline-obstacle-count').addEventListener('input', () => {
    const cap = WordChain.maxObstacleCount(WordChain.clampSize($('offline-size-range').value));
    const el = $('offline-obstacle-count');
    if (Number(el.value) > cap) el.value = String(cap);
  });

  // オフラインの対戦相手がCPUのときだけ強さの選択欄を表示
  $('offline-opponent').addEventListener('change', () => { $('offline-cpu-level-field').classList.toggle('hidden', $('offline-opponent').value !== 'cpu'); });
  // 協力モード有効時は、通常の対戦相手選択(人間/CPU)を隠し、人数を最大3人(CPU分の1枠を確保)に制限する
  $('offline-coop-mode').addEventListener('change', () => {
    const on = $('offline-coop-mode').checked;
    $('offline-opponent-field').classList.toggle('hidden', on);
    $('offline-cpu-level-field').classList.toggle('hidden', on || $('offline-opponent').value !== 'cpu');
    $('offline-coop-cpu-level-field').classList.toggle('hidden', !on);
    if (on && Number($('offline-count').value) > WordChain.MAX_PLAYERS - 1) $('offline-count').value = String(WordChain.MAX_PLAYERS - 1);
  });
  // オンラインロビーで協力モードを有効にしたときだけ、CPUの強さ選択欄を表示
  $('lobby-coop-mode').addEventListener('change', () => {
    $('lobby-coop-cpu-level-field').classList.toggle('hidden', !$('lobby-coop-mode').checked);
  });
  // アイテムを有効にしたときだけ、回数設定欄を表示
  $('offline-items-mode').addEventListener('change', () => {
    $('offline-item-counts-field').classList.toggle('hidden', !$('offline-items-mode').checked);
  });
  $('lobby-items-mode').addEventListener('change', () => {
    $('lobby-item-counts-field').classList.toggle('hidden', !$('lobby-items-mode').checked);
  });
  // アイテムの回数は0〜9に収める
  const ITEM_COUNT_MAX = 9;
  for (const id of [
    'offline-item-clear-count', 'offline-item-block-count', 'offline-item-wildcard-count',
    'lobby-item-clear-count', 'lobby-item-block-count', 'lobby-item-wildcard-count',
  ]) {
    $(id).addEventListener('input', () => {
      const el = $(id);
      const n = Number(el.value);
      if (Number.isNaN(n) || n < 0) el.value = '0';
      else if (n > ITEM_COUNT_MAX) el.value = String(ITEM_COUNT_MAX);
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
    if (!audioUnlocked) { audioUnlocked = true; try { Sound.unlock(); Sound.startBgm(); } catch {} }
    const b = e.target.closest && e.target.closest('.btn, .dir-btn, .word-del');
    if (b && !b.disabled) Sound.sfx('button');
  }, true);

  $('btn-create').addEventListener('click', async () => {
    const pass = $('create-password').value;
    if (pass.length < 4 || pass.length > 64) { $('create-error').textContent = 'パスワードは4〜64文字で入力してください。'; return; }
    const name = ($('create-name').value.trim() || 'プレーヤー1').slice(0, 12);
    savedName = name;
    // 部屋を作る前に最新版か確認する (まだ誰も入室していないので、更新する場合も安全に再起動できる)
    $('btn-create').disabled = true;
    const willRestart = await checkAndApplyUpdateIfNeeded('host');
    if (willRestart) return; // アプリはまもなく終了・再起動する
    $('btn-create').disabled = false;
    myRoomPassword = pass;
    goToLobbyAsHost(false, name);
    $('lobby-code').textContent = '......'; $('lobby-status').textContent = '部屋を作成中...';
    Net.createRoom(pass, hostEvents());
  });
  function startJoinFlow(code, pass, name) {
    savedName = (name || savedName || 'プレーヤー2').slice(0, 12);
    lastJoinCode = code; lastJoinPass = pass;
    mode = 'online-guest'; myId = null; roster = []; phase = 'lobby';
    $('lobby-title').textContent = '接続中...'; $('lobby-code-wrap').classList.add('hidden');
    $('lobby-host-controls').classList.add('hidden'); $('btn-lobby-start').classList.add('hidden');
    $('lobby-status').textContent = 'ホストに接続しています...';
    showScreen('screen-lobby');
    Net.joinRoom(code, pass, guestEvents());
  }
  $('btn-join').addEventListener('click', () => {
    const code = Net.normalizeCode($('join-code').value);
    if (!code) { $('join-error').textContent = '部屋コードは6文字の英数字です。'; return; }
    const pass = $('join-password').value;
    if (pass.length < 4 || pass.length > 64) { $('join-error').textContent = 'パスワードは4〜64文字で入力してください。'; return; }
    $('join-error').textContent = '';
    startJoinFlow(code, pass, $('join-name').value.trim());
  });
  $('btn-copy-code').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('lobby-code').textContent); $('lobby-status').textContent = 'コピーしました。'; }
    catch { $('lobby-status').textContent = 'コピーに失敗しました。手動で控えてください。'; }
  });
  $('btn-lobby-start').addEventListener('click', () => { if (mode === 'online-host') hostStartGame(); });
  $('btn-lobby-back').addEventListener('click', leaveEverything);

  $('btn-confirm-ok').addEventListener('click', () => { hideModal('modal-confirm'); overlay('ホストの開始を待っています...'); Net.sendHost({ t: 'config-ack' }); });
  $('btn-confirm-leave').addEventListener('click', leaveEverything);

  $('btn-disc-wait').addEventListener('click', () => hostDisc('wait'));
  $('btn-disc-continue').addEventListener('click', () => hostDisc('continue'));
  $('btn-disc-end').addEventListener('click', () => hostDisc('end'));

  $('btn-leave').addEventListener('click', leaveEverything);
  $('btn-pass').addEventListener('click', () => { if (isMyInputTurn()) submitLocalPass(); });

  $('board').addEventListener('click', (e) => {
    const el = e.target.closest('.cell');
    if (!el || !game) return;
    const r = Number(el.dataset.r), c = Number(el.dataset.c);
    if (itemTargetMode) {
      const { item, playerId } = itemTargetMode;
      if (mode === 'online-guest') Net.sendHost({ t: 'use-item', item, r, c });
      else authorityUseItem(playerId, item, r, c);
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
    const holderId = game && game.pendingBlockOffer && game.pendingBlockOffer.playerId;
    if (!holderId) return;
    if (mode === 'online-guest') Net.sendHost({ t: 'decline-block-offer' });
    else authorityDeclineBlockOffer(holderId);
  });
  document.querySelectorAll('.dir-btn').forEach((b) => {
    b.addEventListener('click', () => { if (!isMyInputTurn() || selection.r === null) return; selection.dir = Number(b.dataset.dir); openWordModal(); });
  });
  $('btn-word-ok').addEventListener('click', submitWord);
  $('word-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) submitWord(); });
  $('word-input').addEventListener('input', (e) => { const inp = $('word-input'); liveRomajiConvert(inp, Number(inp.dataset.maxHiragana) || undefined, e.isComposing); });
  $('btn-word-cancel').addEventListener('click', () => {
    hideModal('modal-word'); localProposal = null;
    if (isAuthority()) { resumeTimer(); if (mode === 'online-host') Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: true }); }
  });
  $('btn-propose-yes').addEventListener('click', () => { if (!localProposal) return; const move = localProposal; localProposal = null; submitLocalMove(move); });
  $('btn-propose-no').addEventListener('click', () => {
    localProposal = null;
    $('word-propose').classList.add('hidden'); $('word-buttons').classList.remove('hidden');
    $('word-input').disabled = false; $('word-input').focus();
    if (isAuthority()) { resumeTimer(); if (mode === 'online-host') Net.broadcast({ t: 'timer', remainingMs: timer.remaining, running: true }); }
  });
  $('btn-approve-yes').addEventListener('click', () => onApproveClick(true));
  $('btn-approve-no').addEventListener('click', () => onApproveClick(false));

  $('btn-rematch').addEventListener('click', onRematchClick);
  $('btn-result-exit').addEventListener('click', leaveEverything);
  $('btn-notice-ok').addEventListener('click', () => hideModal('modal-notice'));

  $('join-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('create-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });
  $('join-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
  $('create-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-create').click(); });

  init();
})();
