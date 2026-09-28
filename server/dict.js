'use strict';
// 辞書(サーバー側で一元管理)。
//  - 基本辞書: data/dictionary.txt (JMdict 由来、約14万語、変更しない)
//  - 追加単語: 対戦中に承認された単語・設定画面で追加した単語。全員で共有する JSON ファイル
// 以前のデスクトップ版では各PCに追加単語があり対戦時に同期していたが、サーバー型では1つに集約する。

const fs = require('fs');
const path = require('path');
const WordChain = require('../shared/game');

const WORD_RE = /^[ぁ-ゖー]{2,15}$/u;
const MAX_CUSTOM_WORDS = 20000;

function createDictionary({ baseFile, customFile }) {
  const base = new Set();
  const baseStartChars = new Set();
  for (const line of fs.readFileSync(baseFile, 'utf8').split('\n')) {
    const w = line.trim();
    if (w) { base.add(w); baseStartChars.add([...w][0]); }
  }

  let custom = new Set();
  let updatedAt = 0;
  try {
    const data = JSON.parse(fs.readFileSync(customFile, 'utf8'));
    for (const w of Array.isArray(data.words) ? data.words : []) if (typeof w === 'string' && WORD_RE.test(w) && !base.has(w)) custom.add(w);
    updatedAt = Number(data.updatedAt) || 0;
  } catch (e) { /* 初回は空 */ }

  // 拗音(ゃゅょっ等)を直音で入力しても辞書の綴りに直せるようにする逆引き
  const buildNormIndex = words => {
    const idx = new Map();
    for (const w of words) {
      const n = WordChain.normalizeSmallKana(w);
      if (n !== w && !idx.has(n)) idx.set(n, w);
    }
    return idx;
  };
  const baseNorm = buildNormIndex(base);
  let customNorm = buildNormIndex(custom);
  let startChars = new Set(baseStartChars);
  let version = 1; // 追加単語が変わるたびに増える(CPU の索引の作り直し判定に使う)

  function recompute() {
    startChars = new Set(baseStartChars);
    for (const w of custom) startChars.add([...w][0]);
    customNorm = buildNormIndex(custom);
    version++;
  }

  function save() {
    fs.mkdirSync(path.dirname(customFile), { recursive: true });
    const tmp = `${customFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt, words: [...custom] }));
    fs.renameSync(tmp, customFile);
  }

  const has = w => base.has(w) || custom.has(w);

  // 辞書に無くても、拗音→直音の正規化で一致すればその正しい綴りを返す
  function resolve(word) {
    if (has(word)) return { word, indict: true };
    const norm = WordChain.normalizeSmallKana(word);
    if (norm !== word) {
      if (baseNorm.has(norm)) return { word: baseNorm.get(norm), indict: true };
      if (customNorm.has(norm)) return { word: customNorm.get(norm), indict: true };
    }
    return { word, indict: false };
  }

  function add(word) {
    if (!WORD_RE.test(word)) return { ok: false, error: `ひらがな2〜${WordChain.SIZE_MAX}文字で入力してください` };
    if (word.endsWith('ん')) return { ok: false, error: '「ん」で終わる単語は使えないため追加できません' };
    if (base.has(word)) return { ok: false, error: 'その単語は基本辞書に既に含まれています' };
    if (custom.has(word)) return { ok: false, error: 'その単語は既に追加されています' };
    if (custom.size >= MAX_CUSTOM_WORDS) return { ok: false, error: '追加単語の上限に達しています' };
    custom.add(word);
    updatedAt = Date.now();
    recompute();
    save();
    return { ok: true };
  }

  function remove(word) {
    if (!custom.delete(word)) return { ok: false, error: 'その単語は追加単語にありません' };
    updatedAt = Date.now();
    recompute();
    save();
    return { ok: true };
  }

  return {
    has, resolve, add, remove,
    get startChars() { return startChars; },
    get version() { return version; },
    baseWords: () => base,
    customWords: () => custom,
    info: () => ({ total: base.size + custom.size, custom: custom.size, updatedAt }),
    listCustom: () => ({ updatedAt, words: [...custom].sort() }),
  };
}

module.exports = { createDictionary, WORD_RE };
