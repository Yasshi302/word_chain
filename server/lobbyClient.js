'use strict';
// 本人確認と部屋の報告は共通ロビーに任せる。
// ロビーの内部API(127.0.0.1のみで待ち受け)に、ブラウザから届いた Cookie ヘッダを渡すと
// 召喚士アカウントかゲストかを判定して返してくれる。ログイン画面もロビー側にある。

function createLobbyClient({ lobbyInternal, game }) {
  async function userFromCookieHeader(header) {
    if (!header) return null;
    try {
      const res = await fetch(`${lobbyInternal}/whoami`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookie: header }),
        signal: AbortSignal.timeout(3000),
      });
      const body = await res.json();
      return body.ok ? body.user : null;
    } catch (e) {
      console.error('ロビーへの本人確認に失敗:', e.message);
      return null;
    }
  }

  // 部屋の一覧を丸ごとロビーへ送る。ロビーが落ちていても対戦は続けられるよう、失敗は無視する
  async function reportRooms(rooms) {
    try {
      await fetch(`${lobbyInternal}/rooms/${game}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rooms }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (e) {
      /* ロビー停止中など。次の定期報告で追いつく */
    }
  }

  return { userFromCookieHeader, reportRooms };
}

module.exports = { createLobbyClient };
