/**
 * バージョン比較の純粋関数群 (x.y.z のみ対応の簡易semver)。
 * 自動更新の要否判定に使う。UI/ネットワーク/ファイルI/Oには一切依存しない。
 */
'use strict';

function parseVersion(v) {
  const s = String(v).trim().replace(/^v/i, '');
  const parts = s.split('.').map((p) => parseInt(p, 10));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
}

/** a > b なら 1、a < b なら -1、同じなら 0 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/** latest が current より新しいか */
function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

module.exports = { parseVersion, compareVersions, isNewer };
