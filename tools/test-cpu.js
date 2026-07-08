/**
 * CPU (オフラインAI) の簡易テスト: node tools/test-cpu.js
 */
'use strict';

const WC = require('../renderer/game.js');
global.WordChain = WC; // cpu.js は WordChain をグローバル参照する想定 (ブラウザのscript読み込み順に合わせる)
const CPU = require('../renderer/cpu.js');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; } else { failed++; console.error('  NG:', name); }
}

const dict = new Set(['あかり', 'あかさたな', 'あき', 'あさひ', 'あいうえお', 'あいさつ', 'いぬ', 'いか']);
const startChars = new Set([...dict].map((w) => [...w][0]));
startChars.add('り'); startChars.add('き'); startChars.add('な'); startChars.add('ひ'); startChars.add('つ'); startChars.add('お');

const wordIndex = CPU.buildWordIndex([dict]);
const startCharCounts = CPU.buildStartCharCounts([dict]);

function newG() {
  return WC.newGame({ size: 8, letters: ['あ', 'い', 'う', 'え'], players: ['p0', 'p1'], first: 0, timeLimit: 30 });
}

// ---- buildWordIndex ----
assert(wordIndex.get('あ').get(3).includes('あかり'), 'あ×3文字に「あかり」が入る');
assert(wordIndex.get('あ').get(5).includes('あかさたな'), 'あ×5文字に「あかさたな」が入る');
assert(wordIndex.get('い').get(2).includes('いぬ') && wordIndex.get('い').get(2).includes('いか'), 'い×2文字に2語');

// ---- enumerateMoves: 盤面制約を満たす辞書語だけを列挙する ----
{
  const g = newG();
  const moves = CPU.enumerateMoves(g, wordIndex, startChars);
  assert(moves.length > 0, '初期盤面で辞書語の手が見つかる');
  assert(moves.every((m) => dict.has(m.word)), '列挙される手はすべて辞書に実在する単語');
  assert(moves.every((m) => !g.usedWords.has(m.word)), '既に使われた単語は含まれない');
}

// ---- chooseMove: strongest は常に最大文字数を選ぶ ----
{
  const g = newG();
  const move = CPU.chooseMove(g, wordIndex, startChars, 'strongest', startCharCounts);
  assert(move !== null, 'strongestは手を返す');
  const moves = CPU.enumerateMoves(g, wordIndex, startChars);
  const maxLen = Math.max(...moves.map((m) => m.len));
  assert(move.len === maxLen, 'strongestは最大文字数の単語を選ぶ');
}

// ---- chooseMove: 候補が無ければ null (パス) ----
{
  const g = newG();
  const emptyIndex = new Map();
  const move = CPU.chooseMove(g, emptyIndex, startChars, 'strongest', startCharCounts);
  assert(move === null, '置ける辞書語が無ければnull(パス)を返す');
}

// ---- chooseMove: weak/normal/strongは指定レンジ内、または候補が無ければ全体からフォールバック ----
{
  const g = newG();
  for (const level of ['weak', 'normal', 'strong']) {
    const move = CPU.chooseMove(g, wordIndex, startChars, level, startCharCounts);
    assert(move !== null, `${level}は手を返す`);
    const moves = CPU.enumerateMoves(g, wordIndex, startChars);
    assert(moves.some((m) => m.word === move.word && m.r === move.r && m.c === move.c && m.dir === move.dir), `${level}が選ぶ手は列挙された候補の中にある`);
  }
}

console.log(`\n結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
