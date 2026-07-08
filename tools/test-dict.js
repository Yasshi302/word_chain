/**
 * dict-store のユニットテスト: node tools/test-dict.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../dict-store');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; } else { failed++; console.error('  NG:', name); }
}
function eqSet(words, expected) {
  const a = [...words].sort().join(',');
  const b = [...expected].sort().join(',');
  return a === b;
}

const tmp = path.join(os.tmpdir(), `wc-dict-test-${process.pid}.json`);
function clean() { try { fs.unlinkSync(tmp); } catch {} }
clean();

// 空 (ファイルなし)
let d = store.load(tmp);
assert(d.words.length === 0 && d.updatedAt === 0, '存在しないファイルは空辞書');

// 追加
d = store.addWord(tmp, 'りんご', 1000);
assert(eqSet(d.words, ['りんご']) && d.updatedAt === 1000, '1語追加');
d = store.addWord(tmp, 'ごりら', 2000);
assert(eqSet(d.words, ['りんご', 'ごりら']) && d.updatedAt === 2000, '2語目追加');

// 重複追加は無視 (更新日も変わらない)
d = store.addWord(tmp, 'りんご', 3000);
assert(eqSet(d.words, ['りんご', 'ごりら']) && d.updatedAt === 2000, '重複追加は無変化');

// 不正な単語は無視
d = store.addWord(tmp, 'abc', 3000);
assert(eqSet(d.words, ['りんご', 'ごりら']), 'ローマ字は追加されない');
d = store.addWord(tmp, '漢字', 3000);
assert(eqSet(d.words, ['りんご', 'ごりら']), '漢字は追加されない');

// 1語だけ削除 → 残りは保持される (今回のバグ回帰テスト)
d = store.removeWord(tmp, 'ごりら', 4000);
assert(eqSet(d.words, ['りんご']) && d.updatedAt === 4000, '1語削除で残りは保持');

// 存在しない語の削除は無変化
d = store.removeWord(tmp, 'そんざいしない', 5000);
assert(eqSet(d.words, ['りんご']) && d.updatedAt === 4000, '不在語の削除は無変化');

// 最後の1語を削除 → 空
d = store.removeWord(tmp, 'りんご', 6000);
assert(d.words.length === 0 && d.updatedAt === 6000, '最後の語を削除で空');

// 旧形式 (配列) の移行
fs.writeFileSync(tmp, JSON.stringify(['あかい', 'あおい']), 'utf8');
d = store.load(tmp);
assert(eqSet(d.words, ['あかい', 'あおい']) && d.updatedAt > 0, '旧配列形式を移行');

// 壊れたJSONは空辞書
fs.writeFileSync(tmp, '{壊れた', 'utf8');
d = store.load(tmp);
assert(d.words.length === 0, '壊れたJSONは空辞書');

// setDict (置換)
d = store.setDict(tmp, { updatedAt: 7000, words: ['てすと', 'あいう', 'てすと', 'x'] });
assert(eqSet(d.words, ['てすと', 'あいう']) && d.updatedAt === 7000, 'setDictは重複除去・検証');

// merge (union, 新しい日付採用)
const m = store.merge(
  { updatedAt: 100, words: ['あか', 'あお'] },
  { updatedAt: 200, words: ['あお', 'きいろ'] });
assert(eqSet(m.words, ['あか', 'あお', 'きいろ']) && m.updatedAt === 200, 'unionマージ+新日付');

clean();
console.log(`\n結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
