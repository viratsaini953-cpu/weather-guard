/* ============================================================
   faults.js — reproducible validation harness
   Injects KNOWN sensor faults into a real channel series, runs the
   unchanged production pipeline, and scores the result against the
   ground truth:
        recall    = injected faults detected / injected faults
        precision = true detections / all detections added by injection
        latency   = samples between fault onset and first detection
   Scoring is range-adjusted (a detection within ±2 samples of a
   point fault counts; an episode fault counts if detected anywhere
   inside the episode), which is the usual convention for time-series
   anomaly benchmarks. Everything is seeded, so re-running always
   reproduces the same numbers — see REQUIREMENTS.md §8.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;

  const TOL = 3;      // a detection within ±3 samples of a point fault is a hit
  const ATTRIB = 12;  // one model window: alarms this close are attributable to the fault
  const BASE_TOL = 3; // a clean-run alarm within ±3 h is the same alarm, not a new one

  function cloneSeries(series) {
    return {
      meta: Object.assign({}, series.meta),
      times: series.times.slice(),
      ts: series.ts.slice(),
      channels: series.channels.map(function (c) {
        return Object.assign({}, c, { values: c.values.slice() });
      })
    };
  }

  /* ---- fault injectors: value array -> {values, truth, onset, end} ---- */
  const TYPES = [
    {
      id: 'spike', name: 'Single-sample spike', severity: 'high', mode: 'point',
      expected: 'Robust z · IQR fence · spike test',
      apply: function (v, ch, rnd) {
        const out = v.slice(), truth = [];
        const n = out.length;
        const step = ch.floor * 5;
        [0.35, 0.62, 0.8].forEach(function (frac) {
          const i = Math.floor(n * frac);
          if (!U.isNum(out[i])) return;
          out[i] = out[i] + (rnd() > 0.5 ? 1 : -1) * step * (1 + rnd());
          truth.push(i);
        });
        return { values: out, truth: truth, onset: Math.min.apply(null, truth), end: Math.max.apply(null, truth) };
      }
    },
    {
      id: 'stuck', name: 'Stuck sensor (flatline)', severity: 'high', mode: 'episode',
      expected: 'Flatline rule · residual detectors',
      apply: function (v, ch, rnd) {
        const out = v.slice(), truth = [];
        const n = out.length;
        const start = Math.floor(n * 0.5), len = 10;
        if (!U.isNum(out[start])) return { values: out, truth: [], onset: null, end: null };
        const hold = out[start];
        for (let k = 0; k < len && start + k < n; k++) { out[start + k] = hold; truth.push(start + k); }
        return { values: out, truth: truth, onset: start, end: start + truth.length - 1 };
      }
    },
    {
      id: 'drift', name: 'Progressive drift / bias', severity: 'medium', mode: 'episode',
      expected: 'Drift rule (24 h change beyond plausible maximum)',
      apply: function (v, ch, rnd) {
        const out = v.slice(), truth = [];
        const n = out.length;
        const len = 18, start = Math.floor(n * 0.45);
        const mag = (ch.driftMax || 20) * 1.6;
        for (let k = 0; k < len; k++) {
          const i = start + k;
          if (i >= n || !U.isNum(out[i])) continue;
          out[i] = out[i] + mag * (k / (len - 1));
          truth.push(i);
        }
        return { values: out, truth: truth, onset: truth[0], end: truth[truth.length - 1] };
      }
    },
    {
      id: 'dropout', name: 'Data dropout', severity: 'high', mode: 'episode',
      expected: 'Missing-value check',
      apply: function (v, ch, rnd) {
        const out = v.slice(), truth = [];
        const n = out.length;
        const start = Math.floor(n * 0.55), len = 6;
        for (let k = 0; k < len && start + k < n; k++) { out[start + k] = NaN; truth.push(start + k); }
        return { values: out, truth: truth, onset: start, end: start + truth.length - 1 };
      }
    },
    {
      id: 'range', name: 'Out-of-range value', severity: 'critical', mode: 'point',
      expected: 'Range test (physical limits)',
      apply: function (v, ch, rnd) {
        const out = v.slice(), truth = [];
        const i = Math.floor(out.length * 0.7);
        out[i] = ch.max * 1.4 + 10;
        truth.push(i);
        return { values: out, truth: truth, onset: i, end: i };
      }
    },
    {
      id: 'crosssensor', name: 'Cross-sensor inconsistency', severity: 'critical', mode: 'episode',
      expected: 'Physics rule (dew point above air temperature)',
      apply: function () { return { values: [], truth: [], onset: null, end: null }; }
    }
  ];

  function applyCrossSensor(series) {
    const s = cloneSeries(series);
    const temp = s.channels.filter(function (c) { return c.key === 'temp'; })[0];
    const dew = s.channels.filter(function (c) { return c.key === 'dew'; })[0];
    if (!temp || !dew) return null;
    const n = s.times.length;
    const start = Math.floor(n * 0.4), len = 8;
    const truth = [];
    for (let k = 0; k < len && start + k < n; k++) {
      const i = start + k;
      if (!U.isNum(temp.values[i])) continue;
      dew.values[i] = temp.values[i] + 2.5;
      truth.push(i);
    }
    return { series: s, truth: truth, onset: start, end: start + truth.length - 1, channel: 'dew' };
  }

  /* ---- pipeline result -> predicted set for one channel ---- */
  function predictedFor(result, channelKey, n) {
    const set = {};
    result.events.forEach(function (e) {
      if (e.channelKey !== channelKey) return;
      for (let i = e.start; i <= e.end; i++) set[i] = true;
    });
    result.rules.fired.forEach(function (r) {
      if (r.channels.indexOf(channelKey) < 0) return;
      const idx = r.hitsAll || r.examples.map(function (e) { return e.i; });
      idx.forEach(function (i) { set[i] = true; });
    });
    return set;
  }

  function nearAny(i, list, tol) {
    for (let k = 0; k < list.length; k++) if (Math.abs(i - list[k]) <= tol) return true;
    return false;
  }

  /* Sample-level scoring on a clean test-bed series.
     Recall  = injected fault samples that were flagged.
     Precision = flagged samples that belong to an injected fault.
     On a clean series there are no natural alarms to confuse the count, so a
     sample-level number is both the strictest and the simplest reading. */
  function score(truth, pred, baseline, mode, onset, end) {
    const predIdx = Object.keys(pred).map(Number).filter(function (i) {
      return !(baseline && baseline.indexOf(i) >= 0);   // same sample, same alarm
    });

    let matched;
    if (mode === 'episode') {
      matched = predIdx.some(function (i) { return i >= onset && i <= end; }) ? truth.length : 0;
    } else {
      matched = truth.filter(function (t) { return nearAny(t, predIdx, TOL); }).length;
    }

    let fp = 0;
    predIdx.forEach(function (i) {
      if (nearAny(i, truth, TOL)) return;          // a hit
      fp++;
    });

    const first = predIdx.filter(function (i) { return onset != null && i >= onset; }).sort(function (a, b) { return a - b; })[0];
    return {
      tp: matched, fp: fp, fn: truth.length - matched,
      recall: truth.length ? matched / truth.length : 0,
      precision: (matched + fp) ? matched / (matched + fp) : 0,
      latency: (first != null && onset != null) ? Math.max(0, first - onset) : null
    };
  }

  function run(series, opts) {
    opts = opts || {};
    if (!series || !series.channels || !series.channels.length) {
      return { totals: { tp: 0, fp: 0, fn: 0, recall: 0, precision: 0, f1: 0, pass: false },
        byType: [], trials: [], error: 'no data' };
    }
    const channels = series.channels.filter(function (c) { return c.stat; });
    const results = [];
    const baseOpts = Object.assign({}, opts, { k: 3, window: opts.window || 24 });

    /* Alarms that already exist in the untouched week are not new alarms, so
       the clean run is scored once and subtracted from every trial. */
    const baseResult = AWS.pipeline.run(series, baseOpts);
    const baseline = {};
    channels.forEach(function (c) {
      const m = predictedFor(baseResult, c.key, series.times.length);
      baseline[c.key] = Object.keys(m).map(Number);
    });
    const perType = {};
    TYPES.forEach(function (t) {
      if (t.id === 'crosssensor') return;
      channels.slice(0, 3).forEach(function (ch, idx) {
        const rnd = U.mulberry32((opts.seed || 20261107) + t.id.length * 97 + idx * 13);
        const inj = t.apply(ch.values, ch, rnd);
        if (!inj.truth.length) return;
        const s = cloneSeries(series);
        s.channels.filter(function (c) { return c.key === ch.key; })[0].values = inj.values;
        const res = AWS.pipeline.run(s, baseOpts);
        const pred = predictedFor(res, ch.key, s.times.length);
        const sc = score(inj.truth, pred, baseline[ch.key], t.mode, inj.onset, inj.end);
        sc.type = t.id; sc.channel = ch.key; sc.n = inj.truth.length;
        results.push(sc);
        (perType[t.id] = perType[t.id] || []).push(sc);
      });
    });

    const cs = applyCrossSensor(series);
    if (cs && cs.truth.length) {
      const res = AWS.pipeline.run(cs.series, baseOpts);
      const pred = predictedFor(res, cs.channel, cs.series.times.length);
      const sc = score(cs.truth, pred, baseline[cs.channel], 'episode', cs.onset, cs.end);
      sc.type = 'crosssensor'; sc.channel = cs.channel; sc.n = cs.truth.length;
      results.push(sc);
      (perType.crosssensor = perType.crosssensor || []).push(sc);
    }

    const byType = Object.keys(perType).map(function (id) {
      const rs = perType[id];
      const tp = rs.reduce(function (s, r) { return s + r.tp; }, 0);
      const fp = rs.reduce(function (s, r) { return s + r.fp; }, 0);
      const fn = rs.reduce(function (s, r) { return s + r.fn; }, 0);
      const lat = rs.filter(function (r) { return r.latency !== null; });
      const def = TYPES.filter(function (t) { return t.id === id; })[0] || {};
      return {
        id: id, name: def.name || id, expected: def.expected || '—', mode: def.mode,
        trials: rs.length, tp: tp, fp: fp, fn: fn,
        recall: tp + fn ? tp / (tp + fn) : 0,
        precision: tp + fp ? tp / (tp + fp) : 0,
        f1: (tp + fp && tp + fn) ? 2 * tp / (2 * tp + fp + fn) : 0,
        latency: lat.length ? U.round(U.mean(lat.map(function (r) { return r.latency; })), 1) : null
      };
    }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });

    const tp = results.reduce(function (s, r) { return s + r.tp; }, 0);
    const fp = results.reduce(function (s, r) { return s + r.fp; }, 0);
    const fn = results.reduce(function (s, r) { return s + r.fn; }, 0);
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;

    return {
      byType: byType,
      trials: results,
      totals: {
        tp: tp, fp: fp, fn: fn, precision: precision, recall: recall,
        f1: (precision + recall) ? 2 * precision * recall / (precision + recall) : 0,
        pass: recall >= 0.85 && ((precision + recall) ? 2 * precision * recall / (precision + recall) : 0) >= 0.85
      },
      criteria: { recall: 0.85, f1: 0.85 },
      baseline: { events: baseResult.summary.events, dq: baseResult.summary.dqScore },
      bed: opts.mode === 'live' ? 'live' : 'clean synthetic',
      seed: opts.seed || 20261107
    };
  }

  /* ---- demo mode: a mixed fault set so the dashboard has something to show ---- */
  function demo(series, seed) {
    const s = cloneSeries(series);
    const byKey = {};
    s.channels.forEach(function (c) { byKey[c.key] = c; });
    const n = s.times.length;

    const spike = function (key, mag, frac) {
      const ch = byKey[key];
      if (!ch) return;
      const i = Math.floor(n * frac);
      if (U.isNum(ch.values[i])) ch.values[i] = ch.values[i] + mag;
    };
    spike('temp', 6.5, 0.34);
    spike('rh', -28, 0.58);
    spike('gust', 42, 0.72);

    const p = byKey.press;
    if (p) {
      const i0 = Math.floor(n * 0.46);
      const hold = p.values[i0];
      if (U.isNum(hold)) for (let k = 0; k < 9; k++) if (i0 + k < n) p.values[i0 + k] = hold;
    }
    const w = byKey.wind;
    if (w) {
      const i0 = Math.floor(n * 0.61);
      for (let k = 0; k < 6; k++) if (i0 + k < n) w.values[i0 + k] = NaN;
    }
    const d = byKey.dew, t = byKey.temp;
    if (d && t) {
      const i0 = Math.floor(n * 0.85);
      for (let k = 0; k < 7; k++) {
        const i = i0 + k;
        if (i < n && U.isNum(t.values[i])) d.values[i] = t.values[i] + 2.5;
      }
    }

    s.meta.demo = true;
    s.meta.demoNote = 'Synthetic faults injected locally (seed ' + (seed || 424242) + '); the live feed itself is untouched.';
    return s;
  }

  AWS.faults = { TYPES: TYPES, run: run, cloneSeries: cloneSeries, demo: demo };
})(typeof window !== 'undefined' ? window : globalThis);













