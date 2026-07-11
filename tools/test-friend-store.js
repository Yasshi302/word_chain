/**
 * friend-store のユニットテスト: node tools/test-friend-store.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../friend-store');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; } else { failed++; console.error('  NG:', name); }
}

const tmp = path.join(os.tmpdir(), `wc-friend-test-${process.pid}.json`);
function clean() { try { fs.unlinkSync(tmp); } catch {} }
clean();

// 初回読み込み: myFriendCodeが自動生成され、ファイルにも保存される
let d = store.load(tmp);
assert(store.FRIEND_ID_RE.test(d.myFriendCode), '初回はフレンドコードが自動生成される');
assert(Array.isArray(d.friends) && d.friends.length === 0, '初回はフレンド一覧が空');
const firstCode = d.myFriendCode;
d = store.load(tmp);
assert(d.myFriendCode === firstCode, '2回目以降の読み込みでは同じフレンドコードが再利用される(保存されている)');

// フレンド追加
d = store.addFriend(tmp, 'abcdefghjkmn', 'たろう');
assert(d.friends.length === 1 && d.friends[0].friendId === 'abcdefghjkmn' && d.friends[0].name === 'たろう', '1人追加');

// 2人目追加
d = store.addFriend(tmp, 'pqrstuvwxyz2', 'はなこ');
assert(d.friends.length === 2, '2人目も追加される');

// 同じfriendIdを再度追加すると名前が更新される(重複しない)
d = store.addFriend(tmp, 'abcdefghjkmn', 'たろう(改名)');
assert(d.friends.length === 2, '同じfriendIdの再追加は重複せず件数据え置き');
assert(d.friends.find((f) => f.friendId === 'abcdefghjkmn').name === 'たろう(改名)', '再追加で名前が更新される');

// 不正な形式のfriendIdは追加されない
d = store.addFriend(tmp, 'short', 'ふりん');
assert(d.friends.length === 2, '不正な形式(短すぎ)のfriendIdは追加されない');
d = store.addFriend(tmp, 'ABCDEFGHJKLN', 'ふりん'); // 大文字は文字集合外
assert(d.friends.length === 2, '文字集合外の文字を含むfriendIdは追加されない');

// 名前が空なら追加されない
d = store.addFriend(tmp, 'zzzzzzzzzzzz', '   ');
assert(d.friends.length === 2, '名前が空(空白のみ)なら追加されない');

// 自分自身のフレンドコードは追加できない
d = store.addFriend(tmp, d.myFriendCode, '自分');
assert(d.friends.length === 2, '自分自身のフレンドコードは追加できない');

// 削除
d = store.removeFriend(tmp, 'abcdefghjkmn');
assert(d.friends.length === 1 && d.friends[0].friendId === 'pqrstuvwxyz2', '1人削除で残り1人');

// 存在しないfriendIdの削除は無変化
d = store.removeFriend(tmp, 'nonexistent1');
assert(d.friends.length === 1, '存在しないfriendIdの削除は無変化');

// 保存内容は読み込みでも一貫する
d = store.load(tmp);
assert(d.friends.length === 1 && d.friends[0].name === 'はなこ', 'ディスクに保存された内容が読み込みでも一致する');

// 壊れたJSONでも、myFriendCodeを新規生成して壊れずに動く
fs.writeFileSync(tmp, '{壊れた', 'utf8');
d = store.load(tmp);
assert(store.FRIEND_ID_RE.test(d.myFriendCode) && d.friends.length === 0, '壊れたJSONは新規のフレンドコード+空リストとして扱われる');

clean();
console.log(`\n結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
