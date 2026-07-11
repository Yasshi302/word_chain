/**
 * Electron メインプロセス
 *
 * セキュリティ方針:
 *  - contextIsolation / sandbox 有効、nodeIntegration 無効
 *  - レンダラからのIPCはすべて入力検証する
 *  - ナビゲーションと新規ウィンドウを全面ブロック
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const dictStore = require('./dict-store');
const friendStore = require('./friend-store');
const updater = require('./updater');
const pkg = require('./package.json');

function customWordsPath() {
  return path.join(app.getPath('userData'), 'custom-words.json');
}
function friendsPath() {
  return path.join(app.getPath('userData'), 'friends.json');
}

const loadCustomDict = () => dictStore.load(customWordsPath());

function createWindow() {
  const win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    title: 'ワードチェイン',
    backgroundColor: '#0d111a',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);
  // 開発時のデバッグ用: レンダラーのコンソールを標準出力へ流す
  if (!app.isPackaged) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // 前回の更新試行の残骸(スクリプトファイル)があれば掃除する
  updater.cleanupStaleArtifacts();

  ipcMain.handle('load-dictionary', () => {
    return fs.readFileSync(path.join(__dirname, 'data', 'dictionary.txt'), 'utf8');
  });

  // 後方互換: 単語配列だけを返す
  ipcMain.handle('load-custom-words', () => loadCustomDict().words);

  // 設定画面・マージ用: 更新日を含む辞書全体を返す
  ipcMain.handle('get-custom-dict', () => loadCustomDict());

  // 追加/削除/置換は常に「保存後の権威ある辞書全体」を返す。
  // レンダラはこの戻り値で自分の状態を同期し、ディスクとの不整合を防ぐ。

  ipcMain.handle('add-custom-word', (_e, word) =>
    dictStore.addWord(customWordsPath(), word, Date.now()));

  ipcMain.handle('remove-custom-word', (_e, word) =>
    dictStore.removeWord(customWordsPath(), word, Date.now()));

  // マージ結果でカスタム辞書を置き換える (更新日も指定)
  ipcMain.handle('set-custom-dict', (_e, payload) =>
    dictStore.setDict(customWordsPath(), payload));

  // ---------------- フレンド ----------------
  ipcMain.handle('get-friend-data', () => friendStore.load(friendsPath()));
  ipcMain.handle('add-friend', (_e, friendId, name) =>
    friendStore.addFriend(friendsPath(), friendId, name));
  ipcMain.handle('remove-friend', (_e, friendId) =>
    friendStore.removeFriend(friendsPath(), friendId));

  // ---------------- 自動更新 ----------------
  // 取得元は常にGitHub Releases (package.json の repository)。
  // 対戦相手からコードを受け取って実行することは一切しない。
  ipcMain.handle('check-update', () => updater.checkForUpdate(pkg, app.getVersion()));

  ipcMain.handle('download-update', async (e, { downloadUrl, size } = {}) => {
    if (typeof downloadUrl !== 'string') return { ok: false, reason: 'invalid-args' };
    const destPath = path.join(app.getPath('temp'), 'wordchain-update.exe');
    try {
      await updater.downloadToFile(downloadUrl, destPath, size, (received, total) => {
        e.sender.send('update-download-progress', { received, total });
      });
      const stat = fs.statSync(destPath);
      if (size && stat.size !== size) {
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        return { ok: false, reason: 'size-mismatch' };
      }
      return { ok: true, path: destPath };
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('apply-update', (_e, { downloadedPath } = {}) => {
    if (typeof downloadedPath !== 'string') return { ok: false, reason: 'invalid-args' };
    const result = updater.applyDownloadedUpdate(downloadedPath);
    if (result.ok) {
      setTimeout(() => { app.quit(); setTimeout(() => process.exit(0), 1500); }, 200);
    }
    return result;
  });

  ipcMain.handle('has-backup', () => updater.hasBackup());

  ipcMain.handle('rollback-update', () => {
    const result = updater.rollbackToBackup();
    if (result.ok) {
      setTimeout(() => { app.quit(); setTimeout(() => process.exit(0), 1500); }, 200);
    }
    return result;
  });

  ipcMain.handle('save-resume-intent', (_e, intent) => {
    if (!intent || typeof intent !== 'object') return false;
    const { role, roomCode, password, myName } = intent;
    if (role !== 'guest') return false;
    if (typeof roomCode !== 'string' || roomCode.length > 8) return false;
    if (typeof password !== 'string' || password.length < 4 || password.length > 64) return false;
    if (typeof myName !== 'string' || myName.length > 24) return false;
    return updater.saveResumeIntent(app.getPath('userData'), { role, roomCode, password, myName });
  });

  ipcMain.handle('get-resume-intent', () => updater.takeResumeIntent(app.getPath('userData')));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// レンダラのナビゲーション・新規ウィンドウを全面的に禁止する
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.on('window-all-closed', () => {
  app.quit();
});
