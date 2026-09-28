'use strict';
// 1つの部屋の進行管理。以前はホストのPCが担っていた「権威」(手の検証・手番・時間切れ・
// 承認投票・アイテム・CPU・切断時の対応・再戦)をサーバーで行う。
// ゲームのルールそのものは shared/game.js (WordChain)、CPUの手選びは shared/cpu.js を使う。
//
// クライアントとのやり取りは socket.io の 'msg' イベントで、{ t: 種類, ... } の形
// (デスクトップ版のホスト⇔ゲスト間の通信内容をほぼそのまま引き継いでいる)。
// ボーナスマス・アイテムマスの位置は隠し情報なので、クライアントには取った瞬間にだけ知らせる。

const crypto = require('crypto');
const WordChain = require('../shared/game');
global.WordChain = WordChain; // shared/cpu.js が参照する
const CPU = require('../shared/cpu');

const MAX_PLAYERS = WordChain.MAX_PLAYERS;
const DISCONNECT_GRACE_MS = 5000; // 再読み込み等の一瞬の切断では対戦を止めない
const ITEM_COUNT_MAX = 9;

function randInt(max) { return crypto.randomInt(max); }

// CPU用の辞書索引(辞書が変わったら作り直す)
let cpuCache = { version: -1, index: null, counts: null };
function cpuIndex(dict) {
  if (cpuCache.version !== dict.version) {
    const sets = [dict.baseWords(), dict.customWords()];
    cpuCache = { version: dict.version, index: CPU.buildWordIndex(sets), counts: CPU.buildStartCharCounts(sets) };
  }
  return cpuCache;
}

// クライアントから来た対戦設定を検証して、使える値に丸める
function sanitizeSettings(s, { forCpu } = {}) {
  s = s || {};
  const size = WordChain.clampSize(s.size);
  const timeLimit = WordChain.TIME_CHOICES.includes(Number(s.timeLimit)) ? Number(s.timeLimit) : 30;
  const placementMode = s.placementMode === 'random' ? 'random' : 'default';
  const ic = Math.round(Number(s.initialCount)) || 4;
  const initialCount = placementMode === 'random' ? Math.max(1, Math.min(10, ic)) : (ic === 1 ? 1 : 4);
  const obstacles = !!s.obstacles;
  const obstacleCount = Math.max(1, Math.min(WordChain.maxObstacleCount(size), Math.round(Number(s.obstacleCount)) || 1));
  const itemCount = v => Math.max(0, Math.min(ITEM_COUNT_MAX, Math.round(Number(v)) || 0));
  const level = v => (CPU.LEVELS.includes(v) ? v : 'normal');
  const out = {
    size, timeLimit, placementMode, initialCount, obstacles, obstacleCount,
    obstacleMove: obstacles && !!s.obstacleMove,
    scoringMode: s.scoringMode === 'territory' ? 'territory' : 'normal',
    bonusMode: !!s.bonusMode,
    itemsMode: !!s.itemsMode,
    itemClearCount: itemCount(s.itemClearCount ?? 1),
    itemBlockCount: itemCount(s.itemBlockCount ?? 1),
    itemWildcardCount: itemCount(s.itemWildcardCount ?? 1),
    coopMode: !!s.coopMode,
    coopCpuLevel: level(s.coopCpuLevel),
  };
  if (forCpu) {
    out.cpuCount = Math.max(1, Math.min(MAX_PLAYERS - 1, Math.round(Number(s.cpuCount)) || 1));
    out.cpuLevel = level(s.cpuLevel);
  }
  return out;
}

class Room {
  constructor({ id, io, dict, records, vsCpu, onChange, onDestroy }) {
    Object.assign(this, { id, io, dict, records, vsCpu: !!vsCpu, onChange, onDestroy });
    this.phase = 'lobby'; // lobby | confirm | game | paused | over
    this.roster = [];     // { id:'p0'.., userId, name, guest, connected, sockets:Set, cpuLevel, coopLevel }
    this.ownerPid = null; // 設定を決めて開始できる人(部屋を作った人。抜けたら次の人)
    this.settings = null;
    this.game = null;
    this.timer = { remaining: -1, running: false, lastTick: 0 };
    this.tickHandle = null;
    this.approval = null;
    this.proposal = null; // 辞書に無い単語を承認に出すか、本人が考えている間 { pid, move }
    this.confirmAcks = new Set();
    this.rematchVotes = new Set();
    this.discInfo = null;
    this.goneTimers = new Map();
    this.cpuTimer = null;
    this.clearTimer = null;
    this.abandonTimer = null;
    this.lastActive = Date.now();
  }

  /* ───────────── 送信 ───────────── */
  get allRoom() { return `wc:${this.id}`; }
  pidRoom(pid) { return `wc:${this.id}:${pid}`; }
  send(pid, msg) { this.io.to(this.pidRoom(pid)).emit('msg', msg); }
  broadcast(msg, exceptPid) {
    const target = exceptPid ? this.io.to(this.allRoom).except(this.pidRoom(exceptPid)) : this.io.to(this.allRoom);
    target.emit('msg', msg);
  }
  changed() { this.lastActive = Date.now(); if (this.onChange) this.onChange(this); }

  entry(pid) { return this.roster.find(p => p.id === pid); }
  entryByUser(userId) { return this.roster.find(p => p.userId === userId); }
  nameOf(pid) { const e = this.entry(pid); return e ? e.name : pid; }
  humans() { return this.roster.filter(p => !p.cpuLevel); }
  connectedHumans() { return this.humans().filter(p => p.connected); }
  publicRoster() {
    return this.roster.map(p => ({ id: p.id, name: p.name, cpuLevel: p.cpuLevel || null, connected: p.connected }));
  }
  broadcastLobby() { this.broadcast({ t: 'lobby', players: this.publicRoster(), owner: this.ownerPid, vsCpu: this.vsCpu }); }

  // ロビーに出す要約
  summary() {
    const status = this.phase === 'lobby' || this.phase === 'confirm' ? 'waiting'
      : this.phase === 'game' || this.phase === 'paused' ? 'playing' : null;
    if (!status) return null;
    if (status === 'waiting' && !this.connectedHumans().length) return null;
    const s = this.settings;
    const detail = status === 'playing' && s ? `${s.size}×${s.size} / ${this.roster.length}人${this.vsCpu ? '(CPU戦)' : ''}` : `${this.humans().length}/${MAX_PLAYERS}人`;
    return {
      id: this.id, status, vsCpu: this.vsCpu, capacity: MAX_PLAYERS,
      spectators: Math.max(0, (this.io.sockets.adapter.rooms.get(this.allRoom)?.size || 0) - this.roster.reduce((n, p) => n + p.sockets.size, 0)),
      players: this.roster.map(p => ({ userId: p.cpuLevel ? `CPU:${p.id}` : p.userId, name: p.name })),
      detail,
    };
  }

  /* ───────────── 参加・退出 ───────────── */
  freeSlot() { for (let i = 0; i < MAX_PLAYERS; i++) if (!this.entry(`p${i}`)) return `p${i}`; return null; }

  attach(entry, socket) {
    socket.join(this.allRoom);
    socket.join(this.pidRoom(entry.id));
    socket.data.wc = { roomId: this.id, pid: entry.id };
    entry.sockets.add(socket.id);
    entry.connected = true;
    const t = this.goneTimers.get(entry.id);
    if (t) { clearTimeout(t); this.goneTimers.delete(entry.id); }
    this.checkAbandon();
  }

  // 参加(同じユーザーが開き直した場合は同じ席に戻す)。戻り値 { ok, error? }
  join(user, socket) {
    let e = this.entryByUser(user.userId);
    if (!e) {
      if (this.vsCpu) return { ok: false, error: 'CPU戦の部屋には入れません(観戦はできます)' };
      if (this.phase !== 'lobby' && this.phase !== 'confirm') return { ok: false, error: 'この部屋は対戦中です(観戦はできます)' };
      const slot = this.freeSlot();
      if (!slot || this.humans().length >= MAX_PLAYERS) return { ok: false, error: 'この部屋は満員です' };
      e = { id: slot, userId: user.userId, name: user.username, guest: !!user.guest, connected: true, sockets: new Set(), cpuLevel: null };
      this.roster.push(e);
      this.roster.sort((a, b) => a.id.localeCompare(b.id));
      if (!this.ownerPid) this.ownerPid = e.id;
    }
    const wasDisconnected = !e.connected;
    this.attach(e, socket);
    this.send(e.id, { t: 'welcome', you: e.id, roomCode: this.id, vsCpu: this.vsCpu });
    if (this.phase === 'lobby' || this.phase === 'confirm') {
      this.broadcastLobby();
      if (this.phase === 'confirm') this.sendConfig(e.id);
    } else {
      this.send(e.id, this.resyncPayload(e.id));
      if (wasDisconnected) this.onRejoin(e.id);
      if (this.phase === 'over') this.send(e.id, { t: 'game-over', scores: this.game.scores, winners: WordChain.winners(this.game), coop: this.coopResult() });
    }
    this.changed();
    return { ok: true, pid: e.id };
  }

  spectate(socket) {
    if (!this.game) return { ok: false, error: 'まだ対戦が始まっていません' };
    socket.join(this.allRoom);
    socket.data.wc = { roomId: this.id, pid: null };
    socket.emit('msg', this.resyncPayload(null));
    this.changed();
    return { ok: true };
  }

  // ソケットが切れた/部屋を出た
  detach(socket, { leaving } = {}) {
    const info = socket.data.wc;
    socket.leave(this.allRoom);
    if (!info || !info.pid) { this.changed(); return; }
    socket.leave(this.pidRoom(info.pid));
    socket.data.wc = null;
    const e = this.entry(info.pid);
    if (!e) return;
    e.sockets.delete(socket.id);
    if (e.sockets.size > 0) return;
    if (leaving) { this.playerGone(e.id, true); return; }
    // 再読み込み等の一瞬の切断は待つ
    if (this.phase === 'game' || this.phase === 'paused') {
      e.connected = false;
      this.goneTimers.set(e.id, setTimeout(() => { this.goneTimers.delete(e.id); if (!e.connected) this.playerGone(e.id, false); }, DISCONNECT_GRACE_MS));
      this.checkAbandon();
      return;
    }
    this.playerGone(e.id, false);
  }

  playerGone(pid, leaving) {
    const e = this.entry(pid);
    if (!e) return;
    e.connected = false;
    if (this.phase === 'lobby' || this.phase === 'confirm') {
      this.roster = this.roster.filter(p => p.id !== pid);
      if (this.ownerPid === pid) { const next = this.humans()[0]; this.ownerPid = next ? next.id : null; }
      if (this.phase === 'confirm') this.maybeAllConfirmed();
      this.broadcastLobby();
    } else if (this.phase === 'game' || this.phase === 'paused') {
      if (this.ownerPid === pid) { const next = this.connectedHumans()[0]; if (next) this.ownerPid = next.id; }
      if (leaving) this.removeFromGame(pid);
      else this.handleInGameDisconnect(pid);
    } else if (this.phase === 'over') {
      this.broadcast({ t: 'player-disc', id: pid });
      if (this.rematchVotes.size) this.checkRematch();
    }
    this.checkAbandon();
    this.changed();
  }

  // 人間が全員いなくなった部屋は ROOM_ABANDON_MS 後に消す(戻ってくれば取り消し)
  checkAbandon() {
    const away = this.connectedHumans().length === 0;
    if (away && !this.abandonTimer) {
      this.abandonTimer = setTimeout(() => { if (this.connectedHumans().length === 0) this.destroy(); }, Room.ABANDON_MS);
    } else if (!away && this.abandonTimer) {
      clearTimeout(this.abandonTimer);
      this.abandonTimer = null;
    }
  }

  destroy() {
    this.stopTimer();
    for (const t of [this.cpuTimer, this.clearTimer, this.abandonTimer, ...this.goneTimers.values()]) clearTimeout(t);
    this.broadcast({ t: 'bye' });
    this.io.in(this.allRoom).socketsLeave(this.allRoom);
    this.destroyed = true;
    if (this.onDestroy) this.onDestroy(this);
  }

  /* ───────────── ロビー → 開始 ───────────── */
  startConfig(pid, raw) {
    if (this.phase !== 'lobby' || pid !== this.ownerPid) return { ok: false, error: '開始できるのは部屋を作った人です' };
    const s = sanitizeSettings(raw);
    const n = this.humans().length;
    if (n < 2) return { ok: false, error: '2人以上そろってから開始してください' };
    if (s.coopMode && n >= MAX_PLAYERS) return { ok: false, error: `協力モードはCPUの1枠を確保するため、参加者は最大${MAX_PLAYERS - 1}人までです` };
    this.settings = s;
    this.phase = 'confirm';
    this.confirmAcks = new Set([pid]);
    for (const e of this.humans()) if (e.id !== pid) this.sendConfig(e.id);
    this.maybeAllConfirmed();
    this.changed();
    return { ok: true };
  }

  sendConfig(pid) {
    if (pid === this.ownerPid || this.confirmAcks.has(pid)) return;
    this.send(pid, { t: 'config', ...this.settings, players: this.publicRoster() });
  }

  configAck(pid) {
    if (this.phase !== 'confirm') return;
    this.confirmAcks.add(pid);
    this.maybeAllConfirmed();
  }

  maybeAllConfirmed() {
    if (this.phase !== 'confirm') return;
    const need = this.connectedHumans().map(p => p.id);
    if (need.length < 2) {
      this.phase = 'lobby';
      this.broadcast({ t: 'notice', text: '参加者が足りなくなりました。' });
      this.broadcastLobby();
      return;
    }
    if (need.every(id => this.confirmAcks.has(id))) this.beginGame();
  }

  // CPU戦: 作った人 + CPU(または協力モードのCPU1体)ですぐ始める
  setupCpuRoom(user, socket, raw) {
    const s = sanitizeSettings(raw, { forCpu: true });
    this.settings = s;
    const e = { id: 'p0', userId: user.userId, name: user.username, guest: !!user.guest, connected: true, sockets: new Set(), cpuLevel: null };
    this.roster = [e];
    this.ownerPid = 'p0';
    if (!s.coopMode) {
      for (let i = 1; i <= s.cpuCount; i++) {
        this.roster.push({ id: `p${i}`, userId: null, name: `CPU${s.cpuCount > 1 ? i : ''} (${CPU.LEVEL_LABEL[s.cpuLevel]})`, connected: true, sockets: new Set(), cpuLevel: s.cpuLevel });
      }
    }
    this.attach(e, socket);
    this.send('p0', { t: 'welcome', you: 'p0', roomCode: this.id, vsCpu: true });
    this.beginGame();
  }

  beginGame() {
    const s = this.settings;
    // 協力モード: CPU用の席を1つ足す(再戦では前回の席を外してから付け直す)
    this.roster = this.roster.filter(p => p.cpuLevel !== 'coop');
    if (s.coopMode) {
      this.roster.push({ id: this.freeSlot(), userId: null, name: `CPU (${CPU.LEVEL_LABEL[s.coopCpuLevel]})`, connected: true, sockets: new Set(), cpuLevel: 'coop', coopLevel: s.coopCpuLevel });
      this.roster.sort((a, b) => a.id.localeCompare(b.id));
    }
    const first = randInt(this.roster.length);
    const initialCells = WordChain.generateInitialCells(s.size, s.placementMode, s.initialCount);
    const initialLetters = WordChain.randomLetters(initialCells.length);
    const obstacleCells = s.obstacles ? WordChain.generateObstacleCells(s.size, initialCells, s.obstacleCount) : [];
    const itemCells = s.itemsMode
      ? WordChain.generateItemCells(s.size, initialCells, obstacleCells, { clear: s.itemClearCount, block: s.itemBlockCount, wildcard: s.itemWildcardCount })
      : { clear: [], block: [], wildcard: [] };
    this.game = WordChain.newGame({
      size: s.size, players: this.roster.map(p => p.id), first, timeLimit: s.timeLimit,
      initialCells, initialLetters, obstacleCells,
      territoryMode: s.scoringMode === 'territory', bonusMode: s.bonusMode, obstacleMove: s.obstacleMove,
      itemsMode: s.itemsMode, itemCells,
    });
    this.approval = null;
    this.proposal = null;
    this.discInfo = null;
    this.rematchVotes = new Set();
    this.recorded = false;
    this.phase = 'game';
    // アイテムマスの位置は送らない(隠し情報)
    this.broadcast({
      t: 'begin', size: s.size, initialCells, initialLetters, obstacleCells,
      timeLimit: s.timeLimit, players: this.publicRoster(), first, scoringMode: s.scoringMode,
      bonusMode: s.bonusMode, obstacleMove: s.obstacleMove, itemsMode: s.itemsMode,
    });
    this.changed();
    this.onTurnStart();
  }

  /* ───────────── タイマー ───────────── */
  startTimer(ms) {
    if (ms < 0) { this.timer = { remaining: -1, running: false, lastTick: 0 }; return; }
    this.timer = { remaining: ms, running: true, lastTick: Date.now() };
    if (!this.tickHandle) this.tickHandle = setInterval(() => this.tick(), 200);
  }
  consume() {
    if (this.timer.running) {
      const now = Date.now();
      this.timer.remaining -= now - this.timer.lastTick;
      this.timer.lastTick = now;
    }
  }
  pauseTimer() { this.consume(); this.timer.running = false; }
  resumeTimer() { if (this.timer.remaining < 0) return; this.timer.running = true; this.timer.lastTick = Date.now(); }
  stopTimer() { this.timer.running = false; if (this.tickHandle) { clearInterval(this.tickHandle); this.tickHandle = null; } }
  timerMsg() { this.consume(); return { t: 'timer', remainingMs: this.timer.remaining, running: this.timer.running }; }
  tick() {
    if (!this.timer.running) return;
    this.consume();
    if (this.timer.remaining <= 0) {
      this.timer.running = false;
      this.onTimeout();
    }
  }
  onTimeout() {
    const g = this.game;
    if (!g || g.over || this.approval || this.phase !== 'game') return;
    this.proposal = null;
    this.authorityPass(WordChain.currentPlayer(g), true);
  }

  /* ───────────── 手番 ───────────── */
  isCpu(pid) { const e = this.entry(pid); return !!(e && e.cpuLevel); }

  onTurnStart() {
    const g = this.game;
    if (this.clearTimer) { clearTimeout(this.clearTimer); this.clearTimer = null; }
    if (g.over) { this.onGameOver(); return; }
    // 「ブロック」の使用確認中は新しい手番の時計を動かさない
    if (g.pendingBlockOffer) {
      const holder = g.pendingBlockOffer.playerId;
      if (this.isCpu(holder)) { this.declineBlock(holder); return; } // CPUはブロックを使わない
      this.pauseTimer();
      this.broadcast(this.timerMsg());
      this.broadcast({ t: 'block-offer', playerId: holder });
      return;
    }
    const cur = WordChain.currentPlayer(g);
    const ms = g.timeLimit > 0 ? g.timeLimit * 1000 : -1;
    this.startTimer(ms);
    this.broadcast({ t: 'turn', by: cur, remainingMs: ms, obstacleCells: WordChain.obstacleCellList(g) });
    if (this.isCpu(cur)) this.scheduleCpu();
    this.changed();
  }

  scheduleCpu() {
    if (this.cpuTimer) clearTimeout(this.cpuTimer);
    const g = this.game;
    const cur = WordChain.currentPlayer(g);
    const e = this.entry(cur);
    this.cpuTimer = setTimeout(() => {
      this.cpuTimer = null;
      if (this.destroyed || this.game !== g || g.over || this.phase !== 'game' || WordChain.currentPlayer(g) !== cur) return;
      const { index, counts } = cpuIndex(this.dict);
      const move = e.cpuLevel === 'coop'
        ? CPU.chooseCoopMove(g, index, this.dict.startChars, counts, e.coopLevel)
        : CPU.chooseMove(g, index, this.dict.startChars, e.cpuLevel, counts);
      if (!move) this.authorityPass(cur, false);
      else this.handleMove(cur, { r: move.r, c: move.c, dir: move.dir, word: move.word }, false);
    }, 700 + Math.random() * 1100);
  }

  // 置いてよい状態か(自分の手番で、承認待ちやブロック確認中でない)
  canAct(pid) {
    const g = this.game;
    return g && !g.over && this.phase === 'game' && !this.approval && !g.pendingBlockOffer && WordChain.currentPlayer(g) === pid;
  }

  handleMove(pid, raw, propose) {
    if (!this.canAct(pid)) return;
    if (this.proposal && this.proposal.pid === pid && !propose) this.proposal = null;
    const move = {
      r: Number(raw && raw.r), c: Number(raw && raw.c), dir: Number(raw && raw.dir),
      word: String((raw && raw.word) || '').slice(0, 45),
      wildcardIndex: Number.isInteger(raw && raw.wildcardIndex) ? raw.wildcardIndex : undefined,
    };
    // 拗音(ゃゅょっ等)を直音で入力していても、辞書上の正しい綴りに直してから判定する
    const resolved = this.dict.resolve(move.word);
    const rmove = resolved.word === move.word ? move : { ...move, word: resolved.word };
    const v = WordChain.validateMove(this.game, rmove, this.dict.startChars);
    if (!v.ok) { this.send(pid, { t: 'move-rejected', reason: v.reason }); return; }
    if (resolved.indict) { this.applyMove(rmove, pid, false); return; }
    if (!propose) {
      // 辞書に無い単語: 承認を求めるか本人が考えている間は時計を止める
      this.proposal = { pid, move: rmove };
      this.pauseTimer();
      this.broadcast(this.timerMsg());
      this.send(pid, { t: 'needs-approval', word: rmove.word });
      return;
    }
    this.proposal = null;
    this.startApproval(pid, rmove);
  }

  cancelProposal(pid) {
    if (!this.proposal || this.proposal.pid !== pid) return;
    this.proposal = null;
    this.resumeTimer();
    this.broadcast(this.timerMsg());
  }

  applyMove(move, by, approved) {
    const g = this.game;
    const bonusBefore = { flatCell: g.bonusFlatCell, multCell: g.bonusMultCell };
    const itemsBefore = JSON.parse(JSON.stringify(g.itemCells || {}));
    const res = WordChain.applyMove(g, move, by);
    // 取ったボーナスマス・アイテムマスだけを明かす
    const bonus = {
      flatCell: res.flatValue ? bonusBefore.flatCell : null, flatValue: res.flatValue || null,
      multCell: res.multValue ? bonusBefore.multCell : null, multValue: res.multValue || null,
    };
    const itemHits = {};
    for (const kind of ['clear', 'block', 'wildcard']) {
      const after = new Set((g.itemCells[kind] || []).map(([r, c]) => r * 100 + c));
      itemHits[kind] = (itemsBefore[kind] || []).filter(([r, c]) => !after.has(r * 100 + c));
    }
    this.advanceHazards();
    this.broadcast({
      t: 'move-applied', by, r: move.r, c: move.c, dir: move.dir, word: move.word,
      wildcardIndex: move.wildcardIndex, approved: !!approved, bonus, itemHits,
    });
    this.onTurnStart();
  }

  authorityPass(pid, timeout) {
    const g = this.game;
    if (!g || g.over || WordChain.currentPlayer(g) !== pid) return;
    this.proposal = null;
    WordChain.applyPass(g);
    if (!g.over) this.advanceHazards();
    this.broadcast({ t: 'pass-applied', by: pid, timeout: !!timeout });
    this.onTurnStart();
  }

  pass(pid) { if (this.canAct(pid)) this.authorityPass(pid, false); }

  // お邪魔マスの移動・次のボーナスマスの抽選(サーバーだけが乱数を引く)
  advanceHazards() {
    const g = this.game;
    WordChain.relocateObstacles(g);
    const bonus = WordChain.pickBonusCells(g);
    g.bonusFlatCell = bonus.flat ? bonus.flat.cell : null;
    g.bonusFlatValue = bonus.flat ? bonus.flat.value : null;
    g.bonusMultCell = bonus.multiplier ? bonus.multiplier.cell : null;
    g.bonusMultValue = bonus.multiplier ? bonus.multiplier.value : null;
  }

  /* ───────────── 承認投票(辞書に無い単語) ───────────── */
  startApproval(proposer, move) {
    // CPU は投票できないので除外する。投票できる人がいなければ自動承認
    const need = new Set(this.connectedHumans().filter(p => p.id !== proposer && this.game.active[p.id]).map(p => p.id));
    this.approval = { proposer, move, need, votes: new Map() };
    if (need.size === 0) { this.finishApproval(true); return; }
    this.pauseTimer();
    this.broadcast(this.timerMsg());
    for (const id of need) this.send(id, { t: 'approve-start', by: proposer, word: move.word });
    this.send(proposer, { t: 'status', text: '他のプレーヤーの承認を待っています...' });
  }

  vote(pid, ok) {
    const a = this.approval;
    if (!a || !a.need.has(pid) || a.votes.has(pid)) return;
    a.votes.set(pid, !!ok);
    if (!ok) { this.finishApproval(false); return; }
    if ([...a.need].every(id => a.votes.get(id) === true)) this.finishApproval(true);
  }

  finishApproval(ok) {
    const a = this.approval;
    if (!a) return;
    this.approval = null;
    this.broadcast({ t: 'approve-end' });
    if (ok) {
      this.dict.add(a.move.word);
      this.applyMove(a.move, a.proposer, true);
    } else {
      this.resumeTimer();
      this.broadcast(this.timerMsg());
      this.send(a.proposer, { t: 'move-rejected', reason: '拒否されました。別の単語を入力してください。', rejectedByVote: true });
    }
  }

  /* ───────────── アイテム ───────────── */
  startClear(pid) {
    const g = this.game;
    if (!g || g.over || this.phase !== 'game') return;
    const res = WordChain.startClearWindow(g, pid);
    if (!res.ok) { this.send(pid, { t: 'item-rejected', reason: res.reason }); return; }
    // 5秒のカウントダウン中は入力時間を止める(時計のずれを避けるため残り時間で伝える)
    this.pauseTimer();
    this.broadcast(this.timerMsg());
    this.broadcast({ t: 'item-window-start', by: pid, item: 'clear', remainingMs: WordChain.CLEAR_ITEM_WINDOW_MS });
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = setTimeout(() => {
      this.clearTimer = null;
      if (this.game !== g || g.over) return;
      this.resumeTimer();
      this.broadcast(this.timerMsg());
    }, WordChain.CLEAR_ITEM_WINDOW_MS);
  }

  useItem(pid, item, r, c) {
    const g = this.game;
    if (!g || g.over || this.phase !== 'game') return;
    if (item !== 'clear' && item !== 'block') return;
    const res = WordChain.useItem(g, pid, item, Number(r), Number(c));
    if (!res.ok) { this.send(pid, { t: 'item-rejected', reason: res.reason }); return; }
    if (item === 'clear') {
      if (this.clearTimer) { clearTimeout(this.clearTimer); this.clearTimer = null; }
      this.resumeTimer();
      this.broadcast(this.timerMsg());
    }
    this.broadcast({ t: 'item-applied', by: pid, item, r: Number(r), c: Number(c) });
    if (item === 'block') this.onTurnStart(); // 保留していた手番開始を進める
  }

  declineBlock(pid) {
    const g = this.game;
    if (!g || !g.pendingBlockOffer || g.pendingBlockOffer.playerId !== pid) return;
    WordChain.declineBlockOffer(g, pid);
    this.onTurnStart();
  }

  /* ───────────── チャット ───────────── */
  chat(pid, text) {
    const clean = String(text || '').trim().slice(0, 200);
    if (!clean || !this.entry(pid)) return;
    this.broadcast({ t: 'chat', from: pid, name: this.nameOf(pid), text: clean }, pid);
  }

  /* ───────────── 切断・復帰 ───────────── */
  chooser() {
    const owner = this.entry(this.ownerPid);
    if (owner && owner.connected && !owner.cpuLevel) return owner.id;
    const h = this.connectedHumans()[0];
    return h ? h.id : null;
  }

  handleInGameDisconnect(pid) {
    const g = this.game;
    if (!g || g.over || !g.active[pid]) return;
    if (this.approval) { this.approval = null; this.broadcast({ t: 'approve-end' }); }
    this.proposal = null;
    this.phase = 'paused';
    this.pauseTimer();
    this.broadcast({ t: 'player-disc', id: pid });
    this.broadcast(this.timerMsg());
    this.discInfo = { id: pid, waiting: false };
    this.broadcast({ t: 'paused', waiting: true });
    const ch = this.chooser();
    if (ch) this.send(ch, { t: 'disc-choice', id: pid, name: this.nameOf(pid) });
  }

  discChoice(pid, choice) {
    if (!this.discInfo || this.phase !== 'paused' || pid !== this.chooser()) return;
    const id = this.discInfo.id;
    if (choice === 'wait') {
      this.discInfo.waiting = true;
      this.send(pid, { t: 'waiting-rejoin', id, name: this.nameOf(id) });
    } else if (choice === 'continue') {
      this.removeFromGame(id);
    } else if (choice === 'end') {
      this.discInfo = null;
      this.phase = 'game';
      this.game.over = true;
      this.broadcast({ t: 'paused', waiting: false });
      this.onGameOver();
    }
  }

  // 抜けた人を手番から外して続ける(自分で退出した場合もここ)
  removeFromGame(pid) {
    const g = this.game;
    if (!g) return;
    if (this.discInfo && this.discInfo.id === pid) this.discInfo = null;
    if (g.over || !g.active[pid]) return;
    const wasPaused = this.phase === 'paused';
    WordChain.removePlayer(g, pid);
    this.broadcast({ t: 'player-left', id: pid });
    if (wasPaused && !this.discInfo) { this.phase = 'game'; this.broadcast({ t: 'paused', waiting: false }); }
    if (g.over) { this.onGameOver(); return; }
    if (this.phase === 'game') {
      // 手番の人が抜けた等で手番が変わっていれば新しい手番を始める
      if (this.approval && this.approval.proposer === pid) { this.approval = null; this.broadcast({ t: 'approve-end' }); }
      this.onTurnStart();
    }
  }

  onRejoin(pid) {
    this.broadcast({ t: 'player-rejoined', id: pid });
    if (this.phase === 'paused' && this.discInfo && this.discInfo.id === pid) {
      this.discInfo = null;
      this.phase = 'game';
      this.broadcast({ t: 'paused', waiting: false });
      this.resumeTimer();
      this.broadcast(this.timerMsg());
      this.broadcast({ t: 'status', text: `${this.nameOf(pid)}が再接続しました。` });
      if (this.isCpu(WordChain.currentPlayer(this.game))) this.scheduleCpu();
    }
  }

  resyncPayload(pid) {
    const g = this.game;
    this.consume();
    const pending = g.pendingItemUse ? { playerId: g.pendingItemUse.playerId, item: g.pendingItemUse.item, remainingMs: Math.max(0, g.pendingItemUse.expiresAt - Date.now()) } : null;
    return {
      t: 'resync', you: pid, roomCode: this.id, vsCpu: this.vsCpu, size: g.size, board: g.board, owner: g.owner, blocked: g.blocked, initialCells: g.initialCells,
      scores: g.scores, active: g.active, players: this.publicRoster(), turnIdx: g.turnIdx, chain: g.chain,
      used: [...g.usedWords], history: g.history, timeLimit: g.timeLimit, over: g.over,
      remainingMs: this.timer.remaining, running: this.timer.running, phase: this.phase,
      territoryMode: g.territoryMode, bonusMode: g.bonusMode, obstacleMove: g.obstacleMove,
      itemsMode: g.itemsMode, items: g.items, pendingBlockOffer: g.pendingBlockOffer, pendingItemUse: pending,
      approval: this.approval && pid && this.approval.need.has(pid) && !this.approval.votes.has(pid) ? { by: this.approval.proposer, word: this.approval.move.word } : null,
    };
  }

  /* ───────────── 終了・再戦 ───────────── */
  coopResult() {
    const cpu = this.roster.find(p => p.cpuLevel === 'coop');
    if (!cpu || !this.game) return null;
    const team = this.roster.filter(p => p.id !== cpu.id).reduce((s, p) => s + (this.game.scores[p.id] || 0), 0);
    const cpuScore = this.game.scores[cpu.id] || 0;
    return { cpuId: cpu.id, teamTotal: team, cpuScore, teamWon: team > cpuScore };
  }

  onGameOver() {
    const g = this.game;
    this.stopTimer();
    if (this.cpuTimer) { clearTimeout(this.cpuTimer); this.cpuTimer = null; }
    this.phase = 'over';
    this.approval = null;
    this.rematchVotes = new Set();
    const winners = WordChain.winners(g);
    const coop = this.coopResult();
    this.broadcast({ t: 'game-over', scores: g.scores, winners, coop });
    if (!this.recorded) {
      this.recorded = true;
      for (const p of this.humans()) {
        let result;
        if (coop) result = coop.teamWon ? 'win' : coop.teamTotal === coop.cpuScore ? 'draw' : 'lose';
        else result = winners.includes(p.id) ? (winners.length === 1 ? 'win' : 'draw') : 'lose';
        if (!p.guest) this.records.record(p.userId, p.name, result, this.vsCpu);
      }
    }
    this.changed();
  }

  rematchVote(pid) {
    if (this.phase !== 'over') return;
    this.rematchVotes.add(pid);
    this.checkRematch();
  }

  checkRematch() {
    const need = this.connectedHumans().map(p => p.id);
    const got = need.filter(id => this.rematchVotes.has(id)).length;
    this.broadcast({ t: 'rematch-progress', got, need: need.length });
    const enough = this.vsCpu ? need.length >= 1 : need.length >= 2;
    if (got < need.length || !enough) return;
    if (this.vsCpu) { this.beginGame(); return; }
    // 友達戦はロビーに戻り、部屋を作った人が設定し直す
    this.roster = this.roster.filter(p => p.connected && !p.cpuLevel);
    if (!this.entry(this.ownerPid)) this.ownerPid = this.roster[0] ? this.roster[0].id : null;
    this.phase = 'lobby';
    this.game = null;
    this.broadcast({ t: 'rematch-lobby' });
    this.broadcastLobby();
    this.changed();
  }
}

Room.ABANDON_MS = Number(process.env.ROOM_ABANDON_MS || 30 * 60 * 1000);

module.exports = { Room, sanitizeSettings, MAX_PLAYERS };
