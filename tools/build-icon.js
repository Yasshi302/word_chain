/**
 * build/icon.svg から Windows 用アイコン build/icon.ico を生成する。
 * 使い方: node tools/build-icon.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');
const pngToIcoMod = require('png-to-ico');
const pngToIco = typeof pngToIcoMod === 'function' ? pngToIcoMod : pngToIcoMod.default;

async function main() {
  const svgPath = path.join(__dirname, '..', 'build', 'icon.svg');
  const svg = fs.readFileSync(svgPath, 'utf8');
  const sizes = [256, 128, 64, 48, 32, 16];
  const buffers = [];
  for (const size of sizes) {
    const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
    buffers.push(resvg.render().asPng());
  }
  // 256px の PNG も別途出力 (電子ビルダーやプレビュー用)
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), buffers[0]);
  const ico = await pngToIco(buffers);
  fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.ico'), ico);
  console.log('生成: build/icon.ico (', sizes.join(','), ') と build/icon.png');
}

main().catch((e) => { console.error(e); process.exit(1); });
