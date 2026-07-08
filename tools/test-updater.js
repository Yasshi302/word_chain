/**
 * バージョン比較ユーティリティの簡易テスト: node tools/test-updater.js
 */
'use strict';

const { parseVersion, compareVersions, isNewer } = require('./updater-util');

let passed = 0;
let failed = 0;
function assert(cond, name) {
  if (cond) { passed++; } else { failed++; console.error('  NG:', name); }
}

assert(JSON.stringify(parseVersion('1.2.3')) === JSON.stringify([1, 2, 3]), 'parseVersion 基本');
assert(JSON.stringify(parseVersion('v1.2.3')) === JSON.stringify([1, 2, 3]), 'parseVersion 先頭のvを除去');
assert(JSON.stringify(parseVersion('1.2')) === JSON.stringify([1, 2, 0]), 'parseVersion 省略部は0扱い');
assert(JSON.stringify(parseVersion('bogus')) === JSON.stringify([0, 0, 0]), 'parseVersion 不正値は0扱い');

assert(compareVersions('1.1.4', '1.1.3') === 1, '1.1.4 > 1.1.3');
assert(compareVersions('1.1.3', '1.1.4') === -1, '1.1.3 < 1.1.4');
assert(compareVersions('1.1.3', '1.1.3') === 0, '1.1.3 == 1.1.3');
assert(compareVersions('v1.2.0', '1.1.9') === 1, 'v接頭辞を無視して比較');
assert(compareVersions('2.0.0', '1.9.9') === 1, 'メジャー桁優先');
assert(compareVersions('1.10.0', '1.9.0') === 1, '桁を数値として比較(文字列比較ではない)');

assert(isNewer('1.2.0', '1.1.9') === true, 'isNewer: 新しい場合はtrue');
assert(isNewer('1.1.9', '1.2.0') === false, 'isNewer: 古い場合はfalse');
assert(isNewer('1.1.9', '1.1.9') === false, 'isNewer: 同一versionはfalse');

console.log(`\n結果: ${passed} 件成功 / ${failed} 件失敗`);
process.exit(failed > 0 ? 1 : 0);
