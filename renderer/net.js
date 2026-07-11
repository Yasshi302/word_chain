/**
 * 通信層: PeerJS による WebRTC P2P (DTLS暗号化)。
 *
 * トポロジ: ホストがハブとなるスター型。ゲスト(最大3)はホストのみと接続する。
 * ホストが権威を持ち、ゲームの状態は常にホストが配信する (host-authoritative)。
 *
 * - シグナリング(接続仲介)のみ PeerJS 公開サーバを利用。確立後は完全P2P。
 * - 入室はパスワードのチャレンジレスポンス認証 (HMAC-SHA256)。
 * - 受信メッセージはサイズ上限・型・値域を検証してから処理する。
 */
'use strict';

const Net = (() => {
  const MSG_MAX = 8192;
  const DICT_SYNC_MAX = 512 * 1024;
  const MAX_SYNC_WORDS = 10000;
  const MAX_GUESTS = 3;
  const ID_PREFIX = 'wordchain-jp-';

  // ICE サーバ: STUN で NAT 越え(穴あけ)、失敗時は TURN で中継。
  // これによりポート開放なしで家庭用ルーター越しに接続できる。
  // (URL は index.html の CSP connect-src でも許可している)
  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:eu-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
      { urls: 'turn:us-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
    ],
  };
  const PEER_OPTS = { debug: 1, config: ICE_CONFIG };
  const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
  const CODE_LEN = 6;
  const CODE_RE = new RegExp(`^[${CODE_CHARS}]{${CODE_LEN}}$`);
  const AUTH_TIMEOUT_MS = 15000;
  const MAX_AUTH_FAILS = 5;
  const BLOCK_MS = 120000;

  const HIRA_CHAR = /^[ぁ-ゖー]$/u;
  const HIRA_WORD = /^[ぁ-ゖー]{2,15}$/u;
  const HEX32 = /^[0-9a-f]{32}$/;
  const HEX64 = /^[0-9a-f]{64}$/;

  function cellsOk(cells, size, min, max) {
    return Array.isArray(cells) && cells.length >= min && cells.length <= max
      && cells.every((p) => Array.isArray(p) && p.length === 2
        && Number.isInteger(p[0]) && p[0] >= 0 && p[0] < size
        && Number.isInteger(p[1]) && p[1] >= 0 && p[1] < size);
  }
  function placementOk(v) { return v === 'default' || v === 'random'; }
  function initialCountOk(count, placementMode) {
    return Number.isInteger(count)
      && (placementMode === 'random' ? (count >= 1 && count <= 10) : (count === 1 || count === 4));
  }
  // お邪魔マスの数の上限は盤面の全マス数の20%まで (game.jsのmaxObstacleCountと同じ計算)
  function maxObstacleCount(size) { return Math.max(1, Math.floor(size * size * 0.2)); }
  function obstacleCountOk(count, size) {
    return Number.isInteger(count) && count >= 1 && count <= maxObstacleCount(size);
  }
  function scoringModeOk(v) { return v === 'normal' || v === 'territory'; }
  function coopLevelOk(v) { return v === 'weak' || v === 'normal' || v === 'strong' || v === 'strongest'; }
  function cellOrNullOk(v) {
    return v === null || v === undefined || (Array.isArray(v) && v.length === 2
      && Number.isInteger(v[0]) && v[0] >= 0 && v[0] < 15
      && Number.isInteger(v[1]) && v[1] >= 0 && v[1] < 15);
  }
  function bonusFlatValueOk(v) { return v === null || v === undefined || (Number.isInteger(v) && v >= 1 && v <= 5); }
  function bonusMultValueOk(v) { return v === null || v === undefined || (Number.isInteger(v) && v >= 2 && v <= 3); }
  function coordOk(v) { return Number.isInteger(v) && v >= 0 && v < 15; }
  function itemNameOk(v) { return v === 'clear' || v === 'block'; }
  const ITEM_COUNT_MAX = 9;
  function itemCountOk(v) { return Number.isInteger(v) && v >= 0 && v <= ITEM_COUNT_MAX; }
  function itemsInventoryOk(v) {
    return v && typeof v === 'object' && Object.values(v).every((inv) => inv && typeof inv === 'object'
      && Number.isInteger(inv.clear) && inv.clear >= 0
      && Number.isInteger(inv.block) && inv.block >= 0
      && Number.isInteger(inv.wildcard) && inv.wildcard >= 0);
  }
  function itemCellsOk(v, size) {
    return v && typeof v === 'object'
      && cellsOk(v.clear, size, 0, size * size) && cellsOk(v.block, size, 0, size * size)
      && cellsOk(v.wildcard, size, 0, size * size);
  }
  function pendingBlockOfferOk(v) {
    return v === null || v === undefined || (v && typeof v === 'object' && typeof v.playerId === 'string');
  }
  function pendingItemUseOk(v) {
    return v === null || v === undefined || (v && typeof v === 'object'
      && typeof v.playerId === 'string' && v.item === 'clear' && Number.isFinite(v.expiresAt));
  }
  function wildcardIndexOk(v) {
    return v === undefined || v === null || (Number.isInteger(v) && v >= 0 && v < 15);
  }

  // ゲーム系メッセージ種別ごとの検証 (認証系は別処理)。
  const VALIDATORS = {
    // --- guest -> host ---
    'hello': (m) => (m.name === undefined || (typeof m.name === 'string' && m.name.length <= 24))
      && friendIdOk(m.friendId),
    'config-ack': () => true,
    'move': (m) => Number.isInteger(m.r) && m.r >= 0 && m.r < 15
      && Number.isInteger(m.c) && m.c >= 0 && m.c < 15
      && Number.isInteger(m.dir) && m.dir >= 0 && m.dir < 8
      && typeof m.word === 'string' && HIRA_WORD.test(m.word)
      && wildcardIndexOk(m.wildcardIndex),
    'pass': () => true,
    'approve-vote': (m) => typeof m.ok === 'boolean',
    'rematch-vote': (m) => typeof m.ok === 'boolean',
    'leave': () => true,
    'updating': () => true,
    'use-item': (m) => itemNameOk(m.item) && coordOk(m.r) && coordOk(m.c),
    'use-item-start': (m) => m.item === 'clear',
    'decline-block-offer': () => true,
    // --- host -> guest ---
    'welcome': (m) => typeof m.you === 'string' && m.you.length <= 8,
    'lobby': (m) => Array.isArray(m.players) && m.players.length <= 4,
    'updated': (m) => Array.isArray(m.players) && m.players.length <= 4
      && m.players.every((p) => p && typeof p.id === 'string' && p.id.length <= 8
        && typeof p.name === 'string' && p.name.length <= 24
        && typeof p.updating === 'boolean'),
    'config': (m) => sizeOk(m.size) && timeOk(m.timeLimit) && rosterOk(m.players)
      && placementOk(m.placementMode) && initialCountOk(m.initialCount, m.placementMode)
      && typeof m.obstacles === 'boolean' && (!m.obstacles || obstacleCountOk(m.obstacleCount, m.size))
      && scoringModeOk(m.scoringMode)
      && typeof m.bonusMode === 'boolean' && typeof m.obstacleMove === 'boolean'
      && typeof m.itemsMode === 'boolean' && typeof m.coopMode === 'boolean'
      && (!m.coopMode || coopLevelOk(m.coopCpuLevel))
      && (!m.itemsMode || (itemCountOk(m.itemClearCount) && itemCountOk(m.itemBlockCount) && itemCountOk(m.itemWildcardCount))),
    'begin': (m) => sizeOk(m.size) && timeOk(m.timeLimit) && rosterOk(m.players)
      && cellsOk(m.initialCells, m.size, 1, 10)
      && Array.isArray(m.initialLetters) && m.initialLetters.length === m.initialCells.length
      && m.initialLetters.every((x) => typeof x === 'string' && HIRA_CHAR.test(x))
      && cellsOk(m.obstacleCells, m.size, 0, maxObstacleCount(m.size))
      && scoringModeOk(m.scoringMode)
      && typeof m.bonusMode === 'boolean' && typeof m.obstacleMove === 'boolean'
      && typeof m.itemsMode === 'boolean'
      && (!m.itemsMode || (itemCountOk(m.itemClearCount) && itemCountOk(m.itemBlockCount) && itemCountOk(m.itemWildcardCount)))
      && Number.isInteger(m.first) && m.first >= 0 && m.first < 4,
    'turn': (m) => typeof m.by === 'string' && Number.isFinite(m.remainingMs)
      && cellOrNullOk(m.bonusFlatCell) && bonusFlatValueOk(m.bonusFlatValue)
      && cellOrNullOk(m.bonusMultCell) && bonusMultValueOk(m.bonusMultValue)
      && (m.obstacleCells === undefined || cellsOk(m.obstacleCells, 15, 0, maxObstacleCount(15))),
    'timer': (m) => Number.isFinite(m.remainingMs) && typeof m.running === 'boolean',
    'move-applied': (m) => typeof m.by === 'string'
      && Number.isInteger(m.r) && Number.isInteger(m.c) && Number.isInteger(m.dir)
      && typeof m.word === 'string' && HIRA_WORD.test(m.word),
    'pass-applied': (m) => typeof m.by === 'string',
    'item-applied': (m) => typeof m.by === 'string' && itemNameOk(m.item) && coordOk(m.r) && coordOk(m.c),
    'item-rejected': (m) => m.reason === undefined || typeof m.reason === 'string',
    'item-window-start': (m) => typeof m.by === 'string' && m.item === 'clear' && Number.isFinite(m.expiresAt),
    'block-offer': (m) => typeof m.playerId === 'string',
    'approve-start': (m) => typeof m.by === 'string' && typeof m.word === 'string' && HIRA_WORD.test(m.word),
    'approve-progress': (m) => Number.isFinite(m.got) && Number.isFinite(m.need),
    'approve-end': () => true,
    'move-rejected': (m) => m.reason === undefined || typeof m.reason === 'string',
    'status': (m) => m.text === undefined || (typeof m.text === 'string' && m.text.length <= 200),
    'game-over': (m) => m.scores && typeof m.scores === 'object' && Array.isArray(m.winners),
    'player-disc': (m) => typeof m.id === 'string',
    'player-left': (m) => typeof m.id === 'string',
    'player-rejoined': (m) => typeof m.id === 'string',
    'paused': (m) => typeof m.waiting === 'boolean',
    'resync': (m) => sizeOk(m.size) && Array.isArray(m.board) && Array.isArray(m.owner)
      && Array.isArray(m.blocked) && Array.isArray(m.initialCells)
      && m.scores && typeof m.scores === 'object' && m.active && typeof m.active === 'object'
      && rosterOk(m.players) && Number.isInteger(m.turnIdx)
      && Array.isArray(m.used) && Array.isArray(m.history) && typeof m.territoryMode === 'boolean'
      && typeof m.bonusMode === 'boolean'
      && cellOrNullOk(m.bonusFlatCell) && bonusFlatValueOk(m.bonusFlatValue)
      && cellOrNullOk(m.bonusMultCell) && bonusMultValueOk(m.bonusMultValue)
      && typeof m.obstacleMove === 'boolean'
      && typeof m.itemsMode === 'boolean'
      && (!m.itemsMode || (itemsInventoryOk(m.items) && itemCellsOk(m.itemCells, m.size)))
      && pendingBlockOfferOk(m.pendingBlockOffer) && pendingItemUseOk(m.pendingItemUse),
    'rematch-lobby': () => true,
    'rematch-progress': (m) => Number.isFinite(m.got) && Number.isFinite(m.need),
    'hb': () => true,
    'chat': (m) => typeof m.text === 'string' && m.text.length >= 1 && m.text.length <= 200
      && (m.from === undefined || (typeof m.from === 'string' && m.from.length <= 8))
      && (m.name === undefined || (typeof m.name === 'string' && m.name.length <= 24)),
    // --- どちら向きにも ---
    'dict-sync': (m) => Number.isFinite(m.updatedAt) && m.updatedAt >= 0
      && Array.isArray(m.words) && m.words.length <= MAX_SYNC_WORDS
      && m.words.every((w) => typeof w === 'string' && HIRA_WORD.test(w)),
    'bye': () => true,
  };
  const MSG_LIMITS = { 'dict-sync': DICT_SYNC_MAX, 'resync': 256 * 1024 };

  function sizeOk(n) { return Number.isInteger(n) && n >= 8 && n <= 15; }
  function timeOk(n) { return [10, 30, 60, 120, 180, 240, 300, 0].includes(n); }
  // フレンドコード(恒久ID)の形式。renderer/presence.jsと同じ文字集合・長さ(12文字)。
  const FRIEND_ID_RE = /^[abcdefghjkmnpqrstuvwxyz23456789]{12}$/;
  function friendIdOk(v) { return v === undefined || v === null || (typeof v === 'string' && FRIEND_ID_RE.test(v)); }
  function rosterOk(a) {
    return Array.isArray(a) && a.length >= 1 && a.length <= 4
      && a.every((p) => p && typeof p.id === 'string' && p.id.length <= 8
        && typeof p.name === 'string' && p.name.length <= 24
        && (p.cpuLevel === undefined || p.cpuLevel === null || p.cpuLevel === 'coop')
        && friendIdOk(p.friendId));
  }

  let peer = null;
  let role = null;              // 'host' | 'guest'
  let events = {};
  let password = null;
  let roomCode = null;
  let authFails = 0;
  let blockUntil = 0;

  // host: connId(=remote peer id) -> { conn, authed, nonce, timer }
  const guests = new Map();
  // guest:
  let hostConn = null;
  let guestAuthed = false;
  let guestClosedNotified = false;
  let hostLastSeen = 0;

  // ハートビート: WebRTCは相手プロセスが突然消えても close を発火しないことがあるため、
  // アプリ層で定期的に生存確認する。
  const HB_INTERVAL = 3000;
  const HB_TIMEOUT = 11000;
  let hbTimer = null;

  function toHex(buf) {
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  function randomHex(nBytes) {
    const b = new Uint8Array(nBytes); crypto.getRandomValues(b); return toHex(b.buffer);
  }
  function randomCode() {
    const b = new Uint8Array(CODE_LEN); crypto.getRandomValues(b);
    let s = ''; for (const x of b) s += CODE_CHARS[x % CODE_CHARS.length]; return s;
  }
  async function hmacHex(pass, data) {
    const enc = new TextEncoder();
    const keyData = await crypto.subtle.digest('SHA-256', enc.encode(pass));
    const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
  }
  function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
  }

  /** 受信データ検証。ゲーム系のみ。不正なら null */
  function sanitize(d) {
    if (typeof d !== 'object' || d === null || Array.isArray(d)) return null;
    let json; try { json = JSON.stringify(d); } catch { return null; }
    if (typeof d.t !== 'string') return null;
    const limit = MSG_LIMITS[d.t] || MSG_MAX;
    if (typeof json !== 'string' || json.length > limit) return null;
    const v = VALIDATORS[d.t];
    if (!v) return null;
    try { if (!v(d)) return null; } catch { return null; }
    return d;
  }

  function emit(name, ...args) {
    if (typeof events[name] === 'function') events[name](...args);
  }

  function peerErrorText(e) {
    switch (e && e.type) {
      case 'peer-unavailable': return '部屋が見つかりません。部屋コードを確認してください。';
      case 'network': return 'シグナリングサーバに接続できません。ネットワークを確認してください。';
      case 'unavailable-id': return '部屋コードの発行に失敗しました。もう一度お試しください。';
      case 'browser-incompatible': return 'この環境ではWebRTCが利用できません。';
      default: return `通信エラーが発生しました (${(e && e.type) || '不明'})`;
    }
  }

  // ================= ホスト =================

  function createRoom(pass, ev, attempt = 0) {
    resetAll();
    role = 'host';
    password = pass;
    events = ev;
    roomCode = randomCode();
    peer = new Peer(ID_PREFIX + roomCode, PEER_OPTS);
    peer.on('open', () => emit('onRoomReady', roomCode));
    peer.on('error', (e) => {
      if (e && e.type === 'unavailable-id' && attempt < 3) {
        try { peer.destroy(); } catch {}
        createRoom(pass, ev, attempt + 1);
        return;
      }
      emit('onError', peerErrorText(e));
    });
    peer.on('disconnected', () => { try { if (peer && !peer.destroyed) peer.reconnect(); } catch {} });
    peer.on('connection', hostHandleConn);
    startHostHeartbeat();
  }

  function startHostHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, e] of [...guests]) {
        if (!e.authed) continue;
        if (e.conn.open) { try { e.conn.send({ t: 'hb' }); } catch {} }
        if (now - (e.lastSeen || 0) > HB_TIMEOUT) {
          try { e.conn.close(); } catch {}
          guests.delete(id);
          emit('onGuestClosed', id);
        }
      }
    }, HB_INTERVAL);
  }

  function authedGuestCount() {
    let n = 0; for (const g of guests.values()) if (g.authed) n++; return n;
  }

  function hostHandleConn(conn) {
    const connId = conn.peer;
    if (Date.now() < blockUntil) { try { conn.close(); } catch {} return; }
    // 既に同一IDの接続があれば古い方を閉じる
    if (guests.has(connId)) { try { guests.get(connId).conn.close(); } catch {} guests.delete(connId); }
    const nonce = randomHex(16);
    const entry = { conn, authed: false, nonce, timer: null };
    guests.set(connId, entry);
    entry.timer = setTimeout(() => { if (!entry.authed) { try { conn.close(); } catch {} guests.delete(connId); } }, AUTH_TIMEOUT_MS);

    conn.on('open', () => { try { conn.send({ t: 'auth', nonce }); } catch {} });
    conn.on('data', async (d) => {
      const e = guests.get(connId);
      if (!e) return;
      e.lastSeen = Date.now();
      if (d && d.t === 'hb') return;
      if (!e.authed) {
        if (!d || d.t !== 'auth-res' || !HEX64.test(d.mac)) return;
        const expected = await hmacHex(password, `${e.nonce}|${roomCode}`);
        if (!timingSafeEqual(expected, d.mac)) {
          authFails++;
          if (authFails >= MAX_AUTH_FAILS) { blockUntil = Date.now() + BLOCK_MS; authFails = 0; }
          try { conn.send({ t: 'auth-fail' }); } catch {}
          setTimeout(() => { try { conn.close(); } catch {} }, 200);
          guests.delete(connId);
          return;
        }
        if (authedGuestCount() >= MAX_GUESTS) {
          try { conn.send({ t: 'auth-full' }); } catch {}
          setTimeout(() => { try { conn.close(); } catch {} }, 200);
          guests.delete(connId);
          return;
        }
        e.authed = true;
        e.lastSeen = Date.now();
        clearTimeout(e.timer);
        try { conn.send({ t: 'auth-ok' }); } catch {}
        emit('onGuestAuthed', connId);
        return;
      }
      const m = sanitize(d);
      if (m) emit('onGuestMessage', connId, m);
    });
    conn.on('close', () => {
      const e = guests.get(connId);
      guests.delete(connId);
      if (e && e.authed) emit('onGuestClosed', connId);
    });
    conn.on('error', () => {
      const e = guests.get(connId);
      if (e && e.authed) { guests.delete(connId); emit('onGuestClosed', connId); }
    });
  }

  function sendTo(connId, msg) {
    const e = guests.get(connId);
    if (e && e.authed && e.conn.open) { try { e.conn.send(msg); } catch {} }
  }
  function broadcast(msg, exceptConnId) {
    for (const [id, e] of guests) {
      if (id === exceptConnId) continue;
      if (e.authed && e.conn.open) { try { e.conn.send(msg); } catch {} }
    }
  }
  function closeGuest(connId) {
    const e = guests.get(connId);
    if (e) { try { e.conn.close(); } catch {} guests.delete(connId); }
  }

  // ================= ゲスト =================

  function joinRoom(code, pass, ev) {
    resetAll();
    role = 'guest';
    password = pass;
    events = ev;
    roomCode = code;
    peer = new Peer(PEER_OPTS);
    peer.on('open', () => {
      const conn = peer.connect(ID_PREFIX + code, { reliable: true, serialization: 'json' });
      hostConn = conn;
      const authTimer = setTimeout(() => {
        if (!guestAuthed) { emit('onError', '接続がタイムアウトしました'); leave(); }
      }, AUTH_TIMEOUT_MS);
      conn.on('data', async (d) => {
        hostLastSeen = Date.now();
        if (d && d.t === 'hb') return;
        if (!guestAuthed) {
          if (d && d.t === 'auth' && HEX32.test(d.nonce)) {
            try { conn.send({ t: 'auth-res', mac: await hmacHex(pass, `${d.nonce}|${roomCode}`) }); } catch {}
          } else if (d && d.t === 'auth-ok') {
            guestAuthed = true; hostLastSeen = Date.now(); clearTimeout(authTimer); startGuestHeartbeat(); emit('onJoined');
          } else if (d && d.t === 'auth-fail') {
            clearTimeout(authTimer); emit('onAuthFail'); leave();
          } else if (d && d.t === 'auth-full') {
            clearTimeout(authTimer); emit('onError', '部屋が満員です (最大4人)。'); leave();
          }
          return;
        }
        const m = sanitize(d);
        if (m) emit('onMessage', m);
      });
      conn.on('close', () => { if (guestAuthed) notifyGuestClosed(); });
      conn.on('error', () => { if (guestAuthed) notifyGuestClosed(); });
    });
    peer.on('error', (e) => {
      if (!guestAuthed) emit('onError', peerErrorText(e));
      else notifyGuestClosed();
    });
  }

  function startGuestHeartbeat() {
    if (hbTimer) clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      if (hostConn && hostConn.open) { try { hostConn.send({ t: 'hb' }); } catch {} }
      if (Date.now() - hostLastSeen > HB_TIMEOUT) notifyGuestClosed();
    }, HB_INTERVAL);
  }

  function notifyGuestClosed() {
    if (guestClosedNotified) return;
    guestClosedNotified = true;
    emit('onClosed');
  }

  function sendHost(msg) {
    if (hostConn && hostConn.open && guestAuthed) { try { hostConn.send(msg); } catch {} }
  }

  // ================= 共通 =================

  function normalizeCode(input) {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    return CODE_RE.test(s) ? s : null;
  }

  function resetAll() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    for (const [, e] of guests) { try { e.conn.close(); } catch {} }
    guests.clear();
    if (hostConn) { try { hostConn.close(); } catch {} }
    if (peer) { try { peer.destroy(); } catch {} }
    peer = null; role = null; events = {}; password = null; roomCode = null;
    hostConn = null; guestAuthed = false; guestClosedNotified = false; hostLastSeen = 0;
  }

  function leave() {
    if (role === 'host') { broadcast({ t: 'bye' }); }
    else if (hostConn && hostConn.open && guestAuthed) { try { hostConn.send({ t: 'leave' }); } catch {} }
    resetAll();
  }

  function getRoomCode() { return roomCode; }

  return {
    CODE_LEN, MAX_GUESTS,
    createRoom, broadcast, sendTo, closeGuest,
    joinRoom, sendHost,
    normalizeCode, leave, getRoomCode,
  };
})();
