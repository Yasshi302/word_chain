/**
 * リリース自動化: `npm run dist` でポータブルexeをビルドし、
 * GitHub Release (タグ vX.Y.Z) としてそのexeを公開する。
 *
 * 前提:
 *   - `gh` CLI がインストール済みで `gh auth login` 済みであること。
 *   - package.json の repository が対象のGitHubリポジトリを指していること。
 *
 * 使い方: npm run release
 */
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const pkg = require('../package.json');

function run(cmd) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit' });
}

function main() {
  const version = pkg.version;
  const tag = `v${version}`;
  const exeName = `WordChain-${version}-portable.exe`;
  const exePath = path.join(__dirname, '..', 'dist', exeName);

  console.log(`=== ワードチェイン ${tag} をビルドします ===`);
  run('npm run dist');

  if (!fs.existsSync(exePath)) {
    console.error(`ビルド成果物が見つかりません: ${exePath}`);
    process.exit(1);
  }

  console.log(`\n=== GitHub Release ${tag} を作成します ===`);
  run(`gh release create ${tag} "${exePath}" --title "${tag}" --generate-notes`);

  console.log(`\n完了しました: ${tag}`);
  console.log('公開されたリリースはアプリの自動更新チェックから参照されます。');
}

main();
