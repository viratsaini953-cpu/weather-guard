/* ============================================================
   anomaly.js — anomaly detection layer
   Ensemble of four univariate detectors + one multivariate
   detector (Isolation Forest). A sample is flagged when the
   detectors agree (>= 2 votes) or when the robust z-score is
   extreme (> 5). Agreement is what makes the output explainable:
   every flag carries the list of detectors that raised it.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;
  const EPS = 1e-9;

  const DETECTORS = {
    missing: { id: 'missing', name: 'Missing sample', group: 'completeness' },
    range: { id: 'range', name: 'Physical range test', group: 'plausibility' },
    madz: { id: 'madz', name: 'Robust z-score (MAD)', group: 'statistical' },
    iqr: { id: 'iqr', name: 'IQR fence (Tukey far-out)', group: 'statistical' },
    ewma: { id: 'ewma', name: 'EWMA control chart', group: 'statistical' },
    spike: { id: 'spike', name: 'Spike with reversal', group: 'plausibility' },
    flat: { id: 'flat', name: 'Flatline (stuck sensor)', group: 'stability' },
    iforest: { id: 'iforest', name: 'Isolation Forest', group: 'multivariate' }
  };

  /* ---------- single channel ---------- */
  function detectChannel(ch, rows, opts) {
    const out = new Array(rows.length);
    const statistical = ch.stat !== false;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const x = ch.values[i];
      const dets = [];

      if (!U.isNum(x)) {
        dets.push('missing');
        out[i] = { i: i, flag: true, z: NaN, dets: dets, score: 65, expected: r.pred, band: NaN, value: NaN };
        continue;
      }

      /* warm-up: the trend model needs history, so the first
         min(window, 12) samples are reference-only (documented) */
      if (i < Math.min(opts.window, 12)) {
        out[i] = { i: i, flag: false, z: NaN, dets: [], score: 0, value: x, expected: NaN, band: NaN };
        continue;
      }

      /* range test always applies */
      const rangeOut = x < ch.min || x > ch.max;
      if (rangeOut) dets.push('range');

      /* effect-size gate: a deviation must also be physically meaningful,
         otherwise steep-but-real diurnal ramps get flagged by tiny MADs */
      const floor = ch.floor || 0;
      const big = !U.isNum(r.resid) ? false : Math.abs(r.resid) >= floor;
      let spikeHard = false;

      if (statistical) {
        const z = r.rz;
        if (big && U.isNum(z) && Math.abs(z) > opts.zThresh) dets.push('madz');
        if (big && U.isNum(r.rIqr) && r.rIqr > EPS &&
          (r.resid < r.rQ1 - opts.iqrK * r.rIqr || r.resid > r.rQ3 + opts.iqrK * r.rIqr)) dets.push('iqr');

        /* EWMA control chart on the residual stream */
        if (big && U.isNum(r.ewmaResid)) {
          const start = Math.max(0, i - opts.window + 1);
          const res = [];
          for (let j = start; j <= i; j++) if (U.isNum(rows[j].ewmaResid)) res.push(rows[j].ewmaResid);
          const s = U.sd(res);
          if (U.isNum(s) && s > EPS && Math.abs(r.ewmaResid) > opts.ewmaSigma * s) dets.push('ewma');
        }

        /* WMO-style spike test: deviation from the mean of the two
           neighbours. A trend or a step does not trip it, because the
           neighbours move with the value; a single bad sample does. */
        if (i > 0 && i < rows.length - 1) {
          const p = ch.values[i - 1], n = ch.values[i + 1];
          if (U.isNum(p) && U.isNum(n)) {
            const dev = Math.abs(x - (p + n) / 2);
            const thr = Math.max(2 * (U.isNum(r.rScale) ? r.rScale : 0), 2 * (ch.floor || 0), (ch.stepMax || 0) / 3);
            if (thr > EPS && dev > thr) {
              dets.push('spike');
              /* a jump this size cannot be a smooth weather transition:
                 it is a one-sample excursion and counts as decisive */
              if (dev > Math.max(2 * (ch.floor || 0), (ch.stepMax || 0) / 2)) spikeHard = true;
            }
          }
        }

        if (ch.persistence && U.isNum(r.flatRun) && r.flatRun >= 6) dets.push('flat');
      }

      const nDet = dets.length;
      const z = r.rz;
      const extreme = statistical && big && U.isNum(z) && Math.abs(z) > 5;
      /* a single decisive detector is enough when the finding is
         deterministic: an impossible value or a frozen sensor is a
         fault regardless of how many statistics agree. */
      const decisive = rangeOut || spikeHard || dets.indexOf('flat') >= 0;
      const flag = nDet >= 2 || extreme || decisive;

      let score = 0;
      if (flag) {
        const dist = rangeOut ? 0.95 : U.isNum(z) ? Math.min(1, Math.abs(z) / 6) : 0.4;
        score = Math.round(100 * U.clamp(0.7 * dist + 0.3 * Math.min(1, nDet / 3), 0, 1));
        if (rangeOut) score = Math.max(score, 90);
        if (dets.indexOf('flat') >= 0) score = Math.max(score, 70);
        if (spikeHard) score = Math.max(score, 62);
      }

      out[i] = {
        i: i, flag: flag, z: U.isNum(z) ? z : NaN, dets: dets, score: score,
        value: x, expected: r.pred,
        band: U.isNum(r.rScale) ? opts.zThresh * r.rScale : NaN
      };
    }
    return out;
  }
  /* group consecutive flagged samples into readable episodes */
  function groupEpisodes(channel, flags) {
    const eps = [];
    let cur = null;
    for (let i = 0; i < flags.length; i++) {
      const f = flags[i];
      if (!f.flag) { cur = null; continue; }
      if (cur && i === cur.end + 1) {
        cur.end = i; cur.count++;
        cur.maxScore = Math.max(cur.maxScore, f.score);
        f.dets.forEach(function (d) { cur.dets[d] = true; });
        if (f.score >= cur.peak.score) cur.peak = f;
      } else {
        cur = {
          channelKey: channel.key, channel: channel.label, unit: channel.unit,
          start: i, end: i, count: 1,
          maxScore: f.score, peak: f,
          dets: f.dets.reduce(function (o, d) { o[d] = true; return o; }, {})
        };
        eps.push(cur);
      }
    }
    return eps;
  }

  /* ---------- Isolation Forest (Liu, Ting & Zhou 2008) ---------- */
  function cFactor(n) {
    if (n <= 1) return 1;
    return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1) / n);
  }

  function buildTree(points, depth, maxDepth, rnd, dim) {
    if (depth >= maxDepth || points.length <= 1) return { leaf: true, size: points.length };
    let attempt = 0, q, p, minv, maxv;
    do {
      q = Math.floor(rnd() * dim) % dim;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < points.length; i++) {
        const v = points[i][q];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      minv = lo; maxv = hi;
      if (maxv - minv < EPS) { attempt++; continue; }
      p = minv + rnd() * (maxv - minv);
      attempt++;
    } while ((maxv - minv < EPS) && attempt < 3);
    if (!(maxv - minv > EPS)) return { leaf: true, size: points.length };

    const left = [], right = [];
    for (let i = 0; i < points.length; i++) (points[i][q] < p ? left : right).push(points[i]);
    if (!left.length || !right.length) return { leaf: true, size: points.length };
    return {
      leaf: false, split: q, value: p,
      left: buildTree(left, depth + 1, maxDepth, rnd, dim),
      right: buildTree(right, depth + 1, maxDepth, rnd, dim)
    };
  }

  function pathLength(x, tree, depth) {
    if (tree.leaf) return depth + cFactor(tree.size);
    return x[tree.split] < tree.value
      ? pathLength(x, tree.left, depth + 1)
      : pathLength(x, tree.right, depth + 1);
  }

  function isolationForest(X, opts) {
    const n = X.length;
    if (!n) return { scores: [], flags: [], threshold: NaN };
    const dim = X[0].length;
    const rnd = U.mulberry32(opts.seed || 42);
    const nTrees = 100;
    const psi = Math.min(256, n);
    const maxDepth = Math.ceil(Math.log2(Math.max(2, psi)));
    const trees = [];
    for (let t = 0; t < nTrees; t++) {
      /* seeded reservoir sample without replacement */
      const idxs = [];
      for (let i = 0; i < n; i++) idxs.push(i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        const tmp = idxs[i]; idxs[i] = idxs[j]; idxs[j] = tmp;
      }
      const sample = idxs.slice(0, psi).map(function (k) { return X[k]; });
      trees.push(buildTree(sample, 0, maxDepth, rnd, dim));
    }
    const c = cFactor(psi);
    const scores = X.map(function (row) {
      let h = 0;
      for (let t = 0; t < trees.length; t++) h += pathLength(row, trees[t], 0);
      h /= trees.length;
      return Math.pow(2, -h / c);
    });

    /* data-driven cut: robust upper fence of the score distribution,
       never below 0.55 (standard iForest "anomaly" region). */
    const med = U.median(scores);
    const md = U.mad(scores);
    const threshold = Math.max(0.55, med + 3 * (U.isNum(md) ? md : 0.02));
    return {
      scores: scores,
      threshold: threshold,
      flags: scores.map(function (s) { return s > threshold; })
    };
  }

  AWS.anomaly = {
    DETECTORS: DETECTORS,
    detectChannel: detectChannel,
    groupEpisodes: groupEpisodes,
    isolationForest: isolationForest
  };
})(typeof window !== 'undefined' ? window : globalThis);









