/**
 * カスタム辞書のファイルストレージ (メインプロセス側)。
 *
 * 保存形式: { updatedAt: <ms>, words: string[] }
 * 旧形式 (単なる string[]) はファイル更新時刻を updatedAt として移行する。
 *
 * すべての関数は破壊的変更のあと「保存後の権威ある辞書全体」を返す。
 * これによりレンダラは戻り値で状態を同期でき、ディスクとの不整合を防げる。
 */
'use strict';

const fs = require('fs');

const HIRAGANA_WORD = /^[ぁ-ゖー]{2,8}$/u;
const MAX_CUSTOM_WORDS = 10000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function fileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

/** words配列を検証・重複除去し、上限内に収める */
function sanitizeWordList(words) {
  const clean = [];
  const seen = new Set();
  if (!Array.isArray(words)) return clean;
  for (const w of words) {
    if (typeof w === 'string' && HIRAGANA_WORD.test(w) && !seen.has(w)) {
      seen.add(w);
      clean.push(w);
      if (clean.length >= MAX_CUSTOM_WORDS) break;
    }
  }
  return clean;
}

/** { updatedAt, words } を読み込む。壊れていれば空辞書を返す。 */
function load(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (raw.length > MAX_FILE_BYTES) return { updatedAt: 0, words: [] };
    const data = JSON.parse(raw);
    let words;
    let updatedAt;
    if (Array.isArray(data)) {
      words = data;
      updatedAt = fileMtime(filePath);
    } else if (data && typeof data === 'object' && Array.isArray(data.words)) {
      words = data.words;
      updatedAt = Number.isFinite(data.updatedAt) ? data.updatedAt : fileMtime(filePath);
    } else {
      return { updatedAt: 0, words: [] };
    }
    return { updatedAt: Math.max(0, updatedAt) || 0, words: sanitizeWordList(words) };
  } catch {
    return { updatedAt: 0, words: [] };
  }
}

/** 保存する。成功で true。 */
function save(filePath, dict) {
  try {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ updatedAt: dict.updatedAt, words: dict.words }),
      'utf8');
    return true;
  } catch {
    return false;
  }
}

function addWord(filePath, word, now) {
  const dict = load(filePath);
  if (typeof word === 'string' && HIRAGANA_WORD.test(word)
      && !dict.words.includes(word) && dict.words.length < MAX_CUSTOM_WORDS) {
    dict.words.push(word);
    dict.updatedAt = now;
    save(filePath, dict);
  }
  return load(filePath);
}

function removeWord(filePath, word, now) {
  const dict = load(filePath);
  const idx = typeof word === 'string' ? dict.words.indexOf(word) : -1;
  if (idx !== -1) {
    dict.words.splice(idx, 1);
    dict.updatedAt = now;
    save(filePath, dict);
  }
  return load(filePath);
}

function setDict(filePath, payload) {
  if (payload && typeof payload === 'object') {
    save(filePath, {
      updatedAt: Number.isFinite(payload.updatedAt) ? payload.updatedAt : Date.now(),
      words: sanitizeWordList(payload.words),
    });
  }
  return load(filePath);
}

/** 2つの辞書を union マージし、更新日は新しい方を採用する */
function merge(a, b) {
  const words = sanitizeWordList([...(a.words || []), ...(b.words || [])]);
  return { updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0), words };
}

module.exports = {
  HIRAGANA_WORD, MAX_CUSTOM_WORDS, sanitizeWordList,
  load, save, addWord, removeWord, setDict, merge,
};
