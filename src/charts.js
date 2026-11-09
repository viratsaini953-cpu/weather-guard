/* ============================================================
   charts.js — dependency-free SVG charts
   No Chart.js / D3: the whole app runs offline from index.html.
   Each function renders into a container element and handles its
   own empty state.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;
  const NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function empty(host, msg) {
    host.innerHTML = '';
    const d = document.createElement('div');
    d.className = 'chart-empty';
    d.textContent = msg || 'No data';
    host.appendChild(d);
  }

  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max) || min === max) return [min];
    const span = max - min;
    const step0 = span / (count || 5);
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
    const start = Math.ceil(min / step) * step;
    const out = [];
    for (let v = start; v <= max + 1e-9; v += step) out.push(U.round(v, 6));
    return out;
  }

  /* ---------- line chart with expected band + anomaly markers ---------- */
  function line(host, cfg) {
    host.innerHTML = '';
    const times = cfg.times || [];
    const values = cfg.values || [];
    if (!values.length) return empty(host, cfg.emptyText);

    const W = 900, H = cfg.height || 300;
    const pad = { l: 52, r: 16, t: 14, b: 30 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

    const band = cfg.band;
    let lo = Infinity, hi = -Infinity;
    values.forEach(function (v, i) {
      if (!U.isNum(v)) return;
      lo = Math.min(lo, v); hi = Math.max(hi, v);
      if (band && U.isNum(band.lo[i])) lo = Math.min(lo, band.lo[i]);
      if (band && U.isNum(band.hi[i])) hi = Math.max(hi, band.hi[i]);
    });
    if (!isFinite(lo)) return empty(host, cfg.emptyText);
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const padY = (hi - lo) * 0.12;
    lo -= padY; hi += padY;

    const x = function (i) { return pad.l + (i / Math.max(1, values.length - 1)) * iw; };
    const y = function (v) { return pad.t + ih - ((v - lo) / (hi - lo)) * ih; };

    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart', role: 'img' });

    /* grid + y labels */
    niceTicks(lo, hi, 5).forEach(function (t) {
      svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: y(t), y2: y(t), class: 'grid' }));
      svg.appendChild(el('text', { x: pad.l - 8, y: y(t) + 4, class: 'axis-label', 'text-anchor': 'end' },
        U.fmtNum(t, cfg.decimals == null ? 1 : cfg.decimals)));
    });

    /* expected band */
    if (band) {
      let d = '', started = false;
      for (let i = 0; i < values.length; i++) {
        if (!U.isNum(band.hi[i])) continue;
        d += (started ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(band.hi[i]).toFixed(1) + ' ';
        started = true;
      }
      for (let i = values.length - 1; i >= 0; i--) {
        if (!U.isNum(band.lo[i])) continue;
        d += 'L' + x(i).toFixed(1) + ' ' + y(band.lo[i]).toFixed(1) + ' ';
      }
      if (started) svg.appendChild(el('path', { d: d + 'Z', class: 'band' }));
    }

    /* main line (gap-aware) */
    let d = '', pen = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!U.isNum(v)) { pen = false; continue; }
      d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
      pen = true;
    }
    svg.appendChild(el('path', { d: d, class: 'series', stroke: cfg.color || '#1B6B4B' }));

    /* x ticks: one per calendar day, thinned to at most 8 labels */
    const n = values.length;
    let dayTicks = [];
    let lastDay = null;
    for (let i = 0; i < n; i++) {
      const d = new Date(times[i]);
      const key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
      if (key !== lastDay) { dayTicks.push(i); lastDay = key; }
    }
    while (dayTicks.length > 8) dayTicks = dayTicks.filter(function (_, k) { return k % 2 === 0; });
    if (!dayTicks.length) dayTicks = [0];
    dayTicks.forEach(function (i, k) {
      svg.appendChild(el('line', { x1: x(i), x2: x(i), y1: pad.t + ih, y2: pad.t + ih + 4, class: 'grid' }));
      svg.appendChild(el('text', {
        x: x(i), y: H - 8, class: 'axis-label',
        'text-anchor': k === 0 ? 'start' : (k === dayTicks.length - 1 ? 'end' : 'middle')
      }, U.fmtDay(times[i])));
    });

    /* markers */
    (cfg.markers || []).forEach(function (m) {
      if (!U.isNum(values[m.i])) return;
      const cx = x(m.i), cy = y(values[m.i]);
      svg.appendChild(el('circle', { cx: cx, cy: cy, r: m.r || 4.5, class: 'marker', fill: m.color || '#dc2626' }));
      if (m.label) {
        const t = el('title', null, m.label);
        svg.lastChild.appendChild(t);
      }
    });

    /* hover layer */
    const hover = el('line', { x1: 0, x2: 0, y1: pad.t, y2: pad.t + ih, class: 'crosshair', opacity: 0 });
    svg.appendChild(hover);
    const dot = el('circle', { r: 4, class: 'hover-dot', opacity: 0, fill: cfg.color || '#1B6B4B' });
    svg.appendChild(dot);

    host.appendChild(svg);

    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    host.appendChild(tip);

    svg.addEventListener('mousemove', function (ev) {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * W;
      if (px < pad.l || px > W - pad.r) { tip.style.opacity = 0; hover.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); return; }
      const i = Math.round(((px - pad.l) / iw) * (values.length - 1));
      if (i < 0 || i >= values.length) return;
      const v = values[i];
      hover.setAttribute('x1', x(i)); hover.setAttribute('x2', x(i)); hover.setAttribute('opacity', 1);
      if (U.isNum(v)) {
        dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(v)); dot.setAttribute('opacity', 1);
      } else dot.setAttribute('opacity', 0);

      const lines = ['<b>' + U.fmtTime(times[i]) + '</b>'];
      lines.push((cfg.label || 'Value') + ': ' + (U.isNum(v) ? U.fmtNum(v, cfg.decimals == null ? 1 : cfg.decimals) + ' ' + (cfg.unit || '') : 'missing'));
      if (band && U.isNum(band.lo[i])) {
        lines.push('expected ' + U.fmtNum(band.lo[i], cfg.decimals == null ? 1 : cfg.decimals) + ' … ' +
          U.fmtNum(band.hi[i], cfg.decimals == null ? 1 : cfg.decimals) + ' ' + (cfg.unit || ''));
      }
      const ms = (cfg.markers || []).filter(function (m) { return m.i === i; });
      ms.forEach(function (m) { lines.push('<span class="tip-flag">● ' + (m.label || 'flagged') + '</span>'); });

      tip.innerHTML = lines.join('<br>');
      tip.style.opacity = 1;
      const left = Math.min(rect.width - 150, Math.max(0, (x(i) / W) * rect.width + 12));
      tip.style.left = left + 'px';
      tip.style.top = '10px';
    });
    svg.addEventListener('mouseleave', function () {
      tip.style.opacity = 0;
      hover.setAttribute('opacity', 0);
      dot.setAttribute('opacity', 0);
    });
  }

  /* ---------- scatter (PCA view) ---------- */
  function scatter(host, cfg) {
    host.innerHTML = '';
    const pts = cfg.points || [];
    if (!pts.length) return empty(host, cfg.emptyText);

    const W = 720, H = cfg.height || 380;
    const pad = { l: 44, r: 16, t: 16, b: 34 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    pts.forEach(function (p) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    });
    const mx = (x1 - x0) * 0.08 || 1, my = (y1 - y0) * 0.08 || 1;
    x0 -= mx; x1 += mx; y0 -= my; y1 += my;

    const sx = function (v) { return pad.l + ((v - x0) / (x1 - x0)) * iw; };
    const sy = function (v) { return pad.t + ih - ((v - y0) / (y1 - y0)) * ih; };

    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart' });
    svg.appendChild(el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, class: 'plot-bg' }));
    svg.appendChild(el('line', { x1: pad.l, x2: W - pad.r, y1: sy(0), y2: sy(0), class: 'grid' }));
    svg.appendChild(el('line', { x1: sx(0), x2: sx(0), y1: pad.t, y2: pad.t + ih, class: 'grid' }));
    /* axis ticks */
    niceTicks(x0, x1, 5).forEach(function (t) {
      svg.appendChild(el('line', { x1: sx(t), x2: sx(t), y1: pad.t + ih, y2: pad.t + ih + 4, class: 'grid' }));
      svg.appendChild(el('text', { x: sx(t), y: H - 12, class: 'axis-label', 'text-anchor': 'middle' }, U.fmtNum(t, 0)));
    });
    niceTicks(y0, y1, 5).forEach(function (t) {
      svg.appendChild(el('line', { x1: pad.l - 4, x2: pad.l, y1: sy(t), y2: sy(t), class: 'grid' }));
      svg.appendChild(el('text', { x: pad.l - 8, y: sy(t) + 4, class: 'axis-label', 'text-anchor': 'end' }, U.fmtNum(t, 0)));
    });
    svg.appendChild(el('text', { x: W - pad.r, y: H - 1, class: 'axis-label', 'text-anchor': 'end' }, cfg.xLabel || 'PC 1'));
    svg.appendChild(el('text', { x: pad.l, y: 11, class: 'axis-label', 'text-anchor': 'start' }, cfg.yLabel || 'PC 2'));

    pts.forEach(function (p) {
      const c = el('circle', {
        cx: sx(p.x), cy: sy(p.y), r: p.r || (p.flagged ? 5.2 : 3.4),
        fill: p.color || '#9FBFAC',
        stroke: p.flagged ? '#dc2626' : 'rgba(15,23,42,.25)',
        'stroke-width': p.flagged ? 1.6 : 0.6,
        opacity: p.flagged ? 0.95 : 0.7
      });
      c.appendChild(el('title', null, p.label || ''));
      svg.appendChild(c);
    });

    host.appendChild(svg);
  }

  /* ---------- horizontal bars ---------- */
  function bars(host, cfg) {
    host.innerHTML = '';
    const items = cfg.items || [];
    if (!items.length) return empty(host, cfg.emptyText || 'Nothing to show');
    const max = cfg.max || Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));

    const wrap = document.createElement('div');
    wrap.className = 'bars';
    items.forEach(function (it) {
      const row = document.createElement('div');
      row.className = 'bar-row';
      const w = Math.max(1.5, (it.value / max) * 100);
      row.innerHTML =
        '<div class="bar-label">' + it.label + '</div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + w + '%;background:' + (it.color || '#2E8B62') + '"></div></div>' +
        '<div class="bar-value">' + (it.display != null ? it.display : U.fmtNum(it.value, 0)) + '</div>';
      wrap.appendChild(row);
    });
    host.appendChild(wrap);
  }

  /* ---------- completeness heatmap ---------- */
  function heatmap(host, cfg) {
    host.innerHTML = '';
    const rows = cfg.rows || [], cols = cfg.cols || [];
    if (!rows.length) return empty(host);

    const cw = 5, ch = 16, labelW = 116, W = cols.length * cw + labelW + 10, H = rows.length * ch + 26;
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'chart heat' });
    rows.forEach(function (r, ri) {
      svg.appendChild(el('text', { x: 0, y: ri * ch + 11, class: 'axis-label' }, r.label));
      r.values.forEach(function (v, ci) {
        const color = v == null ? '#EDF1EE' : v === 2 ? '#D45B5B' : v === 1 ? '#E4A93C' : '#C9DED2';
        svg.appendChild(el('rect', {
          x: labelW + ci * cw, y: ri * ch, width: cw - 1, height: ch - 4, rx: 1, fill: color
        })).appendChild(el('title', null, r.label + ' · ' + (cols[ci] || '') + ' · ' + (v == null ? 'no data' : v === 2 ? 'flagged' : v === 1 ? 'suspect' : 'ok')));
      });
    });
    /* time axis: first, middle and last sample */
    if (cols.length) {
      [0, Math.floor(cols.length / 2), cols.length - 1].forEach(function (ci, k) {
        svg.appendChild(el('text', {
          x: labelW + ci * cw, y: rows.length * ch + 14, class: 'axis-label',
          'text-anchor': k === 0 ? 'start' : (k === 2 ? 'end' : 'middle')
        }, U.fmtDay(cols[ci])));
      });
    }
    host.appendChild(svg);
  }

  /* ---------- sparkline ---------- */
  function spark(host, values, color) {
    host.innerHTML = '';
    const v = U.clean(values);
    if (v.length < 2) return empty(host, '');
    const W = 120, H = 30, min = Math.min.apply(null, v), max = Math.max.apply(null, v);
    const span = max - min || 1;
    let d = '';
    v.forEach(function (n, i) {
      const x = (i / (v.length - 1)) * W;
      const y = H - 2 - ((n - min) / span) * (H - 4);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
    });
    const svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'spark' });
    svg.appendChild(el('path', { d: d, stroke: color || '#1B6B4B', fill: 'none', 'stroke-width': 1.6 }));
    host.appendChild(svg);
  }

  AWS.charts = { line: line, scatter: scatter, bars: bars, heatmap: heatmap, spark: spark };
})(typeof window !== 'undefined' ? window : globalThis);




