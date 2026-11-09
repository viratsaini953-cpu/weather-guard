/* ============================================================
   util.js — numeric helpers, seeded RNG, formatting
   Pure functions. No DOM. Safe to run in Node for tests.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const EPS = 1e-9;

  function isNum(v) { return typeof v === 'number' && isFinite(v); }

  function clean(a) {
    const out = [];
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) out.push(a[i]);
    return out;
  }

  function mean(a) {
    let s = 0, n = 0;
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) { s += a[i]; n++; }
    return n ? s / n : NaN;
  }

  function variance(a, ddof) {
    const m = mean(a), n = clean(a).length;
    if (n < 2) return NaN;
    let s = 0;
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) s += (a[i] - m) * (a[i] - m);
    return s / Math.max(1, n - (ddof == null ? 1 : ddof));
  }

  function sd(a) { return Math.sqrt(variance(a, 1)); }

  function sorted(a) {
    const c = clean(a);
    c.sort(function (x, y) { return x - y; });
    return c;
  }

  function quantile(s, q) {
    const n = s.length;
    if (!n) return NaN;
    if (n === 1) return s[0];
    const pos = (n - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return s[lo];
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  function q(a, p) { return quantile(sorted(a), p); }
  function median(a) { return q(a, 0.5); }

  /* Scaled median absolute deviation (~= sigma for normal data) */
  function mad(a) {
    const m = median(a);
    if (!isNum(m)) return NaN;
    const dev = [];
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) dev.push(Math.abs(a[i] - m));
    return 1.4826 * median(dev);
  }

  function skew(a) {
    const c = clean(a), n = c.length;
    if (n < 3) return NaN;
    const m = mean(c), s = sd(c);
    if (!(s > EPS)) return 0;
    let t = 0;
    for (let i = 0; i < n; i++) t += Math.pow((c[i] - m) / s, 3);
    return (n / ((n - 1) * (n - 2))) * t;
  }

  function kurt(a) {
    const c = clean(a), n = c.length;
    if (n < 4) return NaN;
    const m = mean(c), s = sd(c);
    if (!(s > EPS)) return 0;
    let t = 0;
    for (let i = 0; i < n; i++) t += Math.pow((c[i] - m) / s, 4);
    return (n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))) * t - (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
  }

  /* Least-squares slope per time step */
  function slope(a) {
    const xs = [], ys = [];
    for (let i = 0; i < a.length; i++) if (isNum(a[i])) { xs.push(i); ys.push(a[i]); }
    const n = xs.length;
    if (n < 2) return NaN;
    const mx = mean(xs), my = mean(ys);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) * (xs[i] - mx); }
    return den > EPS ? num / den : 0;
  }

  function autocorr1(a) {
    const c = clean(a);
    if (c.length < 4) return NaN;
    const m = mean(c);
    let num = 0, den = 0;
    for (let i = 0; i < c.length; i++) {
      den += (c[i] - m) * (c[i] - m);
      if (i < c.length - 1) num += (c[i] - m) * (c[i + 1] - m);
    }
    return den > EPS ? num / den : 0;
  }

  function corr(x, y) {
    const n = Math.min(x.length, y.length);
    const a = [], b = [];
    for (let i = 0; i < n; i++) if (isNum(x[i]) && isNum(y[i])) { a.push(x[i]); b.push(y[i]); }
    if (a.length < 3) return NaN;
    const ma = mean(a), mb = mean(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb);
      da += (a[i] - ma) * (a[i] - ma);
      db += (b[i] - mb) * (b[i] - mb);
    }
    return da > EPS && db > EPS ? num / Math.sqrt(da * db) : 0;
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function round(v, d) {
    if (!isNum(v)) return NaN;
    const f = Math.pow(10, d == null ? 2 : d);
    return Math.round(v * f) / f;
  }

  /* Deterministic RNG so every run / report is reproducible */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gauss(rnd) {
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    while (v === 0) v = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  function fmtNum(v, d) {
    if (!isNum(v)) return '—';
    const dd = d == null ? 1 : d;
    return v.toFixed(dd);
  }

  function fmtSigned(v, d) {
    if (!isNum(v)) return '—';
    const s = (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d);
    return s;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* "05 Nov 14:00" — locale independent */
  function fmtTime(isoOrMs, withYear) {
    if (isoOrMs == null || isoOrMs === '') return '—';
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
    if (isNaN(d.getTime())) return String(isoOrMs);
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return dd + ' ' + MONTHS[d.getMonth()] + (withYear ? ' ' + d.getFullYear() : '') + ' ' + hh + ':' + mm;
  }

  function fmtDay(isoOrMs) {
    const d = new Date(isoOrMs);
    if (isNaN(d.getTime())) return '—';
    return String(d.getDate()).padStart(2, '0') + ' ' + MONTHS[d.getMonth()];
  }

  function shortTime(isoOrMs) {
    const d = new Date(isoOrMs);
    if (isNaN(d.getTime())) return '—';
    return String(d.getHours()).padStart(2, '0') + ':00';
  }

  AWS.util = {
    EPS: EPS, isNum: isNum, clean: clean, mean: mean, sd: sd, variance: variance,
    sorted: sorted, quantile: quantile, q: q, median: median, mad: mad,
    skew: skew, kurt: kurt, slope: slope, autocorr1: autocorr1, corr: corr,
    clamp: clamp, round: round, mulberry32: mulberry32, gauss: gauss,
    fmtNum: fmtNum, fmtSigned: fmtSigned, fmtTime: fmtTime, fmtDay: fmtDay, shortTime: shortTime,
    MONTHS: MONTHS
  };
})(typeof window !== 'undefined' ? window : globalThis);
