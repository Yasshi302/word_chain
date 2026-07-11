/**
 * フレンド一覧のファイルストレージ (メインプロセス側)。
 *
 * 保存形式: { myFriendCode: string, friends: [{ friendId, name, addedAt }] }
 * myFriendCode は初回読み込み時に生成し、以後は固定 (部屋コードとは別の恒久ID)。
 *
 * すべての関数は「保存後の権威あるデータ全体」を返す。
 * レンダラはこの戻り値で状態を同期し、ディスクとの不整合を防ぐ。
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');

// 部屋コードと同じ文字集合(紛らわしい i/l/o/0/1 を除外)。恒久IDのため部屋コードより長くする。
const FRIEND_CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const FRIEND_CODE_LEN = 12;
const FRIEND_ID_RE = new RegExp(`^[${FRIEND_CODE_CHARS}]{${FRIEND_CODE_LEN}}$`);
const MAX_FRIENDS = 200;
const MAX_NAME_LEN = 24;
const MAX_FILE_BYTES = 1024 * 1024;

function randomFriendCode() {
  const bytes = crypto.randomBytes(FRIEND_CODE_LEN);
  let s = '';
  for (let i = 0; i < FRIEND_CODE_LEN; i++) s += FRIEND_CODE_CHARS[bytes[i] % FRIEND_CODE_CHARS.length];
  return s;
}

/** friends配列を検証・重複除去(friendId基準、後勝ち)し、上限内に収める */
function sanitizeFriends(list) {
  const map = new Map();
  if (Array.isArray(list)) {
    for (const f of list) {
      if (!f || typeof f !== 'object') continue;
      if (typeof f.friendId !== 'string' || !FRIEND_ID_RE.test(f.friendId)) continue;
      if (typeof f.name !== 'string' || !f.name.trim()) continue;
      map.set(f.friendId, {
        friendId: f.friendId,
        name: f.name.trim().slice(0, MAX_NAME_LEN),
        addedAt: Number.isFinite(f.addedAt) ? f.addedAt : Date.now(),
      });
    }
  }
  return [...map.values()].slice(0, MAX_FRIENDS);
}

function save(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}

/** { myFriendCode, friends } を読み込む。無ければ myFriendCode を生成して保存する。 */
function load(filePath) {
  let data = null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.length <= MAX_FILE_BYTES) data = JSON.parse(raw);
  } catch {
    data = null;
  }
  let myFriendCode = data && typeof data.myFriendCode === 'string' && FRIEND_ID_RE.test(data.myFriendCode)
    ? data.myFriendCode : null;
  const friends = sanitizeFriends(data && data.friends);
  const needsSave = !myFriendCode;
  if (!myFriendCode) myFriendCode = randomFriendCode();
  const result = { myFriendCode, friends };
  if (needsSave) { try { save(filePath, result); } catch {} }
  return result;
}

/** フレンドを追加(既に同じfriendIdがあれば名前を更新)。自分自身は追加できない。 */
function addFriend(filePath, friendId, name) {
  const cur = load(filePath);
  if (typeof friendId !== 'string' || !FRIEND_ID_RE.test(friendId)) return cur;
  if (friendId === cur.myFriendCode) return cur;
  const trimmedName = typeof name === 'string' ? name.trim().slice(0, MAX_NAME_LEN) : '';
  if (!trimmedName) return cur;
  const merged = [...cur.friends.filter((f) => f.friendId !== friendId), { friendId, name: trimmedName, addedAt: Date.now() }];
  const next = { myFriendCode: cur.myFriendCode, friends: sanitizeFriends(merged) };
  save(filePath, next);
  return next;
}

function removeFriend(filePath, friendId) {
  const cur = load(filePath);
  const next = { myFriendCode: cur.myFriendCode, friends: cur.friends.filter((f) => f.friendId !== friendId) };
  save(filePath, next);
  return next;
}

module.exports = {
  load, addFriend, removeFriend,
  FRIEND_ID_RE, FRIEND_CODE_LEN, MAX_FRIENDS, MAX_NAME_LEN,
};
