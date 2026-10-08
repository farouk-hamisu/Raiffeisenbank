// Raiffeisen Bank — Minimal canvas chart helpers (line + bar + doughnut). No dependencies.
(function (global) {
  'use strict';

  function prep(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = (w || canvas.clientWidth || 600) * dpr;
    canvas.height = (h || canvas.clientHeight || 220) * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  function axisLocale() {
    return (global.I18N && I18N.locale) ? I18N.locale() : undefined;
  }

  function lineChart(canvas, labels, series, opts) {
    opts = opts || {};
    const ctx = prep(canvas, canvas.clientWidth, canvas.clientHeight);
    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    const pad = { l: 44, r: 12, t: 14, b: 28 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    let max = 0;
    series.forEach(function (s) { s.data.forEach(function (v) { if (v > max) max = v; }); });
    max = max * 1.15 || 1;

    // grid + y labels
    ctx.font = '11px Inter, sans-serif';
    ctx.strokeStyle = '#e6ebf3';
    ctx.fillStyle = '#8a97ad';
    ctx.lineWidth = 1;
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = pad.t + ih - (ih / steps) * i;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillText(Math.round((max / steps) * i).toLocaleString(axisLocale()), 2, y + 4);
    }

    // x labels
    const n = labels.length;
    labels.forEach(function (l, i) {
      const x = pad.l + (iw / (n - 1 || 1)) * i;
      ctx.fillText(l, x - 12, H - 10);
    });

    // series lines
    series.forEach(function (s, si) {
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = s.color || (si === 0 ? '#2f7de1' : '#1a9e5a');
      s.data.forEach(function (v, i) {
        const x = pad.l + (iw / (n - 1 || 1)) * i;
        const y = pad.t + ih - (v / max) * ih;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // area fill
      if (opts.fill !== false) {
        ctx.lineTo(pad.l + iw, pad.t + ih);
        ctx.lineTo(pad.l, pad.t + ih);
        ctx.closePath();
        ctx.fillStyle = s.color || (si === 0 ? '#2f7de1' : '#1a9e5a');
        ctx.globalAlpha = 0.08;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      // points
      s.data.forEach(function (v, i) {
        const x = pad.l + (iw / (n - 1 || 1)) * i;
        const y = pad.t + ih - (v / max) * ih;
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = s.color || '#2f7de1';
        ctx.stroke();
      });
    });
  }

  function barChart(canvas, labels, values, opts) {
    opts = opts || {};
    const ctx = prep(canvas, canvas.clientWidth, canvas.clientHeight);
    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    const pad = { l: 44, r: 12, t: 14, b: 28 };
    const iw = W - pad.l - pad.r;
    const ih = H - pad.t - pad.b;
    let max = 0;
    values.forEach(function (v) { if (v > max) max = v; });
    max = max * 1.15 || 1;
    const color = opts.color || '#2f7de1';
    const n = values.length;
    const bw = Math.min(34, (iw / n) * 0.55);

    ctx.font = '11px Inter, sans-serif';
    ctx.strokeStyle = '#e6ebf3';
    ctx.fillStyle = '#8a97ad';
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const y = pad.t + ih - (ih / steps) * i;
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
      ctx.fillText(Math.round((max / steps) * i).toLocaleString(axisLocale()), 2, y + 4);
    }
    values.forEach(function (v, i) {
      const x = pad.l + (iw / n) * i + (iw / n - bw) / 2;
      const h = (v / max) * ih;
      const y = pad.t + ih - h;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, h, [4, 4, 0, 0]);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#8a97ad';
      ctx.fillText(labels[i] || '', x - (labels[i] ? labels[i].length * 3 : 0) + bw / 2, H - 10);
    });
  }

  function doughnutChart(canvas, items, opts) {
    opts = opts || {};
    const ctx = prep(canvas, canvas.clientWidth, canvas.clientHeight);
    const W = canvas.width / (window.devicePixelRatio || 1);
    const H = canvas.height / (window.devicePixelRatio || 1);
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) / 2 - 6;
    const total = items.reduce(function (s, it) { return s + it.value; }, 0);
    if (!total) return;
    let start = -Math.PI / 2;
    const colors = opts.colors || ['#2f7de1', '#1a9e5a', '#d98e1f', '#d64045', '#123a7e', '#7c8aa0'];
    items.forEach(function (it, i) {
      const angle = (it.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + angle);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      start += angle;
    });
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  global.Charts = { lineChart, barChart, doughnutChart };
})(window);