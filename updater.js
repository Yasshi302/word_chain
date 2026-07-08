/**
 * 自動更新 (メインプロセス側)。
 *
 * 取得元は常にGitHub Releases (package.json の repository から owner/repo を読む)。
 * 対戦相手同士を直接比較することはしない。P2P経由でコードを受け取って実行することも
 * 一切しない — ダウンロードは必ずGitHubの公開リリースアセットのみから行う。
 *
 * electron-builder の portable ターゲットは実行時に一時フォルダへ自己展開するため、
 * process.execPath はその使い捨てコピーを指してしまう。実体のexeパスは
 * process.env.PORTABLE_EXECUTABLE_FILE (フォルダは PORTABLE_EXECUTABLE_DIR) を使う。
 * これが無い場合 (開発モード/非portable実行) は自動更新の適用対象外とする。
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isNewer } = require('./tools/updater-util');

function repoSlugFromPackageJson(pkg) {
  if (!pkg || !pkg.repository) return null;
  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository.url;
  const m = /github\.com[:/]+([^/]+\/[^/.]+)/.exec(url || '');
  return m ? m[1] : null;
}

function httpsGetJson(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 5) { reject(new Error('too many redirects')); return; }
    const req = https.get(url, {
      headers: { 'User-Agent': 'word-chain-app', Accept: 'application/vnd.github+json' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        httpsGetJson(res.headers.location, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
  });
}

/** 最新リリースを確認する。ネットワーク等の失敗時も例外を投げず ok:false で返す */
async function checkForUpdate(pkg, currentVersion) {
  const repo = repoSlugFromPackageJson(pkg);
  if (!repo) return { ok: false, reason: 'no-repo-configured' };
  try {
    const rel = await httpsGetJson(`https://api.github.com/repos/${repo}/releases/latest`);
    const latest = rel && rel.tag_name;
    const asset = rel && Array.isArray(rel.assets) ? rel.assets.find((a) => /\.exe$/i.test(a.name)) : null;
    if (!latest || !asset) return { ok: true, needsUpdate: false, reason: 'no-asset' };
    return {
      ok: true,
      needsUpdate: isNewer(latest, currentVersion),
      latest,
      current: currentVersion,
      downloadUrl: asset.browser_download_url,
      size: asset.size,
      assetName: asset.name,
    };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

function downloadToFile(url, destPath, expectedSize, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    let received = 0;
    function get(u, redirects) {
      if (redirects > 5) { reject(new Error('too many redirects')); return; }
      https.get(u, { headers: { 'User-Agent': 'word-chain-app' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
        const total = expectedSize || Number(res.headers['content-length']) || 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) onProgress(received, total);
        });
        res.on('error', reject);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(received)));
      }).on('error', (e) => { fs.unlink(destPath, () => {}); reject(e); });
    }
    get(url, 0);
  });
}

function portablePaths() {
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE;
  if (!exePath) return null;
  const dir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(exePath);
  const base = path.basename(exePath, path.extname(exePath));
  const bakPath = path.join(dir, base + '.bak.exe');
  return { exePath, dir, bakPath };
}

function canWriteDir(dir) {
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

function hasBackup() {
  const p = portablePaths();
  return !!(p && fs.existsSync(p.bakPath));
}

// 差し替え/ロールバックのPowerShellスクリプトは固定テンプレートにし、パス以外を
// 動的生成しない (難読化されたスクリプトはウイルス対策ソフトに誤検知されやすいため)。
function buildSwapScript(exePath, bakPath, newExePath) {
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$exePath = "${exePath}"`,
    `$bakPath = "${bakPath}"`,
    `$newPath = "${newExePath}"`,
    '$ok = $false',
    // 実機検証で、旧exeプロセスがファイルロックを解放するまで15秒(30回)では
    // 足りないケースがあったため、120回(約60秒)まで待つ。
    'for ($i = 0; $i -lt 120; $i++) {',
    '  try {',
    '    if (Test-Path $bakPath) { Remove-Item -Force $bakPath -ErrorAction Stop }',
    '    Rename-Item -Path $exePath -NewName (Split-Path $bakPath -Leaf) -ErrorAction Stop',
    '    $ok = $true',
    '    break',
    '  } catch {',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '}',
    'if ($ok) {',
    '  try {',
    '    Move-Item -Path $newPath -Destination $exePath -Force -ErrorAction Stop',
    '    Start-Process -FilePath $exePath',
    '  } catch {',
    '    if (Test-Path $bakPath) { Move-Item -Path $bakPath -Destination $exePath -Force -ErrorAction SilentlyContinue }',
    '    Start-Process -FilePath $exePath',
    '  }',
    '}',
    'Remove-Item -Force $PSCommandPath -ErrorAction SilentlyContinue',
    '',
  ].join('\r\n');
}

function buildRollbackScript(exePath, bakPath) {
  const tmpPath = exePath + '.tmp';
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$exePath = "${exePath}"`,
    `$bakPath = "${bakPath}"`,
    `$tmpPath = "${tmpPath}"`,
    '$ok = $false',
    // 実機検証で、旧exeプロセスがファイルロックを解放するまで15秒(30回)では
    // 足りないケースがあったため、120回(約60秒)まで待つ。
    'for ($i = 0; $i -lt 120; $i++) {',
    '  try {',
    '    Rename-Item -Path $exePath -NewName (Split-Path $tmpPath -Leaf) -ErrorAction Stop',
    '    $ok = $true',
    '    break',
    '  } catch {',
    '    Start-Sleep -Milliseconds 500',
    '  }',
    '}',
    'if ($ok) {',
    '  Move-Item -Path $bakPath -Destination $exePath -Force -ErrorAction SilentlyContinue',
    '  Move-Item -Path $tmpPath -Destination $bakPath -Force -ErrorAction SilentlyContinue',
    '  Start-Process -FilePath $exePath',
    '}',
    'Remove-Item -Force $PSCommandPath -ErrorAction SilentlyContinue',
    '',
  ].join('\r\n');
}

function spawnDetachedPowerShell(scriptPath, cwd) {
  const child = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
    { detached: true, stdio: 'ignore', windowsHide: true, cwd });
  child.unref();
}

/** ダウンロード済みの新exe(newExePath)を現行exeへ差し替え、再起動する */
function applyDownloadedUpdate(newExePath) {
  const p = portablePaths();
  if (!p) return { ok: false, reason: 'not-portable' };
  if (!canWriteDir(p.dir)) return { ok: false, reason: 'no-write-access' };
  const scriptPath = path.join(p.dir, '.wordchain-update.ps1');
  try {
    fs.writeFileSync(scriptPath, buildSwapScript(p.exePath, p.bakPath, newExePath), 'utf8');
    spawnDetachedPowerShell(scriptPath, p.dir);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/** 直前のバックアップ(.bak.exe)と現行exeを入れ替えて再起動する */
function rollbackToBackup() {
  const p = portablePaths();
  if (!p) return { ok: false, reason: 'not-portable' };
  if (!fs.existsSync(p.bakPath)) return { ok: false, reason: 'no-backup' };
  if (!canWriteDir(p.dir)) return { ok: false, reason: 'no-write-access' };
  const scriptPath = path.join(p.dir, '.wordchain-rollback.ps1');
  try {
    fs.writeFileSync(scriptPath, buildRollbackScript(p.exePath, p.bakPath), 'utf8');
    spawnDetachedPowerShell(scriptPath, p.dir);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/** 更新試行の残骸(前回のスクリプトファイル)があれば起動時に掃除する */
function cleanupStaleArtifacts() {
  const p = portablePaths();
  if (!p) return;
  for (const name of ['.wordchain-update.ps1', '.wordchain-rollback.ps1']) {
    const fp = path.join(p.dir, name);
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch { /* ignore */ }
  }
}

/** 再入室用の一時状態 (userDataフォルダに保存。読んだら削除する使い捨て) */
function saveResumeIntent(userDataDir, intent) {
  try {
    fs.writeFileSync(path.join(userDataDir, 'resume-intent.json'), JSON.stringify(intent), 'utf8');
    return true;
  } catch { return false; }
}

function takeResumeIntent(userDataDir) {
  const fp = path.join(userDataDir, 'resume-intent.json');
  try {
    if (!fs.existsSync(fp)) return null;
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    fs.unlinkSync(fp);
    return data;
  } catch { return null; }
}

module.exports = {
  repoSlugFromPackageJson,
  checkForUpdate,
  downloadToFile,
  portablePaths,
  hasBackup,
  applyDownloadedUpdate,
  rollbackToBackup,
  cleanupStaleArtifacts,
  saveResumeIntent,
  takeResumeIntent,
};
