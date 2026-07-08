/**
 * 辞書生成スクリプト
 *
 * JMdict (日本語多言語辞書, CC BY-SA 4.0, EDRDG) の XML から
 * ひらがな読みを抽出してゲーム用の単語リストを生成する。
 *
 * 使い方: node tools/build-dict.js <JMdict_e.gz のパス>
 * 出力:   data/dictionary.txt (1行1単語, UTF-8)
 *
 * フィルタ条件:
 *  - ひらがな(ぁ-ゖ)と長音符(ー)のみで構成される
 *  - 2文字以上8文字以下 (盤面が8x8のため)
 *  - 「ん」で始まる/終わる単語は除外 (ゲームルール)
 *  - どの単語の先頭にもならない文字で終わる単語は除外
 *    (次のプレーヤーが絶対に続けられないため。っ・小文字・ー など)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MIN_LEN = 2;
const MAX_LEN = 8;

function katakanaToHiragana(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    // ァ(30A1)〜ヶ(30F6) → ぁ(3041)〜ゖ(3096)
    if (code >= 0x30a1 && code <= 0x30f6) {
      out += String.fromCodePoint(code - 0x60);
    } else {
      out += ch;
    }
  }
  return out;
}

function main() {
  const src = process.argv[2];
  if (!src || !fs.existsSync(src)) {
    console.error('使い方: node tools/build-dict.js <JMdict_e.gz のパス>');
    process.exit(1);
  }

  console.log('読み込み中:', src);
  let xml = fs.readFileSync(src);
  if (src.endsWith('.gz')) {
    xml = zlib.gunzipSync(xml);
  }
  xml = xml.toString('utf8');

  const words = new Set();
  const re = /<reb>([^<]+)<\/reb>/g;
  const hiraganaOnly = /^[ぁ-ゖー]+$/u; // ぁ-ゖ と ー
  let m;
  let total = 0;
  while ((m = re.exec(xml)) !== null) {
    total++;
    const w = katakanaToHiragana(m[1]);
    if (!hiraganaOnly.test(w)) continue;
    const len = [...w].length;
    if (len < MIN_LEN || len > MAX_LEN) continue;
    if (w.startsWith('ん') || w.endsWith('ん')) continue;
    words.add(w);
  }
  console.log(`読み取り: ${total} 件 → ひらがな候補: ${words.size} 語`);

  // 行き止まり文字フィルタ: どの単語の先頭にもならない文字で終わる単語を
  // 除外する。除外によって先頭文字集合が変わりうるので固定点まで繰り返す。
  let removedTotal = 0;
  for (;;) {
    const startChars = new Set();
    for (const w of words) startChars.add([...w][0]);
    const toRemove = [];
    for (const w of words) {
      const chars = [...w];
      if (!startChars.has(chars[chars.length - 1])) toRemove.push(w);
    }
    if (toRemove.length === 0) break;
    for (const w of toRemove) words.delete(w);
    removedTotal += toRemove.length;
  }
  console.log(`行き止まり除外: ${removedTotal} 語`);

  const sorted = [...words].sort();
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'dictionary.txt');
  fs.writeFileSync(outPath, sorted.join('\n') + '\n', 'utf8');
  console.log(`出力: ${outPath} (${sorted.length} 語)`);
}

main();
