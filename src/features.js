/* ============================================================
   features.js — rolling-window statistical feature engineering

   Two families of features per channel and timestamp:

   A. RAW-WINDOW DESCRIPTIVES (for interpretation)
      mean, median, min, max, sd, IQR, MAD, range,
      skewness, excess kurtosis, lag-1 autocorrelation, OLS slope.

   B. PREDICTION RESIDUALS (for detection)
      Every weather channel has a strong diurnal cycle, so a raw
      value can look "extreme" purely because the day is warming.
      We therefore fit a 1-step-ahead trend model on the *previous*
      window (no leakage of the current sample) and detect on the
      residual:
         pred_i  = mean(window) + slope(window) * (offset + 1)
         resid_i = x_i - pred_i
      Statistical detectors (robust z, IQR fence, EWMA) run on
      resid_i, which is why a normal sunrise ramp is not flagged
      while a spike, step or stuck value is.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;
  const EPS = 1e-9;

  /* --- predictor A: OLS one-step-ahead extrapolation (trend) --- */
  function predictTrend(values, i, w) {
    const start = Math.max(0, i - w);
    const slice = values.slice(start, i);           // excludes x_i
    const v = U.clean(slice);
    if (v.length < 3) return NaN;

    const s = U.slope(slice);
    const m = U.mean(v);
    const k = i - start;                            // number of points
    return m + s * ((k - 1) / 2 + 1);
  }

  /* --- predictor B: diurnal baseline (same hour, previous days) --- */
  function predictSeasonal(values, i) {
    const vals = [];
    for (let lag = 24; lag <= 72; lag += 24) {
      const j = i - lag;
      if (j >= 0 && U.isNum(values[j])) vals.push(values[j]);
    }
    return vals.length >= 2 ? U.median(vals) : NaN;
  }

  function predict(values, i, w, model) {
    const trend = predictTrend(values, i, w);
    if (model === 'trend') return trend;
    const seasonal = predictSeasonal(values, i);
    if (!U.isNum(seasonal)) return trend;
    if (model === 'seasonal') return seasonal;
    if (!U.isNum(trend)) return seasonal;
    return 0.5 * seasonal + 0.5 * trend;            // default: blended
  }

  function computeChannel(values, w, model) {
    const n = values.length;
    const rows = new Array(n);

    /* --- prediction residuals, computed once per channel --- */
    const resid = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = predict(values, i, w, model);
      resid[i] = U.isNum(values[i]) && U.isNum(p) ? values[i] - p : NaN;
      rows[i] = { i: i, pred: p, resid: resid[i] };
    }

    /* --- EWMA of the residual stream (sequential) --- */
    const lambda = 0.3;
    let ema = NaN;
    for (let i = 0; i < n; i++) {
      const r = resid[i];
      if (!U.isNum(r)) { rows[i].ewma = ema; rows[i].ewmaResid = NaN; continue; }
      const prev = ema;
      ema = U.isNum(prev) ? lambda * r + (1 - lambda) * prev : r;
      rows[i].ewma = ema;
      rows[i].ewmaResid = U.isNum(prev) ? r - prev : 0;
    }

    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const x = values[i];
      const start = Math.max(0, i - w + 1);
      const slice = values.slice(start, i + 1);
      const v = U.clean(slice);
      row.x = x;
      row.w = w;
      row.coverage = v.length / w;

      if (!v.length) {
        ['mean', 'med', 'q1', 'q3', 'iqr', 'mad', 'min', 'max', 'range', 'sd', 'slope',
          'delta1', 'deltaW', 'rz', 'skew', 'kurt', 'ac1', 'flatRun', 'rMed', 'rMad',
          'rQ1', 'rQ3', 'rIqr', 'rScale', 'residZ'].forEach(function (k) { row[k] = NaN; });
        continue;
      }

      const sv = U.sorted(v);
      row.mean = U.mean(v);
      row.med = U.quantile(sv, 0.5);
      row.q1 = U.quantile(sv, 0.25);
      row.q3 = U.quantile(sv, 0.75);
      row.iqr = row.q3 - row.q1;
      row.mad = U.mad(v);
      row.min = sv[0];
      row.max = sv[sv.length - 1];
      row.range = row.max - row.min;
      row.sd = U.sd(v);
      row.slope = U.slope(slice);
      row.skew = U.skew(v);
      row.kurt = U.kurt(v);
      row.ac1 = U.autocorr1(v);
      row.delta1 = i > 0 && U.isNum(values[i - 1]) && U.isNum(x) ? x - values[i - 1] : NaN;
      row.deltaW = i >= w && U.isNum(values[i - w]) && U.isNum(x) ? x - values[i - w] : NaN;

      /* --- residual window statistics --- */
      const rs = [], rslice = resid.slice(start, i + 1);
      for (let j = 0; j < rslice.length; j++) if (U.isNum(rslice[j])) rs.push(rslice[j]);
      if (rs.length >= 3) {
        const srs = U.sorted(rs);
        row.rMed = U.quantile(srs, 0.5);
        row.rQ1 = U.quantile(srs, 0.25);
        row.rQ3 = U.quantile(srs, 0.75);
        row.rIqr = row.rQ3 - row.rQ1;
        row.rMad = U.mad(rs);
        row.rScale = row.rMad > 1e-6 ? row.rMad : (U.sd(rs) > 1e-6 ? U.sd(rs) : NaN);
      } else {
        row.rMed = row.rQ1 = row.rQ3 = row.rIqr = row.rMad = row.rScale = NaN;
      }

      /* robust z of the current residual against its own window */
      const scale = row.rScale;
      if (U.isNum(row.resid)) {
        if (U.isNum(scale) && scale > 1e-6) row.rz = (row.resid - row.rMed) / scale;
        else row.rz = Math.abs(row.resid - (U.isNum(row.rMed) ? row.rMed : 0)) < 1e-9 ? 0
          : Math.sign(row.resid) * 10;
      } else row.rz = NaN;
      row.residZ = row.rz;

      /* trailing flat-run length (stuck sensor indicator) */
      let run = 1;
      if (U.isNum(x)) {
        for (let j = i - 1; j >= 0; j--) {
          if (!U.isNum(values[j])) break;
          if (Math.abs(values[j] - x) <= 1e-9) run++; else break;
        }
      }
      row.flatRun = run;
    }
    return rows;
  }

  function compute(series, windows, model) {
    const out = { windows: windows, byWindow: {}, model: model || 'blend' };
    windows.forEach(function (w) {
      out.byWindow[w] = {};
      series.channels.forEach(function (ch) {
        out.byWindow[w][ch.key] = computeChannel(ch.values, w, model || 'blend');
      });
    });
    return out;
  }

  /* ---------- multivariate matrix for clustering / isolation forest ---------- */
  function featureValue(allRows, idx, spec) {
    const r = allRows[spec.channel] && allRows[spec.channel][idx];
    if (!r) return NaN;
    if (spec.kind === 'rz') return r.rz;
    if (spec.kind === 'delta1') return r.delta1;
    if (spec.kind === 'range') return r.range;
    if (spec.kind === 'slope') return r.slope;
    return r[spec.kind];
  }

  function buildMatrix(series, byWindow, opts) {
    const VEC = AWS.config.FEATURE_VECTOR;
    const perWin = {};
    VEC.forEach(function (spec) { if (!perWin[spec.w]) perWin[spec.w] = byWindow[spec.w]; });

    const n = series.times.length;
    const ids = VEC.map(function (s) { return s.id; });
    const raw = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let f = 0; f < VEC.length; f++) row.push(featureValue(perWin[VEC[f].w], i, VEC[f]));
      raw.push(row);
    }

    const dim = ids.length;
    const med = [], scale = [];
    for (let f = 0; f < dim; f++) {
      const col = raw.map(function (r) { return r[f]; });
      const m = U.median(col);
      const iqr = U.q(col, 0.75) - U.q(col, 0.25);
      med.push(m);
      scale.push(iqr > 1e-6 ? iqr / 1.349 : (U.sd(col) > 1e-6 ? U.sd(col) : 1));
    }
    const X = raw.map(function (r) {
      return r.map(function (v, f) {
        return U.isNum(v) ? U.clamp((v - med[f]) / scale[f], -8, 8) : 0;
      });
    });

    return { ids: ids, specs: VEC, raw: raw, X: X, medians: med, scales: scale, n: n };
  }

  AWS.features = { compute: compute, computeChannel: computeChannel, buildMatrix: buildMatrix, predict: predict };
})(typeof window !== 'undefined' ? window : globalThis);



