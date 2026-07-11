/**
 * ワードチェイン ゲームロジック (UI・通信に依存しない純粋ロジック)
 *
 * N人 (2〜4人) 対戦・可変盤面 (8〜15) に対応。
 * プレーヤーは playerId (文字列) で識別し、players 配列が手番の巡回順を表す。
 */
'use strict';

const WordChain = (() => {
  const SIZE_MIN = 8;
  const SIZE_MAX = 15;
  const MAX_PLAYERS = 4;
  // 8方向: ↖ ↑ ↗ ← → ↙ ↓ ↘
  const DIRS = [
    [-1, -1], [-1, 0], [-1, 1],
    [0, -1],           [0, 1],
    [1, -1],  [1, 0],  [1, 1],
  ];
  const DIR_ARROWS = ['↖', '↑', '↗', '←', '→', '↙', '↓', '↘'];
  const MIN_WORD = 2;
  const WORD_RE = new RegExp(`^[ぁ-ゖー]{2,${SIZE_MAX}}$`, 'u');
  const CHAR_RE = /^[ぁ-ゖー]$/u;
  // 入力時間の選択肢 (秒)。0 = 無制限。
  const TIME_CHOICES = [10, 30, 60, 120, 180, 240, 300, 0];
  // お邪魔マスの数の上限は盤面の全マス数の20%まで
  const OBSTACLE_RATIO_MAX = 0.2;
  // お邪魔マスは初期文字セルの周囲このマス数(チェビシェフ距離)以内には配置しない
  const OBSTACLE_AVOID_RADIUS = 2;
  // お邪魔マス移動オプション: 1ターンに再配置されるお邪魔マスの数の上限
  const OBSTACLE_MOVE_MAX_PER_TURN = 1;
  // お邪魔マス移動の移動先は、現在の起点マス(直前の単語の末尾=次の手番が単語を
  // 作り始めるマス)からこのマス数(チェビシェフ距離)以内には配置しない
  const OBSTACLE_MOVE_CHAIN_AVOID_RADIUS = 1;
  // 初期文字の候補: 単語の先頭になりやすい基本のかな
  const START_LETTER_POOL = [...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれわ'];
  // 拗音・促音・小さい母音は、同じ行の直音でも入力できるようにする (例:「ゃ」→「や」)
  const SMALL_KANA_MAP = {
    'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'っ': 'つ',
    'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お',
  };

  function katakanaToHiragana(s) {
    let out = '';
    for (const ch of s) {
      const code = ch.codePointAt(0);
      if (code >= 0x30a1 && code <= 0x30f6) {
        out += String.fromCodePoint(code - 0x60);
      } else {
        out += ch;
      }
    }
    return out;
  }

  function normalizeSmallKana(s) {
    let out = '';
    for (const ch of s) out += SMALL_KANA_MAP[ch] || ch;
    return out;
  }

  // ローマ字入力→ひらがな即時変換 (OSのIME変換候補に頼らず、直接入力モードで使う想定)。
  // 3文字(拗音等)→2文字→1文字の順に最長一致で貪欲に変換する。
  const ROMAJI_3 = {
    kya: 'きゃ', kyu: 'きゅ', kyo: 'きょ',
    sha: 'しゃ', shu: 'しゅ', sho: 'しょ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
    cha: 'ちゃ', chu: 'ちゅ', cho: 'ちょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
    nya: 'にゃ', nyu: 'にゅ', nyo: 'にょ',
    hya: 'ひゃ', hyu: 'ひゅ', hyo: 'ひょ',
    mya: 'みゃ', myu: 'みゅ', myo: 'みょ',
    rya: 'りゃ', ryu: 'りゅ', ryo: 'りょ',
    gya: 'ぎゃ', gyu: 'ぎゅ', gyo: 'ぎょ',
    jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ', zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ',
    bya: 'びゃ', byu: 'びゅ', byo: 'びょ',
    pya: 'ぴゃ', pyu: 'ぴゅ', pyo: 'ぴょ',
    dyi: 'ぢぃ', tsu: 'つ', 'shi': 'し', 'chi': 'ち',
  };
  const ROMAJI_2 = {
    ka: 'か', ki: 'き', ku: 'く', ke: 'け', ko: 'こ',
    sa: 'さ', si: 'し', su: 'す', se: 'せ', so: 'そ',
    ta: 'た', ti: 'ち', tu: 'つ', te: 'て', to: 'と',
    na: 'な', ni: 'に', nu: 'ぬ', ne: 'ね', no: 'の',
    ha: 'は', hi: 'ひ', hu: 'ふ', fu: 'ふ', he: 'へ', ho: 'ほ',
    ma: 'ま', mi: 'み', mu: 'む', me: 'め', mo: 'も',
    ya: 'や', yu: 'ゆ', yo: 'よ',
    ra: 'ら', ri: 'り', ru: 'る', re: 'れ', ro: 'ろ',
    wa: 'わ', wo: 'を', nn: 'ん',
    ga: 'が', gi: 'ぎ', gu: 'ぐ', ge: 'げ', go: 'ご',
    za: 'ざ', zi: 'じ', ji: 'じ', zu: 'ず', ze: 'ぜ', zo: 'ぞ',
    da: 'だ', di: 'ぢ', du: 'づ', de: 'で', do: 'ど',
    ba: 'ば', bi: 'び', bu: 'ぶ', be: 'べ', bo: 'ぼ',
    pa: 'ぱ', pi: 'ぴ', pu: 'ぷ', pe: 'ぺ', po: 'ぽ',
    ja: 'じゃ', ju: 'じゅ', jo: 'じょ',
  };
  const ROMAJI_1 = { a: 'あ', i: 'い', u: 'う', e: 'え', o: 'お' };
  // ヘボン式の「tch」表記 (例: matcha=まっちゃ) 用の特例
  const ROMAJI_4 = { tcha: 'っちゃ', tchi: 'っち', tcho: 'っちょ', tchu: 'っちゅ' };
  const DOUBLE_CONSONANTS = new Set(['b', 'c', 'd', 'f', 'g', 'h', 'j', 'k', 'm', 'p', 'r', 's', 't', 'v', 'w', 'y', 'z']);

  /**
   * ローマ字部分をひらがなに変換する。ひらがな等それ以外の文字はそのまま通す。
   * finalize=true のときは、末尾に確定できず残っている単独の「n」も「ん」にする
   * (入力中は "nn" が確定するまで保留し、決定時に確定させるため)。
   */
  function romajiToHiragana(s, finalize) {
    let out = '';
    let i = 0;
    const n = s.length;
    while (i < n) {
      if (s[i] === '-') { out += 'ー'; i += 1; continue; } // 直接入力の「-」は長音符「ー」として扱う
      const c4 = s.slice(i, i + 4).toLowerCase();
      if (c4.length === 4 && ROMAJI_4[c4]) { out += ROMAJI_4[c4]; i += 4; continue; }
      const c3 = s.slice(i, i + 3).toLowerCase();
      if (c3.length === 3 && ROMAJI_3[c3]) { out += ROMAJI_3[c3]; i += 3; continue; }
      const c2 = s.slice(i, i + 2).toLowerCase();
      if (c2.length === 2 && ROMAJI_2[c2]) { out += ROMAJI_2[c2]; i += 2; continue; }
      const c1 = s[i].toLowerCase();
      if (i + 1 < n && s[i].toLowerCase() === s[i + 1].toLowerCase() && DOUBLE_CONSONANTS.has(c1) && c1 !== 'n') {
        out += 'っ'; i += 1; continue;
      }
      if (c1 === 'n') {
        const next = i + 1 < n ? s[i + 1].toLowerCase() : '';
        if (!next) {
          out += finalize ? 'ん' : s[i];
        } else if ('aiueoy'.includes(next)) {
          out += s[i]; // na/ni/nu/ne/no/nya等はROMAJI_2/3側で処理されるはずだが、念のため保留
        } else {
          out += 'ん';
        }
        i += 1; continue;
      }
      if (ROMAJI_1[c1]) { out += ROMAJI_1[c1]; i += 1; continue; }
      out += s[i]; i += 1;
    }
    return out;
  }

  function randomInt(max) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % max;
  }

  function randomLetters(n = 4) {
    const pool = [...START_LETTER_POOL];
    const picked = [];
    const count = Math.max(1, Math.min(n, pool.length));
    for (let i = 0; i < count; i++) {
      picked.push(pool.splice(randomInt(pool.length), 1)[0]);
    }
    return picked;
  }

  function clampSize(n) {
    n = Math.round(Number(n));
    if (!Number.isFinite(n)) return SIZE_MIN;
    return Math.max(SIZE_MIN, Math.min(SIZE_MAX, n));
  }

  /** 盤面サイズから中央2×2ブロックの4セルを返す */
  function centerCells(size) {
    const c0 = Math.floor((size - 2) / 2);
    return [[c0, c0], [c0, c0 + 1], [c0 + 1, c0], [c0 + 1, c0 + 1]];
  }

  /** avoid に含まれないセルから count 個をランダムに (重複なく) 選ぶ */
  function randomDistinctCells(size, count, avoid) {
    const avoidSet = new Set((avoid || []).map(([r, c]) => r * 100 + c));
    const all = [];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!avoidSet.has(r * 100 + c)) all.push([r, c]);
      }
    }
    for (let i = all.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, Math.max(0, Math.min(count, all.length)));
  }

  // 真ん中(北)から時計回りの8方向。奇数盤面のデフォルト配置で使う。
  const CLOCKWISE_DIRS = [
    [-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1],
  ];

  /** 奇数盤面の真の中央セルから時計回りにcount個のセルを返す (中央含む) */
  function centerClockwiseCells(size, count) {
    const c0 = (size - 1) / 2;
    const cells = [[c0, c0]];
    for (let i = 0; i < CLOCKWISE_DIRS.length && cells.length < count; i++) {
      const [dr, dc] = CLOCKWISE_DIRS[i];
      cells.push([c0 + dr, c0 + dc]);
    }
    return cells.slice(0, count);
  }

  /**
   * 初期文字を置くセルを決める。
   * mode: 'default' (中央固定) | 'random' (盤面内ランダム)
   * count: default時は1か4、random時は1〜10 (呼び出し側で制限済み前提)
   * 奇数盤面かつdefaultのときは、真の中央セルから時計回りに配置する。
   */
  function generateInitialCells(size, mode, count) {
    const n = Math.max(1, Math.round(count) || 1);
    if (mode === 'random') {
      return randomDistinctCells(size, Math.min(n, size * size));
    }
    if (size % 2 === 1) {
      return centerClockwiseCells(size, Math.min(n, 1 + CLOCKWISE_DIRS.length));
    }
    const center = centerCells(size);
    return center.slice(0, Math.min(n, center.length));
  }

  /** 盤面サイズから、お邪魔マス数の上限 (全マス数の20%) を返す。既存呼び出し元と合わせて維持 */
  function maxObstacleCount(size) {
    return Math.max(1, Math.floor(size * size * OBSTACLE_RATIO_MAX));
  }

  /** cells の各セルを中心とした周囲 radius マス (チェビシェフ距離) を含めて返す (盤外は除く) */
  function expandAvoidRadius(size, cells, radius) {
    const set = new Set();
    const out = [];
    for (const [cr, cc] of cells) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          const r = cr + dr, c = cc + dc;
          if (r < 0 || r >= size || c < 0 || c >= size) continue;
          const key = r * 100 + c;
          if (!set.has(key)) { set.add(key); out.push([r, c]); }
        }
      }
    }
    return out;
  }

  /** お邪魔マス(進入不可セル)を、初期文字セルとその周囲2マスを避けてランダムに生成。count: 1〜全マス数の20% */
  function generateObstacleCells(size, initialCells, count) {
    const cap = maxObstacleCount(size);
    const n = Math.max(1, Math.min(cap, Math.round(count) || 1));
    const avoid = expandAvoidRadius(size, initialCells, OBSTACLE_AVOID_RADIUS);
    return randomDistinctCells(size, n, avoid);
  }

  /**
   * 新規ゲーム。
   * opts = { size, players, first, timeLimit, initialCells, initialLetters, obstacleCells, territoryMode, bonusMode, obstacleMove, itemsMode }
   *   players: playerId の配列 (手番順)。例 ['p0','p1']
   *   first:   最初に打つプレーヤーの players 内インデックス (0..n-1)
   *   initialCells/initialLetters: 省略時は中央2×2 (letters は後方互換の別名)
   *   obstacleCells: 省略時はお邪魔マスなし
   *   territoryMode: true で陣取りモード (他人のマスを通ると相手の得点を1点減らす)。省略時は通常モード。
   *   bonusMode: true でボーナスマス(逆転support)オプション有効。相手(リーダー)との得点差が
   *              10点以上あるプレーヤーの手番のときだけ、差が大きいほど高確率でボーナスマスが
   *              出現する。10〜19点差では+1〜+5点の加点マスのみ、20〜29点差ではそれに加えて
   *              ×2倍マスも、30点差以上ではさらに×2〜×3倍マス(倍率もランダム)が出現候補に
   *              加わる(点差が大きいほど出現候補が累積的に増える)。ゲーム開始から5ターン目
   *              までは出現しない。加点マスと倍率マスは別々に(同じマスに重複しないよう)
   *              独立して抽選される。ボーナスマスはプレーヤーからは見えない(盤面上に表示
   *              されない)。呼び出し側が毎ターン pickBonusCells() を呼んで
   *              game.bonusFlatCell/bonusFlatValue/bonusMultCell/bonusMultValueに設定する
   *              想定。省略時は無効。
   *   obstacleMove: true でお邪魔マス移動オプション有効 (盤面の未入力マスが全マス数の半分に
   *              なるまで、呼び出し側が毎ターン relocateObstacles() を呼ぶとお邪魔マスのうち
   *              1マスだけがランダムに再配置される想定。移動先は現在の起点マス(game.chain)
   *              の周囲1マスには配置されない。省略時は無効)。
   *   itemsMode: true でアイテムオプション有効。各プレーヤーが試合中、設定された回数だけ
   *              「クリア」(お邪魔マスを1つ解除)と「ブロック」(未入力マスに新しくお邪魔マス
   *              を配置)をuseItem()経由で使えるようになる。回数は itemClearCount/
   *              itemBlockCount で指定 (省略時はそれぞれ1回)。省略時(itemsMode:false)は無効。
   */
  function newGame(opts) {
    const size = clampSize(opts.size);
    const players = opts.players.slice();
    const board = Array.from({ length: size }, () => Array(size).fill(null));
    const owner = Array.from({ length: size }, () => Array(size).fill(null));
    const blocked = Array.from({ length: size }, () => Array(size).fill(false));
    const initialCells = opts.initialCells || centerCells(size);
    const initialLetters = opts.initialLetters || opts.letters;
    initialCells.forEach(([r, c], i) => { board[r][c] = initialLetters[i]; });
    const obstacleCells = opts.obstacleCells || [];
    for (const [r, c] of obstacleCells) blocked[r][c] = true;
    const scores = {};
    const active = {};
    for (const p of players) { scores[p] = 0; active[p] = true; }
    const itemsMode = !!opts.itemsMode;
    const items = {};
    if (itemsMode) {
      const clearCount = Math.max(0, Number.isInteger(opts.itemClearCount) ? opts.itemClearCount : 1);
      const blockCount = Math.max(0, Number.isInteger(opts.itemBlockCount) ? opts.itemBlockCount : 1);
      for (const p of players) items[p] = { clear: clearCount, block: blockCount };
    }
    return {
      size,
      board,
      owner,        // playerId | null (初期文字は null)
      blocked,      // お邪魔マス (true = 進入不可)
      initialCells,
      territoryMode: !!opts.territoryMode,
      bonusMode: !!opts.bonusMode,
      bonusFlatCell: null,   // [r, c] | null。呼び出し側がpickBonusCells()で毎ターン更新する加点マス
      bonusFlatValue: null,  // 1〜5(加点) / null
      bonusMultCell: null,   // [r, c] | null。加点マスとは別マス(重複しない)の倍率マス
      bonusMultValue: null,  // 2〜3(倍率) / null
      obstacleMove: !!opts.obstacleMove,
      itemsMode,
      items,         // playerId -> { clear: 残り回数, block: 残り回数 }。itemsMode無効なら空
      itemGraceId: null, // 直前に手番を終えたプレーヤーのid。「ブロック」はこのプレーヤーも、
                         // 次のプレーヤーが手を確定する(=このidが上書きされる)まで使用できる
      scores,
      players,      // 手番の巡回順
      active,       // playerId -> bool
      turnIdx: opts.first % players.length,
      chain: null,  // 直前の単語の末尾セル {r, c}。null なら初手
      usedWords: new Set(),
      history: [],  // {word, by} / {pass:true, by}
      passStreak: 0,
      over: false,
      timeLimit: opts.timeLimit,
    };
  }

  function currentPlayer(game) {
    return game.players[game.turnIdx];
  }

  function activeCount(game) {
    let n = 0;
    for (const p of game.players) if (game.active[p]) n++;
    return n;
  }

  function inBounds(game, r, c) {
    return r >= 0 && r < game.size && c >= 0 && c < game.size;
  }

  /** start セルから dir 方向に盤面内に収まる最大文字数 (start 含む)。お邪魔マスの手前で止まる */
  function maxLen(game, r, c, dir) {
    const [dr, dc] = DIRS[dir];
    let len = 0;
    let cr = r, cc = c;
    while (inBounds(game, cr, cc) && len < game.size) {
      if (game.blocked[cr][cc]) break;
      len++;
      cr += dr;
      cc += dc;
    }
    return len;
  }

  function rayCells(r, c, dir, len) {
    const [dr, dc] = DIRS[dir];
    const cells = [];
    for (let i = 0; i < len; i++) {
      cells.push([r + dr * i, c + dc * i]);
    }
    return cells;
  }

  /** その手番で単語の開始位置にできるセル一覧 */
  function startCells(game) {
    if (game.chain) return [[game.chain.r, game.chain.c]];
    return game.initialCells;
  }

  /** 盤面上の未入力(null)マスの数 */
  function emptyCellCount(game) {
    let n = 0;
    for (let r = 0; r < game.size; r++) {
      for (let c = 0; c < game.size; c++) if (game.board[r][c] === null) n++;
    }
    return n;
  }

  // ボーナスマス(逆転support): リーダーとの得点差がこのマス数(全マス数を4等分した値)に
  // 達すると、出現確率が上限(BONUS_PROB_CAP)に達する。差が無ければ確率0。
  const BONUS_PROB_CAP = 0.75;
  const BONUS_PROB_GAP_DIVISOR = 4;
  // ボーナスマスが有効になる最低の得点差(これ未満は確率0で出現しない)
  const BONUS_MIN_GAP = 10;
  // この得点差以上で×2倍マスが、さらに大きい得点差以上で×2〜3倍マスが出現候補に加わる
  const BONUS_TIER2_GAP = 20;
  const BONUS_TIER3_GAP = 30;
  // ゲーム開始からこのターン数(手番の総数、パス含む)に達するまではボーナスマスを出現させない
  const BONUS_GRACE_TURNS = 5;

  /**
   * 現在の手番プレーヤーが、リーダーとの得点差の観点でボーナスマスの対象になるかどうか。
   * 得点が最下位(同点含む)でなければ非対象。
   * @returns {{eligible:boolean, gap:number}}
   */
  function bonusGapInfo(game) {
    const cur = currentPlayer(game);
    const scores = game.players.map((p) => game.scores[p]);
    const leaderScore = Math.max(...scores);
    const lowestScore = Math.min(...scores);
    if (game.scores[cur] !== lowestScore) return { eligible: false, gap: 0 };
    return { eligible: true, gap: leaderScore - lowestScore };
  }

  /**
   * 現在の手番プレーヤーに、この手番でボーナスマスが出現する確率 (0〜BONUS_PROB_CAP)。
   * 得点が最下位(同点含む)でない、得点差がBONUS_MIN_GAP未満、まだBONUS_GRACE_TURNSに
   * 達していない場合は0。それ以外は、得点差が大きいほど確率が上がる。
   */
  function bonusAppearProbability(game) {
    if (!game.bonusMode) return 0;
    if (game.history.length < BONUS_GRACE_TURNS) return 0;
    const { eligible, gap } = bonusGapInfo(game);
    if (!eligible || gap < BONUS_MIN_GAP) return 0;
    const scale = (game.size * game.size) / BONUS_PROB_GAP_DIVISOR;
    return Math.min(BONUS_PROB_CAP, gap / scale);
  }

  /**
   * 現在の開始セル(startCells)から8方向に伸ばして到達できる、未入力(null)のセル一覧。
   * お邪魔マスの手前で止まる(maxLenと同じ制約)。ボーナスマスの候補計算に使う。
   */
  function reachableEmptyCells(game) {
    const seen = new Set();
    const out = [];
    for (const [r, c] of startCells(game)) {
      for (let d = 0; d < 8; d++) {
        const L = maxLen(game, r, c, d);
        const ray = rayCells(r, c, d, L);
        for (let i = 1; i < ray.length; i++) {
          const [cr, cc] = ray[i];
          if (game.board[cr][cc] !== null) continue;
          const key = cr * 100 + cc;
          if (!seen.has(key)) { seen.add(key); out.push([cr, cc]); }
        }
      }
    }
    return out;
  }

  /**
   * この手番のボーナスマスを抽選する (権威側が毎ターン開始時に呼び、結果を
   * game.bonusFlatCell/bonusFlatValue/bonusMultCell/bonusMultValueへ代入する想定)。
   * 加点マス(flat)と倍率マス(multiplier)は独立して抽選され、同じマスに重複しない。
   * bonusModeが無効、最下位でない、得点差が足りない場合は両方null。
   * 倍率マスは得点差がBONUS_TIER2_GAP未満なら常にnull(候補にならない)。
   * @returns {{flat: {cell:[number,number], value:number}|null, multiplier: {cell:[number,number], value:number}|null}}
   */
  function pickBonusCells(game) {
    const prob = bonusAppearProbability(game);
    if (prob <= 0) return { flat: null, multiplier: null };
    const { gap } = bonusGapInfo(game);
    let candidates = reachableEmptyCells(game);
    let flat = null;
    if (candidates.length > 0 && randomInt(1000) < Math.round(prob * 1000)) {
      const cell = candidates[randomInt(candidates.length)];
      flat = { cell, value: 1 + randomInt(5) };
      candidates = candidates.filter(([r, c]) => !(r === cell[0] && c === cell[1]));
    }
    let multiplier = null;
    if (gap >= BONUS_TIER2_GAP && candidates.length > 0 && randomInt(1000) < Math.round(prob * 1000)) {
      const cell = candidates[randomInt(candidates.length)];
      const value = gap >= BONUS_TIER3_GAP ? (randomInt(2) === 0 ? 2 : 3) : 2;
      multiplier = { cell, value };
    }
    return { flat, multiplier };
  }

  /**
   * お邪魔マスをランダムに再配置する (権威側が毎ターン開始時に呼ぶ想定。game.blockedを直接書き換える)。
   * obstacleMoveが無効、お邪魔マスが無い、または未入力マスが全マス数の半分以下になった場合は何もしない。
   * 1ターンに移動するお邪魔マスは OBSTACLE_MOVE_MAX_PER_TURN(1)マスだけ (残りは元の位置のまま)。
   * 移動先は、現在の起点マス(game.chain、次の手番が単語を作り始めるマス)の周囲
   * OBSTACLE_MOVE_CHAIN_AVOID_RADIUS(1)マスには配置しない。
   * @returns 今回新しく移動した先のセル一覧、または再配置しなかった場合はnull
   */
  function relocateObstacles(game) {
    if (!game.obstacleMove) return null;
    const oldCells = [];
    for (let r = 0; r < game.size; r++) {
      for (let c = 0; c < game.size; c++) if (game.blocked[r][c]) oldCells.push([r, c]);
    }
    if (oldCells.length === 0) return null;
    if (emptyCellCount(game) <= (game.size * game.size) / 2) return null;
    for (let i = oldCells.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [oldCells[i], oldCells[j]] = [oldCells[j], oldCells[i]];
    }
    const movingCells = oldCells.slice(0, Math.min(OBSTACLE_MOVE_MAX_PER_TURN, oldCells.length));
    for (const [r, c] of movingCells) game.blocked[r][c] = false;
    const avoid = expandAvoidRadius(game.size, game.initialCells, OBSTACLE_AVOID_RADIUS);
    const avoidChain = game.chain
      ? expandAvoidRadius(game.size, [[game.chain.r, game.chain.c]], OBSTACLE_MOVE_CHAIN_AVOID_RADIUS)
      : [];
    const avoidSet = new Set([...avoid, ...avoidChain].map(([r, c]) => r * 100 + c));
    const pool = [];
    for (let r = 0; r < game.size; r++) {
      for (let c = 0; c < game.size; c++) {
        if (game.board[r][c] === null && !game.blocked[r][c] && !avoidSet.has(r * 100 + c)) pool.push([r, c]);
      }
    }
    for (let i = pool.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const newCells = pool.slice(0, movingCells.length);
    for (const [r, c] of newCells) game.blocked[r][c] = true;
    // 空きマスが足りず移動先が確保できなかった分は、元の位置に戻す(お邪魔マスの総数を維持する)
    for (let i = newCells.length; i < movingCells.length; i++) {
      const [r, c] = movingCells[i];
      game.blocked[r][c] = true;
    }
    return newCells;
  }

  /** 現在お邪魔マスになっているセル一覧 (盤面全体を走査)。ネットワーク送信用 */
  function obstacleCellList(game) {
    const out = [];
    for (let r = 0; r < game.size; r++) {
      for (let c = 0; c < game.size; c++) if (game.blocked[r][c]) out.push([r, c]);
    }
    return out;
  }

  /** 「ブロック」アイテムで配置可能な未入力マス一覧 (初期文字マス周囲2マスを除く)。UIのハイライト用 */
  function blockableCells(game) {
    const avoid = expandAvoidRadius(game.size, game.initialCells, OBSTACLE_AVOID_RADIUS);
    const avoidSet = new Set(avoid.map(([r, c]) => r * 100 + c));
    const out = [];
    for (let r = 0; r < game.size; r++) {
      for (let c = 0; c < game.size; c++) {
        if (game.board[r][c] === null && !game.blocked[r][c] && !avoidSet.has(r * 100 + c)) out.push([r, c]);
      }
    }
    return out;
  }

  /** このプレーヤーが今このアイテムを使用してよいか。自分の手番なら常にOK。
   * 「ブロック」だけは、直前に手番を終えたプレーヤー(game.itemGraceId)にも、次のプレーヤーが
   * 手を確定する(=itemGraceIdが上書きされる)まで使用を認める。 */
  function canUseItemNow(game, playerId, item) {
    if (currentPlayer(game) === playerId) return true;
    return item === 'block' && game.itemGraceId === playerId;
  }

  /**
   * アイテムを使用する (試合中、設定された回数まで。手番は消費しない)。
   * item: 'clear' (指定したお邪魔マスを1つ解除) | 'block' (指定した未入力マスに新しくお邪魔マスを配置)
   * 「ブロック」は自分の手番中に加え、次のプレーヤーがまだ手を確定していない間も使用できる
   * (canUseItemNow参照)。
   * @returns {{ok:true} | {ok:false, reason}}
   */
  function useItem(game, playerId, item, r, c) {
    if (!game.itemsMode) return { ok: false, reason: 'アイテムは無効です' };
    if (!inBounds(game, r, c)) return { ok: false, reason: '座標が不正です' };
    const inv = game.items[playerId];
    if (!inv || (item !== 'clear' && item !== 'block')) return { ok: false, reason: '不明なアイテムです' };
    if (!canUseItemNow(game, playerId, item)) return { ok: false, reason: '今はこのアイテムを使用できません' };
    if (inv[item] <= 0) return { ok: false, reason: 'このアイテムの残り回数がありません' };
    if (item === 'clear') {
      if (!game.blocked[r][c]) return { ok: false, reason: 'そのマスはお邪魔マスではありません' };
      game.blocked[r][c] = false;
    } else {
      if (game.board[r][c] !== null) return { ok: false, reason: 'そのマスには既に文字があります' };
      if (game.blocked[r][c]) return { ok: false, reason: 'そのマスは既にお邪魔マスです' };
      const avoid = expandAvoidRadius(game.size, game.initialCells, OBSTACLE_AVOID_RADIUS);
      if (avoid.some(([ar, ac]) => ar === r && ac === c)) {
        return { ok: false, reason: '初期文字マスの周囲2マスには配置できません' };
      }
      game.blocked[r][c] = true;
    }
    inv[item] -= 1;
    return { ok: true };
  }

  /** 指定セル・方向に単語を置ける余地があるか (最低2文字+新規1マス以上) */
  function canPlaceDir(game, r, c, dir) {
    const L = maxLen(game, r, c, dir);
    if (L < MIN_WORD) return false;
    const cells = rayCells(r, c, dir, L);
    for (let i = 1; i < L; i++) {
      const [cr, cc] = cells[i];
      if (game.board[cr][cc] === null) return true;
    }
    return false;
  }

  /** 現在の手番プレーヤーが何かしら置ける余地があるか (辞書は考慮しない) */
  function hasAnyPlacement(game) {
    for (const [r, c] of startCells(game)) {
      for (let d = 0; d < 8; d++) {
        if (canPlaceDir(game, r, c, d)) return true;
      }
    }
    return false;
  }

  /**
   * 手の検証 (盤面ルールのみ。辞書照合は呼び出し側)。
   * @returns {{ok:true, cells, newCount} | {ok:false, reason}}
   */
  function validateMove(game, move, startChars) {
    if (game.over) return { ok: false, reason: 'ゲームは終了しています' };
    const { r, c, dir, word } = move;
    if (!Number.isInteger(r) || !Number.isInteger(c) || !inBounds(game, r, c)) {
      return { ok: false, reason: '開始位置が不正です' };
    }
    if (!startCells(game).some(([sr, sc]) => sr === r && sc === c)) {
      return { ok: false, reason: 'その位置からは開始できません' };
    }
    if (!Number.isInteger(dir) || dir < 0 || dir > 7) {
      return { ok: false, reason: '方向が不正です' };
    }
    if (typeof word !== 'string' || !WORD_RE.test(word)) {
      return { ok: false, reason: `ひらがな2〜${SIZE_MAX}文字で入力してください` };
    }
    const chars = [...word];
    const L = maxLen(game, r, c, dir);
    if (chars.length > L) {
      const [dr, dc] = DIRS[dir];
      const nr = r + dr * L, nc = c + dc * L;
      if (inBounds(game, nr, nc) && game.blocked[nr][nc]) {
        return { ok: false, reason: 'その先は「お邪魔マス」で塞がれています' };
      }
      return { ok: false, reason: '単語が盤面からはみ出します' };
    }
    if (normalizeSmallKana(chars[0]) !== normalizeSmallKana(game.board[r][c])) {
      return { ok: false, reason: `「${game.board[r][c]}」から始まる単語を入力してください` };
    }
    const cells = rayCells(r, c, dir, chars.length);
    let newCount = 0;
    for (let i = 0; i < chars.length; i++) {
      const [cr, cc] = cells[i];
      const existing = game.board[cr][cc];
      if (existing === null) {
        newCount++;
      } else if (normalizeSmallKana(existing) !== normalizeSmallKana(chars[i])) {
        return { ok: false, reason: `${i + 1}文字目は「${existing}」である必要があります` };
      }
    }
    if (newCount < 1) {
      return { ok: false, reason: '新しい文字を1つ以上置く必要があります' };
    }
    const last = chars[chars.length - 1];
    if (last === 'ん') {
      return { ok: false, reason: '「ん」で終わる単語は使えません' };
    }
    // 「っ」「ゃ」等の小さい文字で終わる場合、次の単語につなげる際は対応する
    // 直音(「つ」「や」等)として扱う (次の人はその直音から始める単語を作れる)。
    if (startChars && !startChars.has(normalizeSmallKana(last))) {
      return { ok: false, reason: `「${last}」で終わると次の単語が作れないため使えません` };
    }
    if (game.usedWords.has(word)) {
      return { ok: false, reason: 'この単語はすでに使われています' };
    }
    return { ok: true, cells, newCount };
  }

  function advanceTurn(game) {
    const n = game.players.length;
    for (let step = 1; step <= n; step++) {
      const idx = (game.turnIdx + step) % n;
      if (game.active[game.players[idx]]) {
        game.turnIdx = idx;
        return;
      }
    }
  }

  /** 検証済みの手を適用する。置いたセル一覧を返す */
  function applyMove(game, move, by) {
    const chars = [...move.word];
    const cells = rayCells(move.r, move.c, move.dir, chars.length);
    const placed = [];
    for (let i = 0; i < chars.length; i++) {
      const [cr, cc] = cells[i];
      if (game.board[cr][cc] === null) {
        game.board[cr][cc] = chars[i];
        game.owner[cr][cc] = by;
        placed.push([cr, cc]);
      } else if (game.territoryMode) {
        // 陣取りモード: 他プレーヤーが既に置いたマスを通ると、そのマスを奪う
        // (元の所有者の得点から1点差し引く。自分自身のマスなら変化なし)
        const prevOwner = game.owner[cr][cc];
        if (prevOwner && prevOwner !== by) {
          game.scores[prevOwner] -= 1;
        }
        game.owner[cr][cc] = by;
      }
    }
    // ボーナスマス: 加点マスと倍率マスは別々に判定し、両方を通った場合は加点を
    // 適用した後に倍率をかける(例: 3文字+加点2→倍率2で (3+2)*2=10点)
    const flatHit = game.bonusMode && game.bonusFlatCell
      && cells.some(([cr, cc]) => cr === game.bonusFlatCell[0] && cc === game.bonusFlatCell[1]);
    const multHit = game.bonusMode && game.bonusMultCell
      && cells.some(([cr, cc]) => cr === game.bonusMultCell[0] && cc === game.bonusMultCell[1]);
    let points = chars.length;
    const flatValue = flatHit ? (game.bonusFlatValue || 1) : null;
    const multValue = multHit ? (game.bonusMultValue || 2) : null;
    if (flatValue) points += flatValue;
    if (multValue) points *= multValue;
    game.scores[by] += points;
    game.usedWords.add(move.word);
    game.history.push({ word: move.word, by, points });
    const [lr, lc] = cells[cells.length - 1];
    game.chain = { r: lr, c: lc };
    game.passStreak = 0;
    game.itemGraceId = by; // 「ブロック」は次のプレーヤーが手を確定するまでこのプレーヤーも使える
    advanceTurn(game);
    return { placed, flatValue, multValue };
  }

  function applyPass(game) {
    const by = currentPlayer(game);
    game.history.push({ pass: true, by });
    game.passStreak++;
    game.itemGraceId = by; // 「ブロック」は次のプレーヤーが手を確定するまでこのプレーヤーも使える
    if (game.passStreak >= activeCount(game) || activeCount(game) < 2) {
      game.over = true;
      return;
    }
    advanceTurn(game);
  }

  /** プレーヤーを手番巡回から外す (途中退出=継続時)。手番なら次へ送る */
  function removePlayer(game, pid) {
    if (!game.active[pid]) return;
    const wasTurn = currentPlayer(game) === pid;
    game.active[pid] = false;
    if (activeCount(game) < 2) {
      game.over = true;
      return;
    }
    if (wasTurn) advanceTurn(game);
    if (game.passStreak >= activeCount(game)) game.over = true;
  }

  /** 勝者(playerId配列。同点は複数)を返す */
  function winners(game) {
    let best = -Infinity;
    for (const p of game.players) best = Math.max(best, game.scores[p]);
    return game.players.filter((p) => game.scores[p] === best);
  }

  return {
    SIZE_MIN, SIZE_MAX, MAX_PLAYERS, DIRS, DIR_ARROWS, MIN_WORD, WORD_RE, CHAR_RE,
    TIME_CHOICES, katakanaToHiragana, romajiToHiragana, normalizeSmallKana, randomLetters, clampSize, centerCells,
    generateInitialCells, generateObstacleCells, maxObstacleCount, centerClockwiseCells,
    newGame, currentPlayer, activeCount, inBounds, maxLen, rayCells, startCells,
    canPlaceDir, hasAnyPlacement, validateMove, applyMove, applyPass, removePlayer,
    winners, emptyCellCount, bonusAppearProbability, reachableEmptyCells, pickBonusCells,
    relocateObstacles, obstacleCellList, OBSTACLE_MOVE_MAX_PER_TURN, useItem, blockableCells,
    canUseItemNow,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WordChain;
}
