/**
 * ゲームロジックの簡易テスト: node tools/test-game.js
 */
'use strict';

const WC = require('../renderer/game.js');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; } else { failed++; console.error('  NG:', name); }
}

const startChars = new Set([...'あかさたりなにこんごぺめよき'].filter((c) => c !== 'ん'));
startChars.add('め'); startChars.add('ご');

function newG(size, players, first) {
  return WC.newGame({ size, letters: ['あ', 'か', 'さ', 'た'], players, first: first || 0, timeLimit: 30 });
}

// ---- 盤面サイズ ----
let g = newG(8, ['p0', 'p1']);
const c = WC.centerCells(8);
assert(c[0][0] === 3 && c[3][1] === 4, '8x8 中央は(3,3)〜(4,4)');
assert(g.board[3][3] === 'あ' && g.board[4][4] === 'た', '8x8 初期配置');

let g15 = newG(15, ['p0', 'p1']);
assert(g15.size === 15, '15x15 サイズ');
const c15 = WC.centerCells(15);
assert(c15[0][0] === 6 && c15[3][0] === 7, '15x15 中央は(6,6)〜(7,7)');
assert(WC.clampSize(20) === 15 && WC.clampSize(3) === 8 && WC.clampSize(11) === 11, 'clampSize');

// はみ出し (15盤面は長い単語も入る)
assert(WC.maxLen(g15, 6, 6, 4) === 9, '15盤面 (6,6)から右は9マス');
assert(WC.maxLen(g, 3, 3, 4) === 5, '8盤面 (3,3)から右は5マス');

// ---- 基本の手 (2人) ----
let v = WC.validateMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, startChars);
assert(v.ok && v.newCount === 1, '交差一致する単語はOK');
v = WC.validateMove(g, { r: 3, c: 3, dir: 4, word: 'あさり' }, startChars);
assert(!v.ok, '交差不一致はNG');
v = WC.validateMove(g, { r: 3, c: 3, dir: 6, word: 'あん' }, startChars);
assert(!v.ok, '「ん」終わりNG');

// ---- 小さい文字で終わる単語: 対応する直音として扱われればOK ----
{
  const directTargets = new Set([...'つやゆよあいうえお']);
  const g0 = newG(8, ['p0', 'p1']);
  // 「あかっ」: 「っ」→「つ」として扱われ、「つ」がstartCharsにあればOK
  let vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかっ' }, directTargets);
  assert(vv.ok, '「っ」終わりは「つ」として扱われOK (直音がstartCharsにある場合)');
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかゃ' }, directTargets);
  assert(vv.ok, '「ゃ」終わりは「や」として扱われOK');
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかゅ' }, directTargets);
  assert(vv.ok, '「ゅ」終わりは「ゆ」として扱われOK');
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかょ' }, directTargets);
  assert(vv.ok, '「ょ」終わりは「よ」として扱われOK');
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかぁ' }, directTargets);
  assert(vv.ok, '「ぁ」終わりは「あ」として扱われOK');
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかぃ' }, directTargets);
  assert(vv.ok, '「ぃ」終わりは「い」として扱われOK');
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかぅ' }, directTargets);
  assert(vv.ok, '「ぅ」終わりは「う」として扱われOK');
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかぇ' }, directTargets);
  assert(vv.ok, '「ぇ」終わりは「え」として扱われOK');
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかぉ' }, directTargets);
  assert(vv.ok, '「ぉ」終わりは「お」として扱われOK');
  // 直音がstartCharsに無ければ、小さい文字終わりでも従来通りNG
  const noDirect = new Set([...'かさたな']);
  vv = WC.validateMove(g0, { r: 3, c: 3, dir: 4, word: 'あかっ' }, noDirect);
  assert(!vv.ok, '対応する直音がstartCharsに無ければ「っ」終わりはNGのまま');
}

WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
assert(g.scores.p0 === 3, '得点は全文字数');
assert(WC.currentPlayer(g) === 'p1', '手番交代 p0->p1');
assert(g.chain.r === 3 && g.chain.c === 5, 'チェーン末尾');
assert(WC.startCells(g).length === 1, '2手目は開始固定');

WC.applyMove(g, { r: 3, c: 5, dir: 6, word: 'りんご' }, 'p1');
assert(WC.currentPlayer(g) === 'p0', '手番が p0 に戻る');
assert(g.scores.p1 === 3, 'p1得点');

// ---- N人 (3人) の巡回と終了 ----
let g3 = newG(8, ['p0', 'p1', 'p2'], 0);
assert(WC.activeCount(g3) === 3, '3人active');
WC.applyPass(g3);
assert(WC.currentPlayer(g3) === 'p1' && !g3.over, '3人: 1パス目');
WC.applyPass(g3);
assert(WC.currentPlayer(g3) === 'p2' && !g3.over, '3人: 2パス目は継続');
WC.applyPass(g3);
assert(g3.over, '3人: 3連続パスで終了');

// パスの間に単語が入るとリセット
let g3b = newG(8, ['p0', 'p1', 'p2'], 0);
WC.applyPass(g3b); // p0 pass -> p1
WC.applyMove(g3b, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p1'); // -> p2
assert(g3b.passStreak === 0, 'passStreakリセット');
WC.applyPass(g3b); // p2
WC.applyPass(g3b); // p0
assert(!g3b.over, '2連続では未終了(3人)');

// ---- 手番巡回はやりきる: 4人 ----
let g4 = newG(10, ['p0', 'p1', 'p2', 'p3'], 2);
assert(WC.currentPlayer(g4) === 'p2', 'first=2 は p2 から');
WC.applyPass(g4);
assert(WC.currentPlayer(g4) === 'p3', 'p2->p3');
WC.applyPass(g4);
assert(WC.currentPlayer(g4) === 'p0', 'p3->p0 (巡回)');

// ---- 途中退出 (継続=removePlayer) ----
let gr = newG(8, ['p0', 'p1', 'p2'], 0); // turn p0
WC.removePlayer(gr, 'p1');
assert(WC.activeCount(gr) === 2 && !gr.over, 'p1除外で2人継続');
WC.applyPass(gr); // p0 pass -> 次はp2 (p1スキップ)
assert(WC.currentPlayer(gr) === 'p2', '除外プレーヤーはスキップ');
WC.removePlayer(gr, 'p2');
assert(gr.over, '残り1人で終了');

// 手番中のプレーヤーを除外したら次へ送る
let gr2 = newG(8, ['p0', 'p1', 'p2'], 1); // turn p1
WC.removePlayer(gr2, 'p1');
assert(WC.currentPlayer(gr2) === 'p2', '手番者除外で次へ');

// ---- winners ----
let gw = newG(8, ['p0', 'p1', 'p2'], 0);
gw.scores.p0 = 5; gw.scores.p1 = 8; gw.scores.p2 = 8;
assert(JSON.stringify(WC.winners(gw)) === JSON.stringify(['p1', 'p2']), '同点は複数勝者');
gw.scores.p2 = 3;
assert(JSON.stringify(WC.winners(gw)) === JSON.stringify(['p1']), '単独勝者');

// ---- カタカナ変換 ----
assert(WC.katakanaToHiragana('アニメ') === 'あにめ', 'カタカナ→ひらがな');
assert(WC.katakanaToHiragana('らーめん') === 'らーめん', 'ーは維持');

// ---- ローマ字→ひらがな変換 (直接入力モード想定) ----
assert(WC.romajiToHiragana('konnnichiha', true) === 'こんにちは', '「nn」の「ん」変換');
assert(WC.romajiToHiragana('kya', true) === 'きゃ', '拗音 kya→きゃ');
assert(WC.romajiToHiragana('gakkou', true) === 'がっこう', '促音の二重子音 kk→っk');
assert(WC.romajiToHiragana('matcha', true) === 'まっちゃ', 'ヘボン式 tcha→っちゃ');
assert(WC.romajiToHiragana('shashin', true) === 'しゃしん', 'sh系拗音+ん (子音の前のn)');
assert(WC.romajiToHiragana('tsukue', true) === 'つくえ', 'tsu→つ');
assert(WC.romajiToHiragana('sakura', true) === 'さくら', '通常のローマ字');
assert(WC.romajiToHiragana('hon', false) === 'ほn', '末尾の単独nは確定前は保留(finalize=false)');
assert(WC.romajiToHiragana('hon', true) === 'ほん', '末尾の単独nはfinalize=trueで「ん」になる');
assert(WC.romajiToHiragana('ky', false) === 'ky', '拗音の途中(ky)は未確定のまま保留');
assert(WC.romajiToHiragana('あいうえお', true) === 'あいうえお', 'ひらがなはそのまま通す');
assert(WC.romajiToHiragana('ra-men', true) === 'らーめん', '「-」は長音符「ー」に変換される');
assert(WC.romajiToHiragana('ko-hi-', true) === 'こーひー', '複数の「-」もそれぞれ「ー」に変換される');

// ---- 単語の最大文字数 (盤面最大15までOK) ----
assert(WC.WORD_RE.test('あ'.repeat(15)), '15文字の単語もOK');
assert(!WC.WORD_RE.test('あ'.repeat(16)), '16文字はNG');
assert(WC.WORD_RE.test('あいうえおかきくけこ'), '10文字の単語もOK (旧8文字制限の再発防止)');

// ---- 拗音の直音入力 ----
assert(WC.normalizeSmallKana('しゃしん') === 'しやしん', '拗音を直音に正規化');
assert(WC.normalizeSmallKana('がっこう') === 'がつこう', '促音を直音に正規化');
{
  let gk = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30 });
  // 盤面に「ゃ」をセットアップ (直接適用。validateMoveは経由しない)
  WC.applyMove(gk, { r: 3, c: 3, dir: 0, word: 'あきゃ' }, 'p0');
  assert(gk.board[1][1] === 'ゃ', 'セットアップ: (1,1)に「ゃ」が置かれている');
  const vk = WC.validateMove(gk, { r: 1, c: 1, dir: 0, word: 'やり' }, startChars);
  assert(vk.ok, '「ゃ」から続ける際に直音「や」で入力してもOK (拗音の直音入力)');
}

// ---- お邪魔マス ----
{
  let go = WC.newGame({
    size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    obstacleCells: [[3, 5]],
  });
  assert(go.blocked[3][5] === true, 'お邪魔マスがblockedに反映される');
  assert(WC.maxLen(go, 3, 3, 4) === 2, 'お邪魔マス手前でmaxLenが止まる (8盤面(3,3)から右、(3,5)が壁)');
  let vo = WC.validateMove(go, { r: 3, c: 3, dir: 4, word: 'あかり' }, startChars);
  assert(!vo.ok, 'お邪魔マスを越える単語はNG');
}

// ---- 初期文字配置: デフォルト/ランダム ----
{
  const cellsDefault1 = WC.generateInitialCells(8, 'default', 1);
  assert(cellsDefault1.length === 1, 'デフォルト1マス');
  const cellsDefault4 = WC.generateInitialCells(8, 'default', 4);
  assert(cellsDefault4.length === 4, 'デフォルト4マス');
  const cellsRandom7 = WC.generateInitialCells(10, 'random', 7);
  assert(cellsRandom7.length === 7, 'ランダム7マス');
  const seen = new Set(cellsRandom7.map(([r, c]) => r + ',' + c));
  assert(seen.size === 7, 'ランダム配置は重複しない');
}

// ---- お邪魔マス生成は初期文字マスの周囲2マスを避ける。数は全マス数の20%まで手入力できる ----
{
  const initCells = WC.generateInitialCells(10, 'default', 4); // 固定位置(中央2×2)でテストを決定的にする
  const obstacles = WC.generateObstacleCells(10, initCells, 7);
  const chebyshev = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  assert(
    obstacles.every(([r, c]) => initCells.every((ic) => chebyshev([r, c], ic) > 2)),
    'お邪魔マスは初期文字マスの周囲2マス以内には配置されない'
  );
  assert(obstacles.length === 7, 'お邪魔マスの数は指定通り(7)になる');
  assert(WC.maxObstacleCount(10) === 20, '10x10盤面のお邪魔マス上限は全100マスの20%=20');
  assert(WC.maxObstacleCount(8) === 12, '8x8盤面のお邪魔マス上限は全64マスの20%=12 (floor)');
  assert(WC.generateObstacleCells(10, initCells, 999).length === 20, 'お邪魔マスの数は20%(20マス)に制限される');
  assert(WC.generateObstacleCells(10, initCells, 0).length === 1, 'お邪魔マスの数は最小1になる');
}

// ---- 奇数盤面かつデフォルト配置は、真の中央から時計回りに配置する ----
{
  const c1 = WC.generateInitialCells(9, 'default', 1);
  assert(JSON.stringify(c1) === JSON.stringify([[4, 4]]), '9x9デフォルト1マスは真の中央(4,4)');
  const c4 = WC.generateInitialCells(9, 'default', 4);
  assert(JSON.stringify(c4) === JSON.stringify([[4, 4], [3, 4], [3, 5], [4, 5]]), '9x9デフォルト4マスは中央から時計回り(北→北東→東)');
  // 偶数盤面は従来通り2×2ブロック
  const c4even = WC.generateInitialCells(8, 'default', 4);
  assert(JSON.stringify(c4even) === JSON.stringify(WC.centerCells(8)), '偶数盤面のデフォルト配置は従来通り2×2ブロック');
}

// ---- 陣取りモード: 他人のマスを通ると相手の得点を1点減らす ----
{
  const gt = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, territoryMode: true });
  assert(gt.territoryMode === true, 'territoryModeフラグがgameに反映される');
  let res1 = WC.applyMove(gt, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0'); // (3,3)あ(既存/初期)(3,4)か(既存/初期,一致)(3,5)り(新規)
  assert(gt.scores.p0 === 3, '陣取りモードでも自分の得点は単語の全文字数');
  assert(gt.owner[3][4] === 'p0', '初期文字マス(元は無所有)を通ると所有者になる (誰も減点されない)');
  assert(gt.scores.p1 === 0, '初期文字マスは元々無所有なので、通っても他人は減点されない');
  assert(res1.captured.some(([r, c]) => r === 3 && c === 4), '初期文字マスの上書きもcapturedに含まれる(再描画用)');
  assert(Object.keys(res1.territoryLosses).length === 0, '元々無所有のマスを通っても減点対象(territoryLosses)は無い');
  const res2 = WC.applyMove(gt, { r: 3, c: 5, dir: 6, word: 'りんご' }, 'p1'); // (3,5)り(p0所有)(4,5)ん...
  assert(gt.scores.p0 === 2, '陣取りモード: 自分のマスをp1に通られたp0は1点減る (3->2)');
  assert(gt.owner[3][5] === 'p1', '通られたマスの所有者はp1に移る');
  assert(gt.scores.p1 === 3, 'p1は単語の全文字数を獲得 (通常通り)');
  assert(res2.territoryLosses.p0 === 1, 'applyMoveの返り値に被害者(p0)の減点数が入る');
  assert(gt.history[gt.history.length - 1].territoryLosses.p0 === 1, '履歴にも被害者の減点数が記録される(表示用)');
  assert(res2.captured.some(([r, c]) => r === 3 && c === 5), '奪ったマスがcapturedに含まれる(再描画用)');

  // 通常モード(territoryMode省略)では所有者を通っても減点されない
  const gn = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30 });
  WC.applyMove(gn, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
  WC.applyMove(gn, { r: 3, c: 5, dir: 6, word: 'りんご' }, 'p1');
  assert(gn.scores.p0 === 3, '通常モードでは自分のマスを他人に通られても減点されない');
}

// ---- 時間選択肢 (無制限=0を含む) ----
assert(JSON.stringify(WC.TIME_CHOICES) === JSON.stringify([10, 30, 60, 120, 180, 240, 300, 0]), '入力時間の選択肢 (2分・4分を追加)');

// ---- ボーナスマス(逆転support・階層版): 最下位のプレーヤーが相手(リーダー)と10点差以上のときだけ出現。
// 10〜19点差は加点マスのみ、20〜29点差は加点マス+×2倍マス、30点差以上はさらに×2〜3倍マスも出現候補になる。
// 開始5ターンまでは出現しない。加点マスと倍率マスは別々に(同じマスに重複しないよう)独立して抽選され、
// プレーヤーからは見えない(盤面には表示されない)。 ----
function pushDummyTurns(g, n) { for (let i = 0; i < n; i++) g.history.push({ pass: true, by: 'p0' }); }
{
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  assert(g.bonusMode === true, 'bonusModeフラグがgameに反映される');
  assert(g.bonusFlatCell === null && g.bonusFlatValue === null, '初期状態では加点マスは無い');
  assert(g.bonusMultCell === null && g.bonusMultValue === null, '初期状態では倍率マスは無い');
  assert(WC.bonusAppearProbability(g) === 0, '同点(差0)では出現確率は0');
  const r = WC.pickBonusCells(g);
  assert(r.flat === null && r.multiplier === null, '確率0なら両方とも選ばれない (null)');
}
{
  // 開始5ターンまでは、得点差・最下位判定に関わらず出現しない
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  g.scores.p0 = 0; g.scores.p1 = 40;
  pushDummyTurns(g, 4); // まだ5ターンに達していない
  assert(WC.bonusAppearProbability(g) === 0, '開始5ターンまではボーナスマスは出現しない');
  g.history.push({ pass: true, by: 'p0' }); // 5ターン目
  assert(WC.bonusAppearProbability(g) > 0, '5ターンに達すると条件を満たせば出現し得る');
}
{
  // 手番(p0)が最下位でない場合は確率0
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  pushDummyTurns(g, 5);
  g.scores.p0 = 10; g.scores.p1 = 0; // p1の方が少ない = p0は最下位ではない
  assert(WC.bonusAppearProbability(g) === 0, '手番のプレーヤーが最下位でなければ確率0');
}
{
  // 得点差が10点未満なら確率0(新設の下限)
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  pushDummyTurns(g, 5);
  g.scores.p0 = 0; g.scores.p1 = 9;
  assert(WC.bonusAppearProbability(g) === 0, '得点差が10点未満なら確率0');
}
{
  // 手番(p0)が最下位、10点差以上かつ差が大きいほど確率が上がる (8x8=64マス、割る数=4→スケール16)
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  pushDummyTurns(g, 5);
  g.scores.p0 = 0; g.scores.p1 = 16; // 差16 → 16/16 = 1.0 だが上限0.75でクランプ
  assert(WC.bonusAppearProbability(g) === 0.75, '得点差が大きくても確率は上限0.75まで');
  g.scores.p1 = 12; // 差12 → 12/16 = 0.75 (ちょうど上限)
  assert(WC.bonusAppearProbability(g) === 0.75, '差12(スケール16の0.75)でちょうど上限に達する');
}
{
  // 10〜19点差では加点マス(flat)のみが出現候補になる(倍率マスは出ない)
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  pushDummyTurns(g, 5);
  g.scores.p0 = 0; g.scores.p1 = 15; // 差15 (10〜19点差の範囲)
  let hits = 0;
  for (let i = 0; i < 200; i++) {
    const r = WC.pickBonusCells(g);
    assert(r.multiplier === null, '10〜19点差では倍率マスは出現しない');
    if (r.flat === null) continue;
    hits++;
    assert(Number.isInteger(r.flat.value) && r.flat.value >= 1 && r.flat.value <= 5, '加点マスの値は1〜5');
  }
  assert(hits > 0, '200回試行すれば何回かは当たる');
}
{
  // 20〜29点差では加点マス・×2倍マスの両方が出現候補になる(×2のみ、×3は出ない)。
  // 別々のマスに配置され、重複しない。
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  pushDummyTurns(g, 5);
  g.scores.p0 = 0; g.scores.p1 = 25; // 差25 (20〜29点差の範囲)
  let sawFlat = false, sawMultiplier = false;
  for (let i = 0; i < 300; i++) {
    const r = WC.pickBonusCells(g);
    if (r.flat) sawFlat = true;
    if (r.multiplier) {
      sawMultiplier = true;
      assert(r.multiplier.value === 2, '20〜29点差の倍率マスは×2のみ(×3はまだ出ない)');
    }
    if (r.flat && r.multiplier) {
      assert(!(r.flat.cell[0] === r.multiplier.cell[0] && r.flat.cell[1] === r.multiplier.cell[1]), '加点マスと倍率マスは同じマスに重複しない');
    }
  }
  assert(sawFlat, '20〜29点差でも加点マスが出現する');
  assert(sawMultiplier, '20〜29点差で倍率マス(×2)も出現候補に加わる');
}
{
  // 30点差以上では倍率マスが×2または×3のランダムになる
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  pushDummyTurns(g, 5);
  g.scores.p0 = 0; g.scores.p1 = 40; // 差40 (30点差以上)
  const seenValues = new Set();
  for (let i = 0; i < 300; i++) {
    const r = WC.pickBonusCells(g);
    if (!r.multiplier) continue;
    assert(r.multiplier.value === 2 || r.multiplier.value === 3, '30点差以上の倍率マスは2か3のいずれか');
    seenValues.add(r.multiplier.value);
  }
  assert(seenValues.has(2) && seenValues.has(3), '30点差以上では倍率マスが2と3の両方出現する');
}
{
  // (3,3)あ(既存/初期) →(3,4)か(既存/初期,一致) →(3,5)り(新規) の3マスの単語。加点マスを3マス目に置く
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  g.bonusFlatCell = [3, 5]; g.bonusFlatValue = 3;
  const res = WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
  assert(g.scores.p0 === 6, '加点マス(+3)を通った単語は得点に加点される (3文字+3→6点)');
  assert(g.history[g.history.length - 1].points === 6, '履歴のpointsも加点反映後の実際の得点(6)になる');
  assert(res.flatValue === 3 && res.multValue === null, 'applyMoveの返り値に加点のみのヒット情報が入る');
}
{
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  g.bonusMultCell = [3, 5]; g.bonusMultValue = 2;
  const res = WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
  assert(g.scores.p0 === 6, '倍率マス(2倍)を通った単語は得点が2倍になる (3文字→6点)');
  assert(res.flatValue === null && res.multValue === 2, 'applyMoveの返り値に倍率のみのヒット情報が入る');
}
{
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  g.bonusMultCell = [3, 5]; g.bonusMultValue = 3;
  WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
  assert(g.scores.p0 === 9, '倍率マス(3倍)を通った単語は得点が3倍になる (3文字→9点)');
}
{
  // 加点マスと倍率マスを同時に取得した場合(4文字の単語で新規2マスにそれぞれ配置)、
  // 加点を適用した後に倍率をかける (4文字+加点2→(4+2)*2=12点)
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  g.bonusFlatCell = [3, 5]; g.bonusFlatValue = 2; // 3マス目(新規セル)
  g.bonusMultCell = [3, 6]; g.bonusMultValue = 2; // 4マス目(新規セル、加点マスとは別マス)
  const res = WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかりす' }, 'p0');
  assert(g.scores.p0 === 12, '加点と倍率を同時取得した場合、加点適用後に倍率をかける ((4+2)*2=12)');
  assert(res.flatValue === 2 && res.multValue === 2, 'applyMoveの返り値に両方のヒット情報が入る');
}
{
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, bonusMode: true });
  g.bonusMultCell = [5, 5]; g.bonusMultValue = 2; // 単語が通らない位置
  const res = WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
  assert(g.scores.p0 === 3, 'ボーナスマスを通らない単語は通常通りの得点のまま');
  assert(res.flatValue === null && res.multValue === null, 'ボーナスマスを通らなければヒット情報もnull');
}
{
  // bonusModeを付けなければ、bonusCellが(誤って)設定されていても効果が無い
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30 });
  g.bonusMultCell = [3, 5]; g.bonusMultValue = 2;
  WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
  assert(g.scores.p0 === 3, 'bonusMode無効ならbonusCellがあっても倍にならない');
}

// ---- アイテム: 開始時は誰も所持しておらず、盤面の非表示アイテムマスに新しく文字を置くと入手する ----
{
  const initialCells = [[3, 3], [3, 4], [4, 3], [4, 4]];
  const g = WC.newGame({
    size: 8, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    obstacleCells: [[0, 0]], itemsMode: true,
  });
  assert(g.itemsMode === true, 'itemsModeフラグがgameに反映される');
  assert(g.items.p0.clear === 0 && g.items.p0.block === 0 && g.items.p0.wildcard === 0, '開始時は誰も所持していない(0個)');
  assert(g.itemCells.clear.length === 1 && g.itemCells.block.length === 1 && g.itemCells.wildcard.length === 1,
    '回数省略時は各アイテムのマスが1個ずつ盤面に配置される');
  const seen = new Set();
  for (const [r, c] of [...g.itemCells.clear, ...g.itemCells.block, ...g.itemCells.wildcard]) {
    assert(!seen.has(r * 100 + c), 'アイテムマスは3種類とも重複しない');
    seen.add(r * 100 + c);
    assert(g.board[r][c] === null, 'アイテムマスは未入力(空白)マスに配置される');
    assert(!(r === 0 && c === 0), 'アイテムマスはお邪魔マスの位置には配置されない');
  }
}
{
  // アイテムマスの上に新しく文字を置くと入手できる(itemCellsから消え、所持数が増える)
  const initialCells = [[3, 3], [3, 4], [4, 3], [4, 4]];
  const g = WC.newGame({
    size: 8, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true,
  });
  g.itemCells = { clear: [[3, 5]], block: [[3, 6]], wildcard: [] };
  const res = WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかりす' }, 'p0'); // (3,5)り (3,6)す が新規
  assert(res.itemsGot.clear === 1 && res.itemsGot.block === 1 && res.itemsGot.wildcard === 0,
    '経路上の新規マスに重なったアイテムを入手する');
  assert(g.items.p0.clear === 1 && g.items.p0.block === 1, '入手したアイテムが所持数に加算される');
  assert(g.itemCells.clear.length === 0 && g.itemCells.block.length === 0, '入手済みのアイテムマスは消える');
}
{
  // アイテムマスに重ならなければ何も入手しない
  const g = WC.newGame({
    size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30, itemsMode: true,
  });
  g.itemCells = { clear: [[5, 5]], block: [], wildcard: [] }; // 単語が通らない位置
  const res = WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
  assert(res.itemsGot.clear === 0, '経路外のアイテムマスは入手しない');
  assert(g.itemCells.clear.length === 1, '入手しなかったアイテムマスは残る');
}
{
  // 配置数はゲーム開始前に個別に設定できる(クリア3・ブロック0・ワイルドカード2)
  const g = WC.newGame({
    size: 10, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true, itemClearCount: 3, itemBlockCount: 0, itemWildcardCount: 2,
  });
  assert(g.itemCells.clear.length === 3, '指定した数(クリア3)のマスが配置される');
  assert(g.itemCells.block.length === 0, '0を指定したアイテムは配置されない');
  assert(g.itemCells.wildcard.length === 2, '指定した数(ワイルドカード2)のマスが配置される');
}

// ---- 「クリア」: 自分の手番中いつでも使用開始できる。開始時点で所持数を1消費し、5秒の猶予内に
// 対象(お邪魔マス)を選べれば解除、選べなくても回数は戻らない ----
{
  const initialCells = [[3, 3], [3, 4], [4, 3], [4, 4]];
  const g = WC.newGame({
    size: 8, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    obstacleCells: [[0, 0]], itemsMode: true, itemClearCount: 0, itemBlockCount: 0, itemWildcardCount: 0,
  });
  g.items.p0.clear = 2;
  let start = WC.startClearWindow(g, 'p0');
  assert(start.ok === true, '自分の手番なら「クリア」の使用を開始できる');
  assert(g.items.p0.clear === 1, '開始した時点で所持数が1消費される');
  assert(g.pendingItemUse && g.pendingItemUse.playerId === 'p0' && g.pendingItemUse.item === 'clear',
    '受付状態(pendingItemUse)がセットされる');

  let res = WC.useItem(g, 'p0', 'clear', 0, 0);
  assert(res.ok === true, '猶予内に対象(お邪魔マス)を選べば解除できる');
  assert(g.blocked[0][0] === false, '解除後はそのマスがお邪魔マスでなくなる');
  assert(g.pendingItemUse === null, '使用完了後は受付状態が閉じる');

  // 2回目: 猶予切れの場合
  start = WC.startClearWindow(g, 'p0');
  assert(start.ok === true && g.items.p0.clear === 0, '2回目の開始でも所持数は消費される');
  g.pendingItemUse.expiresAt = Date.now() - 1; // 猶予切れをシミュレート
  res = WC.useItem(g, 'p0', 'clear', 1, 1);
  assert(res.ok === false, '猶予が切れていれば対象を選んでも失敗する');
  assert(g.items.p0.clear === 0, '失敗しても所持数は戻らない(開始時点で消費済み)');
}
{
  // 所持数が無ければ開始できない。自分の手番でなければ開始できない
  const g = WC.newGame({
    size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true, itemClearCount: 0, itemBlockCount: 0, itemWildcardCount: 0,
  });
  assert(WC.startClearWindow(g, 'p0').ok === false, '所持数が無ければ「クリア」を開始できない');
  g.items.p0.clear = 1;
  assert(WC.startClearWindow(g, 'p1').ok === false, '自分の手番でなければ「クリア」を開始できない');
}

// ---- 「ブロック」: 相手ターン開始時に、直前の手番プレーヤーが所持していれば使用確認オファーが
// 開く。使わない場合は所持数を消費せず温存される(次に相手ターンが来た時にまた開く) ----
{
  const initialCells = [[3, 3], [3, 4], [4, 3], [4, 4]];
  const g = WC.newGame({
    size: 8, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true, itemClearCount: 0, itemBlockCount: 0, itemWildcardCount: 0,
  });
  assert(g.pendingBlockOffer === null, 'まだ誰も手番を終えていないのでオファーは無い');
  assert(WC.canUseItemNow(g, 'p0', 'block') === false, 'オファーが無ければ「ブロック」は使えない');

  g.items.p0.block = 1;
  WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0');
  assert(WC.currentPlayer(g) === 'p1', '手番がp1に移っている');
  assert(g.pendingBlockOffer && g.pendingBlockOffer.playerId === 'p0',
    'p0がブロックを持っているので、p1のターン開始時にp0への使用確認オファーが開く');
  assert(WC.canUseItemNow(g, 'p0', 'block') === true, 'オファー中のp0は「ブロック」を使える');
  assert(WC.canUseItemNow(g, 'p1', 'block') === false, 'p1自身はオファーの対象ではない');

  // 使わない(温存): 所持数は減らず、次にまた相手ターンが来た時に再度開く
  WC.declineBlockOffer(g, 'p0');
  assert(g.pendingBlockOffer === null, '断るとオファーは閉じる');
  assert(g.items.p0.block === 1, '断っても所持数は減らない(温存)');

  WC.applyPass(g); // p1がパス、手番はp0に戻る
  assert(WC.currentPlayer(g) === 'p0', '手番がp0に戻っている');
  assert(g.pendingBlockOffer === null, 'p0自身の手番開始時にはオファーは開かない(相手が持っている場合のみ)');

  // p0が単語を置いて手番をp1に渡す(2連続パスにするとゲームが終了してしまうため、実際に手を置く)
  WC.applyMove(g, { r: 3, c: 5, dir: 6, word: 'りご' }, 'p0'); // (3,5)り(p0所有,一致) (4,5)ご(新規)
  assert(g.pendingBlockOffer && g.pendingBlockOffer.playerId === 'p0',
    '温存されていたので、次にp1のターンが来た時に再びp0へのオファーが開く');

  // 使う(応諾): 所持数が減り、オファーは閉じる
  const res = WC.useItem(g, 'p0', 'block', 0, 0);
  assert(res.ok === true, 'オファー中に対象を選んで「ブロック」を使用できる');
  assert(g.blocked[0][0] === true, '指定したマスがお邪魔マスになる');
  assert(g.items.p0.block === 0, '使用すると所持数が減る');
  assert(g.pendingBlockOffer === null, '使用後はオファーが閉じる');
}
{
  // ブロックは初期文字マスの周囲2マス以内には配置できない
  const initialCells = [[3, 3], [3, 4], [4, 3], [4, 4]];
  const g = WC.newGame({
    size: 8, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true, itemClearCount: 0, itemBlockCount: 0, itemWildcardCount: 0,
  });
  g.items.p0.block = 1;
  g.pendingBlockOffer = { playerId: 'p0' };
  const res = WC.useItem(g, 'p0', 'block', 3, 5); // 初期文字マスの周囲2マス以内
  assert(res.ok === false, 'ブロックは初期文字マスの周囲2マス以内には配置できない');
}
{
  // itemsModeが無効なら使用できない
  const g = WC.newGame({ size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30 });
  const res = WC.useItem(g, 'p0', 'clear', 0, 0);
  assert(res.ok === false, 'itemsModeが無効ならアイテムは使用できない');
}

// ---- 「ワイルドカード」: 単語の経路上にある既存の文字を1つ選び、任意の文字に書き換えて確定できる ----
{
  // (3,3)あ (3,4)か (3,5)り(新規) の単語で、2文字目(か, 既存)をワイルドカードで「き」に書き換える
  const initialCells = [[3, 3], [3, 4], [4, 3], [4, 4]];
  const g = WC.newGame({
    size: 8, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true, itemClearCount: 0, itemBlockCount: 0, itemWildcardCount: 0,
  });
  g.items.p0.wildcard = 1;
  const move = { r: 3, c: 3, dir: 4, word: 'あきり', wildcardIndex: 1 };
  const v = WC.validateMove(g, move, null);
  assert(v.ok === true, 'ワイルドカードで既存文字との不一致を許容して検証を通せる');
  const res = WC.applyMove(g, move, 'p0');
  assert(g.board[3][4] === 'き', '盤面のその文字が実際に書き換わる');
  assert(g.owner[3][4] === 'p0', '書き換えたマスの所有権はp0に移る');
  assert(g.items.p0.wildcard === 0, 'ワイルドカード使用後は所持数が減る');
  assert(res.captured.some(([r, c]) => r === 3 && c === 4), 'applyMoveの返り値に書き換えたマスが含まれる(再描画用)');
}
{
  // ワイルドカードの所持数が無ければ使えない
  const g = WC.newGame({
    size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true, itemClearCount: 0, itemBlockCount: 0, itemWildcardCount: 0,
  });
  const move = { r: 3, c: 3, dir: 4, word: 'あきり', wildcardIndex: 1 };
  const v = WC.validateMove(g, move, new Set(['あ', 'い', 'う', 'え', 'お']));
  assert(v.ok === false, 'ワイルドカードの所持数が無ければ使用できない');
}
{
  // ワイルドカードは新規(未入力)マスには使えない
  const g = WC.newGame({
    size: 8, letters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true, itemClearCount: 0, itemBlockCount: 0, itemWildcardCount: 0,
  });
  g.items.p0.wildcard = 1;
  const move = { r: 3, c: 3, dir: 4, word: 'あきり', wildcardIndex: 2 }; // 3文字目(り)は新規マス
  const v = WC.validateMove(g, move, new Set(['あ', 'い', 'う', 'え', 'お']));
  assert(v.ok === false, 'ワイルドカードは既存の文字のマスにのみ使える(新規マスには使えない)');
}
{
  // 陣取りモードでワイルドカードを使うと、相手の文字を書き換えて得点も奪える
  const initialCells = [[3, 3], [3, 4], [4, 3], [4, 4]];
  const g = WC.newGame({
    size: 8, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    itemsMode: true, itemClearCount: 0, itemBlockCount: 0, itemWildcardCount: 0, territoryMode: true,
  });
  g.items.p1.wildcard = 1;
  WC.applyMove(g, { r: 3, c: 3, dir: 4, word: 'あかり' }, 'p0'); // (3,3)あ(3,4)か(3,5)り(新規)。p0が3マスとも所有、+3点
  assert(g.owner[3][4] === 'p0' && g.scores.p0 === 3, '前提: p0が(3,4)を所有し3点獲得している');
  // p1が(3,5)から左方向へ「りきあこ」(wildcardIndex=1で(3,4)の「か」を「き」に書き換え)。
  // 陣取りモードでは経路上の(3,5)(3,4)(3,3)すべてがp0所有からp1所有に奪われる(計3点減)。
  const res = WC.applyMove(g, { r: 3, c: 5, dir: 3, word: 'りきあこ', wildcardIndex: 1 }, 'p1');
  assert(g.board[3][4] === 'き', '陣取りモードでもワイルドカードで文字が書き換わる');
  assert(g.owner[3][4] === 'p1', '書き換えたマスの所有権はp1に移る');
  assert(g.scores.p0 === 0, '奪われたマス(通常のchar一致マス2つ+ワイルドカード1つ)の分だけp0の得点が減る(3-3=0)');
  assert(res.territoryLosses.p0 === 3, 'applyMoveの返り値にも被害者の合計減点数が入る');
}

// ---- お邪魔マス移動: 未入力マスが盤面の半分になるまで、毎ターン1マスだけランダムに再配置される ----
{
  const size = 10;
  const initialCells = [[4, 4], [4, 5], [5, 4], [5, 5]];
  const obstacleCells = [[0, 0], [0, 1]]; // 初期文字マスから十分離れた位置
  const g = WC.newGame({
    size, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    obstacleCells, obstacleMove: true,
  });
  assert(g.obstacleMove === true, 'obstacleMoveフラグがgameに反映される');
  assert(WC.obstacleCellList(g).length === 2, '初期のお邪魔マス数がそのまま反映される');
  assert(WC.OBSTACLE_MOVE_MAX_PER_TURN === 1, '1ターンに移動するお邪魔マスは1マスだけ');
  const moved = WC.relocateObstacles(g);
  assert(moved !== null, '未入力マスが半分より多ければ再配置される');
  assert(moved.length === 1, '1ターンに移動するのは1マスだけ');
  assert(WC.obstacleCellList(g).length === 2, '移動してもお邪魔マスの総数は変わらない');
  const chebyshev = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  assert(moved.every(([r, c]) => initialCells.every((ic) => chebyshev([r, c], ic) > 2)), '再配置後も初期文字マスの周囲2マス以内には配置されない');
}
{
  // お邪魔マスが複数(8個)あっても、1ターンに移動するのは1個だけで、残り7個は必ず元の位置に残る
  const size = 12;
  const initialCells = [[5, 5], [5, 6], [6, 5], [6, 6]];
  const obstacleCells = [[0, 0], [0, 2], [0, 4], [0, 6], [0, 8], [0, 10], [11, 0], [11, 2]]; // 8個
  const g = WC.newGame({
    size, initialCells, initialLetters: ['あ', 'か', 'さ', 'た'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    obstacleCells, obstacleMove: true,
  });
  assert(WC.obstacleCellList(g).length === 8, '初期のお邪魔マス数(8個)がそのまま反映される');
  const oldSet = new Set(obstacleCells.map(([r, c]) => r + ',' + c));
  const moved = WC.relocateObstacles(g);
  assert(moved.length === 1, '8個あっても、1ターンに移動するのは1個だけ');
  assert(WC.obstacleCellList(g).length === 8, '移動後もお邪魔マスの総数(8個)は変わらない');
  const afterSet = new Set(WC.obstacleCellList(g).map(([r, c]) => r + ',' + c));
  let unchangedCount = 0;
  for (const key of oldSet) if (afterSet.has(key)) unchangedCount++;
  // 移動した1個は、たまたま元の位置に戻ることもあり得るため、一致数は7以上になる
  assert(unchangedCount >= 7, '移動しなかった7個(以上)は元の位置のまま残る');
}
{
  // 移動先は、現在の起点マス(game.chain、次の手番が単語を作り始めるマス)の周囲1マスには配置されない
  const size = 10;
  const g = WC.newGame({
    size, initialCells: [[0, 0]], initialLetters: ['あ'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    obstacleCells: [[9, 9]], obstacleMove: true,
  });
  g.chain = { r: 5, c: 5 };
  const chebyshev = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
  let sawMove = false;
  for (let i = 0; i < 50; i++) {
    const moved = WC.relocateObstacles(g);
    if (!moved || moved.length === 0) continue;
    sawMove = true;
    for (const [r, c] of moved) {
      assert(chebyshev([r, c], [5, 5]) > 1, '移動先は現在の起点マス(game.chain)の周囲1マスには配置されない');
    }
  }
  assert(sawMove, '50回試行すれば少なくとも一度は移動が発生する');
}
{
  // obstacleMoveを付けなければ再配置しない
  const g = WC.newGame({
    size: 10, initialCells: [[4, 4]], initialLetters: ['あ'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    obstacleCells: [[0, 0]],
  });
  const moved = WC.relocateObstacles(g);
  assert(moved === null, 'obstacleMoveが無効なら再配置しない');
  assert(g.blocked[0][0] === true, '再配置しない場合、元の位置のままになる');
}
{
  // 未入力マスが盤面(8x8=64マス)の半分(32マス)以下になったら移動を止める
  const size = 8;
  const g = WC.newGame({
    size, initialCells: [[3, 3]], initialLetters: ['あ'], players: ['p0', 'p1'], first: 0, timeLimit: 30,
    obstacleCells: [[0, 0]], obstacleMove: true,
  });
  let filled = 1; // 初期文字マスの分
  outer:
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (filled >= 34) break outer;
      if (g.board[r][c] === null && !g.blocked[r][c]) { g.board[r][c] = 'あ'; filled++; }
    }
  }
  assert(WC.emptyCellCount(g) <= (size * size) / 2, 'テスト設定の確認: 未入力マスが盤面の半分以下になっている');
  const moved = WC.relocateObstacles(g);
  assert(moved === null, '未入力マスが盤面の半分以下になったら再配置しない');
  assert(g.blocked[0][0] === true, '再配置しない場合、元の位置のままになる');
}

console.log(`\n結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
