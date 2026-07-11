/**
 * 音声: Web Audio API による BGM(宇宙テーマの静かなピアノ)と効果音。
 * すべてプログラムで合成 (外部ファイル・著作権なし)。オフラインで鳴る。
 *
 * 音量は localStorage に保存 (wc-vol-bgm / wc-vol-sfx, 0.0〜1.0)。
 */
'use strict';

const Sound = (() => {
  let ctx = null;
  let master = null;      // 全体
  let bgmGain = null;     // BGM用
  let sfxGain = null;     // 効果音用
  let reverb = null;      // 共有リバーブ
  let reverbGain = null;
  let bgmVol = readVol('wc-vol-bgm', 0.5);
  let sfxVol = readVol('wc-vol-sfx', 0.7);
  let bgmPlaying = false;
  let schedTimer = null;
  let nextNoteTime = 0;
  let step = 0;

  function readVol(key, def) {
    try { const v = parseFloat(localStorage.getItem(key)); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : def; }
    catch { return def; }
  }
  function writeVol(key, v) { try { localStorage.setItem(key, String(v)); } catch {} }

  // 音名 → 周波数 (A4=440)
  const NOTE = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };
  function freq(name) {
    const m = /^([A-G]#?)(\d)$/.exec(name);
    if (!m) return 440;
    const semi = NOTE[m[1]] + (Number(m[2]) + 1) * 12; // MIDI番号
    return 440 * Math.pow(2, (semi - 69) / 12);
  }

  function ensure() {
    if (ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
    bgmGain = ctx.createGain(); bgmGain.gain.value = bgmVol; bgmGain.connect(master);
    sfxGain = ctx.createGain(); sfxGain.gain.value = sfxVol; sfxGain.connect(master);
    // 簡易リバーブ (生成インパルス)。リバーブ送りは各カテゴリのゲイン「後」に
    // 置くことで、bgmGain/sfxGain を 0 にすると残響も含めて完全に消える。
    reverb = ctx.createConvolver();
    reverb.buffer = makeImpulse(2.6, 2.4);
    reverbGain = ctx.createGain(); reverbGain.gain.value = 0.9;
    reverb.connect(reverbGain); reverbGain.connect(master);
    const bgmSend = ctx.createGain(); bgmSend.gain.value = 0.5; bgmGain.connect(bgmSend); bgmSend.connect(reverb);
    const sfxSend = ctx.createGain(); sfxSend.gain.value = 0.28; sfxGain.connect(sfxSend); sfxSend.connect(reverb);
  }

  function makeImpulse(seconds, decay) {
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function unlock() {
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
  }

  // ---- 楽器: ピアノ風の一音 ----
  function piano(f, t, dur, vel, dest, revSend) {
    const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.001;
    const o2g = ctx.createGain(); o2g.gain.value = 0.35;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2600;
    const g = ctx.createGain();
    const a = 0.006, peak = vel;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o1.connect(lp); o2.connect(o2g); o2g.connect(lp); lp.connect(g); g.connect(dest);
    o1.start(t); o2.start(t); o1.stop(t + dur + 0.05); o2.stop(t + dur + 0.05);
  }

  // ---- 楽器: やわらかいパッド ----
  function pad(f, t, dur, vel) {
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vel, t + 1.5);
    g.gain.linearRampToValueAtTime(0.0001, t + dur);
    o.connect(lp); lp.connect(g); g.connect(bgmGain);
    o.start(t); o.stop(t + dur + 0.1);
  }

  // ---- BGM: 宇宙テーマの進行 ----
  // 4小節 × 各8秒。ゆったりした sus/9th 系の和音。
  const PROG = [
    { pad: ['A2', 'E3'], arp: ['A3', 'C4', 'E4', 'G4', 'B4'], mel: ['E5', 'A4'] },
    { pad: ['F2', 'C3'], arp: ['F3', 'A3', 'C4', 'E4', 'G4'], mel: ['C5', 'A4'] },
    { pad: ['C3', 'G3'], arp: ['C4', 'E4', 'G4', 'B4', 'D5'], mel: ['G4', 'E5'] },
    { pad: ['G2', 'D3'], arp: ['G3', 'B3', 'D4', 'E4', 'A4'], mel: ['D5', 'B4'] },
  ];
  const BAR = 8.0; // 秒/小節

  function scheduleBar(bar, t) {
    const c = PROG[bar % PROG.length];
    for (const p of c.pad) pad(freq(p), t, BAR + 0.5, 0.12);
    // アルペジオ (ゆっくり)
    c.arp.forEach((n, i) => { piano(freq(n), t + 0.4 + i * 1.05, 3.2, 0.16, bgmGain, 0.5); });
    // まばらな旋律
    c.mel.forEach((n, i) => { piano(freq(n), t + 3.2 + i * 2.2, 3.6, 0.13, bgmGain, 0.7); });
  }

  function scheduler() {
    while (nextNoteTime < ctx.currentTime + 0.5) {
      scheduleBar(step, nextNoteTime);
      nextNoteTime += BAR;
      step++;
    }
  }

  function startBgm() {
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (bgmPlaying) return;
    bgmPlaying = true;
    step = 0;
    nextNoteTime = ctx.currentTime + 0.2;
    scheduler();
    schedTimer = setInterval(scheduler, 250);
  }
  function stopBgm() {
    bgmPlaying = false;
    if (schedTimer) { clearInterval(schedTimer); schedTimer = null; }
  }

  // ---- 効果音 ----
  function beep(type, f0, f1, t0, dur, vel, filterHz) {
    const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vel, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = o;
    if (filterHz) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = filterHz; o.connect(lp); node = lp; }
    node.connect(g); g.connect(sfxGain);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  function bell(f, t0, dur, vel) { // ピアノ音を効果音に流用
    piano(f, t0, dur, vel, sfxGain);
  }

  const SFX = {
    place() { const t = ctx.currentTime; beep('sine', 1000, 1500, t, 0.16, 0.28); beep('sine', 2000, 2600, t, 0.12, 0.12); },
    word() { const t = ctx.currentTime; ['C5', 'E5', 'G5'].forEach((n, i) => bell(freq(n), t + i * 0.09, 0.6, 0.22)); },
    turn() { const t = ctx.currentTime; bell(freq('G4'), t, 0.5, 0.16); bell(freq('C5'), t + 0.14, 0.6, 0.16); },
    button() { beep('triangle', 420, 300, ctx.currentTime, 0.05, 0.14, 1600); },
    approve() { const t = ctx.currentTime; bell(freq('C5'), t, 0.5, 0.2); bell(freq('G5'), t + 0.12, 0.6, 0.2); },
    reject() { beep('sawtooth', 240, 150, ctx.currentTime, 0.28, 0.2, 900); },
    chat() { const t = ctx.currentTime; beep('sine', 680, 920, t, 0.10, 0.22); beep('sine', 1300, 1500, t + 0.05, 0.08, 0.10); },
    bonus() { const t = ctx.currentTime; ['E5', 'G5', 'C6', 'E6'].forEach((n, i) => bell(freq(n), t + i * 0.07, 0.5, 0.2)); },
    win() { const t = ctx.currentTime; ['C5', 'E5', 'G5', 'C6'].forEach((n, i) => bell(freq(n), t + i * 0.12, 0.8, 0.24)); },
    lose() { const t = ctx.currentTime; bell(freq('A4'), t, 0.7, 0.18); bell(freq('D4'), t + 0.18, 1.0, 0.18); },
  };

  function sfx(name) {
    if (sfxVol <= 0) return;
    ensure();
    if (ctx.state === 'suspended') ctx.resume();
    try { if (SFX[name]) SFX[name](); } catch {}
  }

  // ---- 音量 ----
  function setBgmVolume(v) { bgmVol = Math.max(0, Math.min(1, v)); writeVol('wc-vol-bgm', bgmVol); if (bgmGain) bgmGain.gain.setTargetAtTime(bgmVol, ctx.currentTime, 0.05); }
  function setSfxVolume(v) { sfxVol = Math.max(0, Math.min(1, v)); writeVol('wc-vol-sfx', sfxVol); if (sfxGain) sfxGain.gain.setTargetAtTime(sfxVol, ctx.currentTime, 0.05); }
  function getBgmVolume() { return bgmVol; }
  function getSfxVolume() { return sfxVol; }

  return { unlock, startBgm, stopBgm, sfx, setBgmVolume, setSfxVolume, getBgmVolume, getSfxVolume };
})();
