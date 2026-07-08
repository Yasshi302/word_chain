/**
 * 背景: 星座をイメージした星空アニメーション。
 * 画面全体の後ろで、またたく星々を近いもの同士がゆっくり線でつながる
 *(=ワードをつなぐイメージ)。まれに流れ星。
 */
'use strict';

(() => {
  const canvas = document.createElement('canvas');
  canvas.id = 'bg-stars';
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  let stars = [];
  let shootTimer = 0;
  let shooting = null;

  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.round((W * H) / 9000);
    stars = [];
    for (let i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: Math.random() * 1.3 + 0.5,
        vx: (Math.random() - 0.5) * 0.05,
        vy: (Math.random() - 0.5) * 0.05,
        tw: Math.random() * Math.PI * 2,
        tws: Math.random() * 0.9 + 0.3,
        gold: Math.random() < 0.14,
      });
    }
  }

  const LINK = 118;   // 星をつなぐ距離
  function frame(now) {
    ctx.clearRect(0, 0, W, H);
    const t = now / 1000;

    // 星をつなぐ線 (星座)
    for (let i = 0; i < stars.length; i++) {
      const a = stars[i];
      for (let j = i + 1; j < stars.length; j++) {
        const b = stars[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < LINK * LINK) {
          const alpha = (1 - Math.sqrt(d2) / LINK) * 0.16;
          ctx.strokeStyle = `rgba(120,165,230,${alpha.toFixed(3)})`;
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }

    // 星
    for (const s of stars) {
      s.x += s.vx; s.y += s.vy;
      if (s.x < -5) s.x = W + 5; else if (s.x > W + 5) s.x = -5;
      if (s.y < -5) s.y = H + 5; else if (s.y > H + 5) s.y = -5;
      const tw = 0.55 + 0.45 * Math.sin(t * s.tws + s.tw);
      const r = s.r * (0.85 + 0.3 * tw);
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      if (s.gold) ctx.fillStyle = `rgba(233,196,120,${(0.5 + 0.5 * tw).toFixed(3)})`;
      else ctx.fillStyle = `rgba(210,224,250,${(0.45 + 0.5 * tw).toFixed(3)})`;
      ctx.fill();
      if (r > 1.3) { // 明るい星に淡いにじみ
        ctx.beginPath(); ctx.arc(s.x, s.y, r * 2.4, 0, Math.PI * 2);
        ctx.fillStyle = (s.gold ? 'rgba(233,196,120,' : 'rgba(150,185,255,') + (0.06 * tw).toFixed(3) + ')';
        ctx.fill();
      }
    }

    // 流れ星
    shootTimer -= 1;
    if (!shooting && shootTimer <= 0 && Math.random() < 0.004) {
      const sx = Math.random() * W * 0.7, sy = Math.random() * H * 0.4;
      shooting = { x: sx, y: sy, vx: 4 + Math.random() * 3, vy: 2 + Math.random() * 2, life: 1 };
      shootTimer = 240;
    }
    if (shooting) {
      const s = shooting;
      const tailx = s.x - s.vx * 8, taily = s.y - s.vy * 8;
      const grad = ctx.createLinearGradient(tailx, taily, s.x, s.y);
      grad.addColorStop(0, 'rgba(200,220,255,0)');
      grad.addColorStop(1, `rgba(220,235,255,${(0.7 * s.life).toFixed(2)})`);
      ctx.strokeStyle = grad; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(tailx, taily); ctx.lineTo(s.x, s.y); ctx.stroke();
      s.x += s.vx; s.y += s.vy; s.life -= 0.012;
      if (s.life <= 0 || s.x > W + 40 || s.y > H + 40) shooting = null;
    }

    requestAnimationFrame(frame);
  }

  function start() {
    document.body.insertBefore(canvas, document.body.firstChild);
    resize();
    window.addEventListener('resize', resize);
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
