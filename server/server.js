'use strict';
// ワードチェイン オンライン対戦サーバー(ブラウザ版)。
// 本番は Caddy が https://summon-war.servequake.com/wordchain/* をこのプロセスへ中継する。
// ログイン・本人確認・部屋一覧・招待は共通ゲームロビーが担う(lobbyClient.js)。

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const helmet = require('helmet');
const { Server } = require('socket.io');
const { createLobbyClient } = require('./lobbyClient');
const { createDictionary } = require('./dict');
const { createRecords } = require('./records');
const { Room } = require('./room');

const DEV = process.argv.includes('--dev') || process.env.WORDCHAIN_DEV === '1';
const PORT = Number(process.env.PORT || 3003);
const BASE = '/wordchain';
const LOBBY_INTERNAL = process.env.LOBBY_INTERNAL || 'http://127.0.0.1:3100';
const DATA_DIR = process.env.WORDCHAIN_DATA || path.join(__dirname, 'data');
const ROOT = path.join(__dirname, '..');

const lobby = createLobbyClient({ lobbyInternal: LOBBY_INTERNAL, game: 'wordchain' });
const dict = createDictionary({ baseFile: path.join(ROOT, 'data', 'dictionary.txt'), customFile: path.join(DATA_DIR, 'custom-words.json') });
const records = createRecords(path.join(DATA_DIR, 'records.json'));

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: DEV ? null : ["'none'"],
      upgradeInsecureRequests: DEV ? null : [],
    },
  },
  frameguard: DEV ? false : { action: 'sameorigin' },
  strictTransportSecurity: !DEV,
}));

const router = express.Router();
router.get('/api/me', async (req, res) => {
  const user = await lobby.userFromCookieHeader(req.headers.cookie);
  if (!user) { res.json({ ok: false }); return; }
  res.json({ ok: true, username: user.username, guest: !!user.guest, stats: user.guest ? null : records.statsOf(user.userId), dict: dict.info() });
});
router.get('/shared/game.js', (req, res) => res.sendFile(path.join(ROOT, 'shared', 'game.js')));
router.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));
app.use((req, res, next) => (req.path === BASE ? res.redirect(301, `${BASE}/`) : next()));
app.use(BASE, router);

const server = http.createServer(app);
const io = new Server(server, { path: `${BASE}/socket.io`, maxHttpBufferSize: 64 * 1024 });

/* ───────────── 部屋 ───────────── */

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let id;
  do { id = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join(''); } while (rooms.has(id));
  return id;
}

// ロビーへ部屋の一覧を報告する(変化があったとき + 30秒ごと)
let reportTimer = null;
function scheduleReport() {
  if (reportTimer) return;
  reportTimer = setTimeout(() => { reportTimer = null; reportNow(); }, 500);
}
function reportNow() {
  lobby.reportRooms([...rooms.values()].map(r => r.summary()).filter(Boolean));
}
setInterval(reportNow, 30 * 1000).unref();
reportNow();

function createRoom(vsCpu) {
  const room = new Room({
    id: newCode(), io, dict, records, vsCpu,
    onChange: scheduleReport,
    onDestroy: r => { rooms.delete(r.id); scheduleReport(); },
  });
  rooms.set(room.id, room);
  return room;
}

// 念のための掃除: 6時間動きの無い部屋は消す
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) if (now - r.lastActive > 6 * 3600e3) r.destroy();
}, 10 * 60e3).unref();

/* ───────────── Socket.IO ───────────── */

io.use(async (socket, next) => {
  const user = await lobby.userFromCookieHeader(socket.handshake.headers.cookie);
  if (!user) { next(new Error('unauthorized')); return; }
  socket.data.user = user;
  next();
});

function currentRoom(socket) {
  const info = socket.data.wc;
  return info ? rooms.get(info.roomId) : null;
}

function leaveCurrent(socket, leaving) {
  const room = currentRoom(socket);
  if (room) room.detach(socket, { leaving });
}

function ackOf(args) { return typeof args[args.length - 1] === 'function' ? args.pop() : () => {}; }

io.on('connection', socket => {
  const user = socket.data.user;

  socket.on('create', (...args) => {
    const ack = ackOf(args);
    const { vsCpu, settings } = args[0] || {};
    leaveCurrent(socket, true);
    const room = createRoom(!!vsCpu);
    if (vsCpu) room.setupCpuRoom(user, socket, settings);
    else room.join(user, socket);
    ack({ ok: true, roomCode: room.id });
  });

  socket.on('join', (...args) => {
    const ack = ackOf(args);
    const code = String((args[0] && args[0].code) || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) { ack({ ok: false, error: '部屋が見つかりません(終了したか、コードが違います)' }); return; }
    const prev = currentRoom(socket);
    if (prev && prev !== room) leaveCurrent(socket, true);
    ack(room.join(user, socket));
  });

  socket.on('spectate', (...args) => {
    const ack = ackOf(args);
    const code = String((args[0] && args[0].code) || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) { ack({ ok: false, error: '部屋が見つかりません' }); return; }
    // 自分が参加している部屋なら観戦ではなく席に戻る
    if (room.entryByUser(user.userId)) { ack({ ...room.join(user, socket), rejoined: true }); return; }
    leaveCurrent(socket, true);
    ack(room.spectate(socket));
  });

  socket.on('leave', (...args) => {
    const ack = ackOf(args);
    leaveCurrent(socket, true);
    ack({ ok: true });
  });

  // 対戦中の操作。{ t: 種類, ... }
  socket.on('msg', m => {
    const room = currentRoom(socket);
    const pid = socket.data.wc && socket.data.wc.pid;
    if (!room || !pid || !m || typeof m.t !== 'string') return;
    try {
      switch (m.t) {
        case 'start-config': { const r = room.startConfig(pid, m.settings); if (!r.ok) room.send(pid, { t: 'notice', text: r.error }); break; }
        case 'config-ack': room.configAck(pid); break;
        case 'move': room.handleMove(pid, m, !!m.propose); break;
        case 'propose-cancel': room.cancelProposal(pid); break;
        case 'pass': room.pass(pid); break;
        case 'use-item-start': room.startClear(pid); break;
        case 'use-item': room.useItem(pid, m.item, m.r, m.c); break;
        case 'decline-block-offer': room.declineBlock(pid); break;
        case 'approve-vote': room.vote(pid, !!m.ok); break;
        case 'disc-choice': room.discChoice(pid, m.choice); break;
        case 'rematch-vote': room.rematchVote(pid); break;
        case 'chat': room.chat(pid, m.text); break;
        default: break;
      }
    } catch (e) {
      console.error('部屋の処理でエラー:', e);
    }
  });

  // 辞書(追加単語)の閲覧・編集。編集はアカウントのみ(ゲストは閲覧だけ)
  socket.on('dict-list', (...args) => ackOf(args)({ ok: true, ...dict.listCustom(), canEdit: !user.guest, info: dict.info() }));
  socket.on('dict-add', (...args) => {
    const ack = ackOf(args);
    if (user.guest) { ack({ ok: false, error: '辞書の編集はアカウントでログインした人だけができます' }); return; }
    ack({ ...dict.add(String((args[0] && args[0].word) || '')), ...dict.listCustom(), info: dict.info() });
  });
  socket.on('dict-remove', (...args) => {
    const ack = ackOf(args);
    if (user.guest) { ack({ ok: false, error: '辞書の編集はアカウントでログインした人だけができます' }); return; }
    ack({ ...dict.remove(String((args[0] && args[0].word) || '')), ...dict.listCustom(), info: dict.info() });
  });

  socket.on('disconnect', () => leaveCurrent(socket, false));
});

server.listen(PORT, () => console.log(`ワードチェイン サーバー起動: http://localhost:${PORT}${BASE}/${DEV ? ' (開発モード)' : ''} 辞書 ${dict.info().total}語`));
