/**
 * フレンド招待用の常時接続 (PeerJS)。
 *
 * 対戦用の通信 (net.js) とは完全に別のPeerインスタンス・別のID空間を使う
 * (ID_PREFIX 'wordchain-jp-friend-' + 恒久フレンドコード)。アプリ起動中は
 * 常にこの接続を維持し、招待メッセージの送受信のみを行う。対戦データは
 * 一切扱わない。
 *
 * 信頼できる送信元の判定は、メッセージ内の自己申告フィールドではなく、
 * 実際に接続してきたPeer ID (conn.peer) を、自分のフレンド一覧と照合して
 * 行う (フレンド以外からの接続は無条件で無視する)。
 */
'use strict';

const Presence = (() => {
  const PREFIX = 'wordchain-jp-friend-';
  const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
  const CODE_LEN = 12;
  const CODE_RE = new RegExp(`^[${CODE_CHARS}]{${CODE_LEN}}$`);
  const MSG_MAX = 1024;
  const CONNECT_TIMEOUT_MS = 8000;

  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'turn:eu-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
      { urls: 'turn:us-0.turn.peerjs.com:3478', username: 'peerjs', credential: 'peerjsp' },
    ],
  };
  const PEER_OPTS = { debug: 1, config: ICE_CONFIG };

  let peer = null;
  let friendIds = new Set();
  let events = {};

  function emit(name, ...args) {
    if (typeof events[name] === 'function') events[name](...args);
  }

  function validInvite(d) {
    if (!d || typeof d !== 'object' || d.t !== 'invite') return false;
    let json;
    try { json = JSON.stringify(d); } catch { return false; }
    if (json.length > MSG_MAX) return false;
    return typeof d.fromName === 'string' && d.fromName.length <= 24
      && typeof d.roomCode === 'string' && d.roomCode.length <= 8
      && typeof d.password === 'string' && d.password.length <= 64;
  }

  function handleConn(conn) {
    const remoteCode = typeof conn.peer === 'string' && conn.peer.startsWith(PREFIX)
      ? conn.peer.slice(PREFIX.length) : '';
    conn.on('data', (d) => {
      if (!CODE_RE.test(remoteCode) || !friendIds.has(remoteCode)) { try { conn.close(); } catch {} return; }
      if (!validInvite(d)) return;
      emit('onInvite', { fromFriendId: remoteCode, fromName: d.fromName, roomCode: d.roomCode, password: d.password });
    });
    conn.on('error', () => {});
  }

  /** アプリ起動時に一度だけ呼ぶ。myFriendCode: 自分の恒久ID、friendList: 現在のフレンド一覧 */
  function start(myFriendCode, friendList, ev) {
    events = ev || {};
    setFriendList(friendList);
    if (!CODE_RE.test(myFriendCode)) return;
    stop();
    peer = new Peer(PREFIX + myFriendCode, PEER_OPTS);
    peer.on('connection', handleConn);
    peer.on('disconnected', () => { try { if (peer && !peer.destroyed) peer.reconnect(); } catch {} });
    // 在席接続はベストエフォート(失敗しても対戦自体はブロックしない)ため、エラーは握りつぶす
    peer.on('error', () => {});
  }

  function stop() {
    if (peer) { try { peer.destroy(); } catch {} peer = null; }
  }

  /** フレンド一覧が変わるたびに呼び、招待の送信元チェックに使う一覧を更新する */
  function setFriendList(friendList) {
    friendIds = new Set((friendList || []).map((f) => f.friendId));
  }

  /** 招待を送る。onResult({ok:true}) は相手が在席(オンライン)で送信できた場合、
   * {ok:false, reason:'offline'} は相手が起動していない/届かなかった場合。 */
  function sendInvite(toFriendId, fromName, roomCode, password, onResult) {
    const finish = (res) => { if (typeof onResult === 'function') onResult(res); };
    if (!CODE_RE.test(toFriendId)) { finish({ ok: false, reason: 'invalid' }); return; }
    if (!peer || peer.destroyed) { finish({ ok: false, reason: 'offline' }); return; }
    let done = false;
    let conn;
    try {
      conn = peer.connect(PREFIX + toFriendId, { reliable: true, serialization: 'json' });
    } catch {
      finish({ ok: false, reason: 'offline' });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { conn.close(); } catch {}
      finish({ ok: false, reason: 'offline' });
    }, CONNECT_TIMEOUT_MS);
    conn.on('open', () => {
      try { conn.send({ t: 'invite', fromName, roomCode, password }); } catch {}
      if (done) return;
      done = true;
      clearTimeout(timer);
      finish({ ok: true });
      setTimeout(() => { try { conn.close(); } catch {} }, 500);
    });
    conn.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      finish({ ok: false, reason: 'offline' });
    });
  }

  return { start, stop, setFriendList, sendInvite, CODE_LEN, CODE_RE };
})();
