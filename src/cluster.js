/* ============================================================
   cluster.js — unsupervised grouping of time windows
   k-means++ (seeded) over the standardised feature matrix,
   model selection by mean silhouette, PCA for the 2-D view.
   Purpose: separate "normal weather regimes" from
   "disturbed regimes" so a flag can be judged in context.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;
  const EPS = 1e-9;

  function dist2(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
    return s;
  }

  function kmeans(X, k, seed, iters) {
    const n = X.length, dim = X[0].length;
    const rnd = U.mulberry32(seed || 7);
    const maxIters = iters || 80;

    /* k-means++ seeding */
    const centroids = [X[Math.floor(rnd() * n)].slice()];
    while (centroids.length < k) {
      const d2 = X.map(function (x) {
        let best = Infinity;
        for (let c = 0; c < centroids.length; c++) best = Math.min(best, dist2(x, centroids[c]));
        return best;
      });
      let total = 0;
      for (let i = 0; i < n; i++) total += d2[i];
      if (total < EPS) { centroids.push(X[Math.floor(rnd() * n)].slice()); continue; }
      let r = rnd() * total, pick = 0;
      for (let i = 0; i < n; i++) { r -= d2[i]; if (r <= 0) { pick = i; break; } }
      centroids.push(X[pick].slice());
    }

    let labels = new Array(n).fill(0);
    let inertia = Infinity;

    for (let it = 0; it < maxIters; it++) {
      let changed = false;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d = dist2(X[i], centroids[c]);
          if (d < bd) { bd = d; best = c; }
        }
        if (labels[i] !== best) { labels[i] = best; changed = true; }
      }
      const sums = [], counts = new Array(k).fill(0);
      for (let c = 0; c < k; c++) sums.push(new Array(dim).fill(0));
      for (let i = 0; i < n; i++) {
        const c = labels[i];
        counts[c]++;
        for (let d = 0; d < dim; d++) sums[c][d] += X[i][d];
      }
      for (let c = 0; c < k; c++) {
        if (!counts[c]) { centroids[c] = X[Math.floor(rnd() * n)].slice(); continue; }
        for (let d = 0; d < dim; d++) centroids[c][d] = sums[c][d] / counts[c];
      }
      let tot = 0;
      for (let i = 0; i < n; i++) tot += dist2(X[i], centroids[labels[i]]);
      inertia = tot;
      if (!changed && it > 1) break;
    }
    return { labels: labels, centroids: centroids, inertia: inertia };
  }

  function silhouette(X, labels, k) {
    const n = X.length;
    if (n < 4 || k < 2) return NaN;
    const sizes = new Array(k).fill(0);
    for (let i = 0; i < n; i++) sizes[labels[i]]++;
    const sil = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const own = labels[i];
      if (sizes[own] <= 1) { sil[i] = 0; continue; }
      const sums = new Array(k).fill(0);
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        sums[labels[j]] += Math.sqrt(dist2(X[i], X[j]));
      }
      const a = sums[own] / (sizes[own] - 1);
      let b = Infinity;
      for (let c = 0; c < k; c++) {
        if (c === own || !sizes[c]) continue;
        b = Math.min(b, sums[c] / sizes[c]);
      }
      sil[i] = b === Infinity ? 0 : (b - a) / Math.max(a, b);
    }
    return U.mean(sil);
  }

  function autoK(X, seed, kmin, kmax) {
    const lo = kmin || 2, hi = kmax || 6;
    const trials = [];
    for (let k = lo; k <= hi; k++) {
      if (k >= X.length) break;
      const m = kmeans(X, k, seed, 60);
      trials.push({ k: k, silhouette: silhouette(X, m.labels, k), inertia: m.inertia, model: m });
    }
    let best = trials[0];
    trials.forEach(function (t) { if (t.silhouette > best.silhouette) best = t; });
    return { best: best, trials: trials };
  }

  /* ---------- PCA (2 components, power iteration + deflation) ---------- */
  function pca(X) {
    const n = X.length, dim = X[0].length;
    const mu = new Array(dim).fill(0);
    for (let i = 0; i < n; i++) for (let d = 0; d < dim; d++) mu[d] += X[i][d] / n;
    const C = [];
    for (let a = 0; a < dim; a++) C.push(new Array(dim).fill(0));
    for (let i = 0; i < n; i++) {
      for (let a = 0; a < dim; a++) {
        const da = X[i][a] - mu[a];
        for (let b = a; b < dim; b++) C[a][b] += da * (X[i][b] - mu[b]) / n;
      }
    }
    for (let a = 0; a < dim; a++) for (let b = 0; b < a; b++) C[a][b] = C[b][a];

    const rnd = U.mulberry32(99);
    const comps = [], variances = [];
    const totalVar = C.reduce(function (s, row, i) { return s + row[i]; }, 0) || 1;

    const work = C.map(function (r) { return r.slice(); });
    for (let c = 0; c < 2; c++) {
      let v = new Array(dim).fill(0).map(function () { return rnd() - 0.5; });
      let norm = Math.sqrt(v.reduce(function (s, x) { return s + x * x; }, 0)) || 1;
      v = v.map(function (x) { return x / norm; });
      for (let it = 0; it < 200; it++) {
        const nv = new Array(dim).fill(0);
        for (let a = 0; a < dim; a++) for (let b = 0; b < dim; b++) nv[a] += work[a][b] * v[b];
        const nn = Math.sqrt(nv.reduce(function (s, x) { return s + x * x; }, 0));
        if (nn < EPS) break;
        v = nv.map(function (x) { return x / nn; });
      }
      let lam = 0;
      for (let a = 0; a < dim; a++) for (let b = 0; b < dim; b++) lam += v[a] * work[a][b] * v[b];
      comps.push(v); variances.push(lam);
      for (let a = 0; a < dim; a++) for (let b = 0; b < dim; b++) work[a][b] -= lam * v[a] * v[b];
    }

    const coords = X.map(function (row) {
      const z = row.map(function (v, d) { return v - mu[d]; });
      return [
        z.reduce(function (s, val, d) { return s + val * comps[0][d]; }, 0),
        z.reduce(function (s, val, d) { return s + val * comps[1][d]; }, 0)
      ];
    });

    return {
      coords: coords,
      explained: variances.map(function (v) { return v / totalVar; }),
      loadings: comps
    };
  }

  /* ---------- plain-language cluster naming ---------- */
  const PHRASES = {
    rz_temp: ['Cold outlier', 'Warm outlier'],
    rz_rh: ['Dry anomaly', 'Humid anomaly'],
    rz_press: ['Low pressure', 'High pressure'],
    rz_wind: ['Calm anomaly', 'Windy'],
    d1_temp: ['Cooling fast', 'Warming fast'],
    d1_press: ['Pressure falling', 'Pressure rising'],
    d1_wind: ['Wind easing', 'Wind rising'],
    range_temp: ['Flat temperature', 'Wide temperature swing']
  };

  function describe(centroids, ids, labels, sizes) {
    return centroids.map(function (c, idx) {
      const scored = c.map(function (v, d) {
        return { id: ids[d], v: v, mag: Math.abs(v) };
      }).sort(function (a, b) { return b.mag - a.mag; });

      const phrases = scored.slice(0, 2).map(function (s) {
        const p = PHRASES[s.id];
        if (!p) return s.id;
        return p[s.v >= 0 ? 1 : 0];
      });
      const strength = scored.slice(0, 2).map(function (s) {
        return Math.abs(s.v).toFixed(1) + ' SD';
      });
      return {
        index: idx,
        label: phrases.join(' · '),
        signature: scored.slice(0, 3).map(function (s) {
          return { id: s.id, sd: U.round(s.v, 2) };
        }),
        strengthText: strength.join(', '),
        size: sizes[idx],
        centroid: c
      };
    });
  }

  AWS.cluster = {
    kmeans: kmeans,
    silhouette: silhouette,
    autoK: autoK,
    pca: pca,
    describe: describe
  };
})(typeof window !== 'undefined' ? window : globalThis);
