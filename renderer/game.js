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
  const TIME_CHOICES = [10, 30, 60, 180, 300, 0];
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

  /**
   * 初期文字を置くセルを決める。
   * mode: 'default' (中央固定) | 'random' (盤面内ランダム)
   * count: default時は1か4、random時は1〜10 (呼び出し側で制限済み前提)
   */
  function generateInitialCells(size, mode, count) {
    const n = Math.max(1, Math.round(count) || 1);
    if (mode === 'random') {
      return randomDistinctCells(size, Math.min(n, size * size));
    }
    const center = centerCells(size);
    return center.slice(0, Math.min(n, center.length));
  }

  /** お邪魔マス(進入不可セル)を、初期文字セルを避けてランダムに生成。count: 1〜10 */
  function generateObstacleCells(size, initialCells, count) {
    const n = Math.max(1, Math.min(10, Math.round(count) || 1));
    return randomDistinctCells(size, n, initialCells);
  }

  /**
   * 新規ゲーム。
   * opts = { size, players, first, timeLimit, initialCells, initialLetters, obstacleCells }
   *   players: playerId の配列 (手番順)。例 ['p0','p1']
   *   first:   最初に打つプレーヤーの players 内インデックス (0..n-1)
   *   initialCells/initialLetters: 省略時は中央2×2 (letters は後方互換の別名)
   *   obstacleCells: 省略時はお邪魔マスなし
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
    return {
      size,
      board,
      owner,        // playerId | null (初期文字は null)
      blocked,      // お邪魔マス (true = 進入不可)
      initialCells,
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
      }
    }
    game.scores[by] += chars.length;
    game.usedWords.add(move.word);
    game.history.push({ word: move.word, by });
    const [lr, lc] = cells[cells.length - 1];
    game.chain = { r: lr, c: lc };
    game.passStreak = 0;
    advanceTurn(game);
    return placed;
  }

  function applyPass(game) {
    const by = currentPlayer(game);
    game.history.push({ pass: true, by });
    game.passStreak++;
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
    generateInitialCells, generateObstacleCells,
    newGame, currentPlayer, activeCount, inBounds, maxLen, rayCells, startCells,
    canPlaceDir, hasAnyPlacement, validateMove, applyMove, applyPass, removePlayer,
    winners,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WordChain;
}
