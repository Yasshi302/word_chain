/**
 * オフライン対戦用CPU。辞書に実在する単語だけを使って手を決める
 * (未登録語の承認フローはCPU相手には存在しないため)。
 *
 * 強さ4段階:
 *   weak      通常2〜5マス。10%で6マス、1%で7マスを選ぶ。
 *   normal    通常3〜5マス。20%で6〜8マス、1%で最大文字数を選ぶ。
 *   strong    通常5〜7マス。10%で最大文字数を選ぶ。
 *   strongest 常に最大文字数を選ぶ。同じ長さの候補が複数あれば、
 *             相手が続けにくい文字(辞書でその文字から始まる単語が少ない)で
 *             終わる単語を優先する。
 */
'use strict';

const CPU = (() => {
  const LEVELS = ['weak', 'normal', 'strong', 'strongest'];
  const LEVEL_LABEL = { weak: '弱い', normal: '普通', strong: '強い', strongest: '最強' };

  function randomInt(max) {
    return Math.floor(Math.random() * max);
  }
  function pickRandom(arr) {
    return arr[randomInt(arr.length)];
  }

  /** 辞書(Set<string>の配列)から、先頭文字×文字数でグルーピングした索引を作る */
  function buildWordIndex(wordSets) {
    const idx = new Map(); // first char -> (length -> word[])
    for (const set of wordSets) {
      for (const w of set) {
        const chars = [...w];
        const first = chars[0];
        const len = chars.length;
        if (!idx.has(first)) idx.set(first, new Map());
        const byLen = idx.get(first);
        if (!byLen.has(len)) byLen.set(len, []);
        byLen.get(len).push(w);
      }
    }
    return idx;
  }

  /** 各かなを先頭文字に持つ辞書語数 (「その文字で終わると次が続けやすいか」の目安) */
  function buildStartCharCounts(wordSets) {
    const counts = new Map();
    for (const set of wordSets) {
      for (const w of set) {
        const first = [...w][0];
        counts.set(first, (counts.get(first) || 0) + 1);
      }
    }
    return counts;
  }

  /** 現在の手番で置ける、辞書に実在する単語の手を全列挙する */
  function enumerateMoves(game, wordIndex, startChars) {
    const moves = [];
    for (const [r, c] of WordChain.startCells(game)) {
      const first = game.board[r][c];
      const byLen = wordIndex.get(first);
      if (!byLen) continue;
      for (let dir = 0; dir < 8; dir++) {
        const L = WordChain.maxLen(game, r, c, dir);
        if (L < WordChain.MIN_WORD) continue;
        const cells = WordChain.rayCells(r, c, dir, L);
        for (let len = 2; len <= L; len++) {
          const candidates = byLen.get(len);
          if (!candidates || !candidates.length) continue;
          for (const w of candidates) {
            if (game.usedWords.has(w)) continue;
            const chars = [...w];
            let ok = true;
            let newCount = 0;
            for (let i = 0; i < len; i++) {
              const [cr, cc] = cells[i];
              const existing = game.board[cr][cc];
              if (existing === null) newCount++;
              else if (WordChain.normalizeSmallKana(existing) !== WordChain.normalizeSmallKana(chars[i])) { ok = false; break; }
            }
            if (!ok || newCount < 1) continue;
            const last = chars[len - 1];
            if (last === 'ん') continue;
            if (startChars && !startChars.has(last)) continue;
            moves.push({ r, c, dir, word: w, len });
          }
        }
      }
    }
    return moves;
  }

  function inRange(moves, lo, hi) {
    return moves.filter((m) => m.len >= lo && m.len <= hi);
  }

  /** 同じ長さの候補の中から、終わりの文字で相手の続けやすさが最も低いものを選ぶ */
  function pickHardestToFollow(moves, startCharCounts) {
    let bestScore = Infinity;
    let ties = [];
    for (const m of moves) {
      const last = [...m.word][m.len - 1];
      const score = startCharCounts.get(last) || 0;
      if (score < bestScore) { bestScore = score; ties = [m]; }
      else if (score === bestScore) ties.push(m);
    }
    return pickRandom(ties);
  }

  /**
   * 手を決める。置ける辞書語が無ければ null (パス)。
   * level: 'weak' | 'normal' | 'strong' | 'strongest'
   */
  function chooseMove(game, wordIndex, startChars, level, startCharCounts) {
    const moves = enumerateMoves(game, wordIndex, startChars);
    if (moves.length === 0) return null;
    let maxLenAvail = 0;
    for (const m of moves) if (m.len > maxLenAvail) maxLenAvail = m.len;
    const maxMoves = moves.filter((m) => m.len === maxLenAvail);
    const roll = Math.random();

    switch (level) {
      case 'weak': {
        if (roll < 0.01) { const l7 = inRange(moves, 7, 7); if (l7.length) return pickRandom(l7); }
        else if (roll < 0.11) { const l6 = inRange(moves, 6, 6); if (l6.length) return pickRandom(l6); }
        const def = inRange(moves, 2, 5);
        return pickRandom(def.length ? def : moves);
      }
      case 'normal': {
        if (roll < 0.01) return pickHardestToFollow(maxMoves, startCharCounts);
        if (roll < 0.21) { const l68 = inRange(moves, 6, 8); if (l68.length) return pickRandom(l68); }
        const def = inRange(moves, 3, 5);
        return pickRandom(def.length ? def : moves);
      }
      case 'strong': {
        if (roll < 0.10) return pickHardestToFollow(maxMoves, startCharCounts);
        const def = inRange(moves, 5, 7);
        return pickRandom(def.length ? def : moves);
      }
      case 'strongest':
      default:
        return pickHardestToFollow(maxMoves, startCharCounts);
    }
  }

  // 協力モード専用CPUの強さ別バランス調整値: 単語の長さ1文字分を、終端文字の
  // 「続けやすさ(0〜1に正規化)」何割分と釣り合わせるか。大きいほど、自分の得点
  // よりチーム(人間側)を妨害する終端文字を優先するようになる(=CPUが強くなる)。
  // 「弱い」は0(=単に長い単語を選ぶだけで、チームを妨害する意図を持たない)。
  const COOP_OBSTRUCTION_WEIGHT = { weak: 0, normal: 1, strong: 2, strongest: 4 };

  /** 辞書上、最も多くの単語の先頭になっているかなの出現数 (正規化の基準) */
  function maxStartCharCount(startCharCounts) {
    let max = 1;
    for (const v of startCharCounts.values()) if (v > max) max = v;
    return max;
  }

  /**
   * 協力モード(CPU vs プレーヤー全員)専用の手選び。既存の強さ別ロジック(chooseMove)とは
   * 別の評価式で、「自分の得点(文字数)を伸ばす」ことと「終端の文字をチームが続けにくい
   * ものにする」ことを1つのスコアに合成し、最も高いものを選ぶ(同点はランダム)。
   * level: 'weak' | 'normal' | 'strong' | 'strongest' (省略・未知の値は strongest 扱い)。
   * 強いほど妨害の重みが増し、続けにくさが十分大きければ短い単語をあえて選ぶ
   * ようになる。弱いほど単語の長さだけで選ぶ(妨害を意図しない)傾向になる。
   */
  function chooseCoopMove(game, wordIndex, startChars, startCharCounts, level) {
    const moves = enumerateMoves(game, wordIndex, startChars);
    if (moves.length === 0) return null;
    const weight = level in COOP_OBSTRUCTION_WEIGHT ? COOP_OBSTRUCTION_WEIGHT[level] : COOP_OBSTRUCTION_WEIGHT.strongest;
    const maxCount = maxStartCharCount(startCharCounts);
    let bestScore = -Infinity;
    let ties = [];
    for (const m of moves) {
      const last = [...m.word][m.len - 1];
      const obstruction = (startCharCounts.get(last) || 0) / maxCount;
      const score = m.len - weight * obstruction;
      if (score > bestScore + 1e-9) { bestScore = score; ties = [m]; }
      else if (Math.abs(score - bestScore) <= 1e-9) ties.push(m);
    }
    return pickRandom(ties);
  }

  return {
    LEVELS, LEVEL_LABEL, buildWordIndex, buildStartCharCounts, enumerateMoves, chooseMove, chooseCoopMove,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CPU;
}
