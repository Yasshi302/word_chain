'use strict';
// 戦績(召喚士アカウントのみ。ゲストは保存しない)。友達同士の規模なので JSON ファイル1つ。

const fs = require('fs');
const path = require('path');

function createRecords(file) {
  let data = { users: {} };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* 初回は空 */ }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  const empty = () => ({ win: 0, lose: 0, draw: 0, cpuWin: 0, cpuLose: 0, cpuDraw: 0 });

  function record(userId, name, result, vsCpu) {
    const e = data.users[userId] || (data.users[userId] = { name, ...empty() });
    e.name = name;
    const key = (vsCpu ? 'cpu' : '') + (vsCpu ? result[0].toUpperCase() + result.slice(1) : result);
    e[key] = (e[key] || 0) + 1;
    save();
  }

  function statsOf(userId) {
    const e = data.users[userId];
    return e ? { ...empty(), ...e } : empty();
  }

  return { record, statsOf };
}

module.exports = { createRecords };
