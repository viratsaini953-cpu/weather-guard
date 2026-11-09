/* ============================================================
   explain.js — explainable-AI layer
   Produces, for every flagged sample:
     * a ranked contribution list (why the detector fired),
     * a plain-language narrative a station operator can read,
     * the counterfactual (what value would clear the flag),
     * a confidence level from detector agreement.
   Plus a global feature-importance summary over all events.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;

  function detName(id) {
    const d = AWS.anomaly.DETECTORS[id];
    return d ? d.name : id;
  }

  /* feature contributions for one (channel, index) hit */
  function contributions(ch, row, flag, opts) {
    const scale = U.isNum(row.rScale) && row.rScale > 1e-6 ? row.rScale
      : (U.isNum(row.sd) && row.sd > 1e-6 ? row.sd : 1);
    const x = ch.values[flag.i];
    const iqrOut = U.isNum(row.rIqr) && row.rIqr > 1e-9 && U.isNum(row.resid) &&
      (row.resid < row.rQ1 - opts.iqrK * row.rIqr || row.resid > row.rQ3 + opts.iqrK * row.rIqr);
    const rangeOut = U.isNum(x) && (x < ch.min || x > ch.max);

    const items = [
      { id: 'rz', label: 'Distance from rolling median (robust z)', raw: Math.abs(row.rz || 0), weight: 3.0 },
      { id: 'ewma', label: 'Deviation from EWMA baseline', raw: Math.abs(row.ewmaResid || 0) / scale, weight: 1.5 },
      { id: 'delta1', label: '1-hour jump size', raw: Math.abs(row.delta1 || 0) / scale, weight: 1.2 },
      { id: 'iqr', label: 'Outside the IQR fence', raw: iqrOut ? 2 : 0, weight: 1.5 },
      { id: 'slope', label: 'Trend across the window', raw: Math.abs((row.slope || 0) * row.w) / scale, weight: 1.0 },
      { id: 'flat', label: 'Consecutive identical readings', raw: (row.flatRun || 1) >= 6 ? 3 : 0, weight: 1.0 },
      { id: 'coverage', label: 'Missing samples in the window', raw: (1 - (row.coverage == null ? 1 : row.coverage)) * 5, weight: 1.0 },
      { id: 'range', label: 'Outside the physical sensor range', raw: rangeOut ? 5 : 0, weight: 2.0 }
    ];

    items.forEach(function (it) { it.score = it.raw * it.weight; });
    const total = items.reduce(function (s, it) { return s + it.score; }, 0) || 1;
    items.forEach(function (it) { it.pct = 100 * it.score / total; });
    items.sort(function (a, b) { return b.score - a.score; });
    return items.filter(function (it) { return it.score > 0.05; }).slice(0, 5);
  }

  function confidence(flag) {
    const n = flag.dets.filter(function (d) { return d !== 'missing'; }).length;
    if (n >= 3) return 'high';
    if (n === 2) return 'medium';
    return 'low';
  }

  function explainEvent(ch, row, flag, ctx) {
    const x = ch.values[flag.i];
    const items = contributions(ch, row, flag, ctx.opts);
    const top = items.slice(0, 2);
    const pctText = top.map(function (t) {
      return t.label.toLowerCase() + ' (' + Math.round(t.pct) + '%)';
    }).join(' and ');

    const expected = U.isNum(row.pred) ? row.pred : row.med;
    const band = U.isNum(row.rScale) ? ctx.opts.zThresh * row.rScale : NaN;
    const lo = expected - band, hi = expected + band;

    let counter;
    if (!U.isNum(x)) {
      counter = 'Restoring any value would clear this flag, but the cause (missing transmission) still needs fixing.';
    } else if (x < ch.min || x > ch.max) {
      counter = 'No value outside ' + ch.min + '–' + ch.max + ' ' + ch.unit + ' is physically valid, so the sensor itself must be corrected — not the record.';
    } else if (U.isNum(band)) {
      counter = 'A reading between ' + U.fmtNum(lo, ch.decimals) + ' and ' + U.fmtNum(hi, ch.decimals) + ' ' + ch.unit +
        ' (expected ± ' + ctx.opts.zThresh + '·MAD of residuals) would not be flagged.';
    } else {
      counter = 'No stable normal band could be estimated for this window.';
    }

    /* cite any rule that fired on the same channel within ±2 h */
    const cited = [];
    (ctx.rules ? ctx.rules.fired : []).forEach(function (r) {
      if (r.channels.indexOf(ch.key) < 0) return;
      const near = r.examples.some(function (e) {
        return Math.abs(e.i - flag.i) <= 2;
      });
      if (near) cited.push(r);
    });

    let narrative = ch.label + ' at ' + U.fmtTime(ctx.series.times[flag.i]) + ' reads ' +
      (U.isNum(x) ? U.fmtNum(x, ch.decimals) + ' ' + ch.unit : 'nothing (missing)') +
      ', while the 1-hour trend model expected ' + U.fmtNum(expected, ch.decimals) + ' ' + ch.unit +
      ' (window median ' + U.fmtNum(row.med, ch.decimals) + ' ' + ch.unit + '). ';

    if (top.length) narrative += 'The strongest evidence is ' + pctText + '. ';
    narrative += 'Detectors that agree: ' + flag.dets.map(detName).join(', ') + '. ';

    if (cited.length) {
      narrative += 'This matches the rule ' + cited[0].id + ' (' + cited[0].name + '): ' + cited[0].rationale;
    } else {
      narrative += 'No physical rule fired, so this is a statistical outlier rather than a known sensor fault — treat it as "review", not "replace".';
    }

    return {
      contributions: items,
      top: top,
      narrative: narrative,
      counterfactual: counter,
      confidence: confidence(flag),
      citedRules: cited.map(function (r) { return { id: r.id, name: r.name, severity: r.severity }; })
    };
  }

  function opts3(o) { return o.zThresh; }

  /* ---------- global importance over all events ---------- */
  function globalImportance(events) {
    const acc = {};
    events.forEach(function (ev) {
      if (!ev.explanation) return;
      ev.explanation.contributions.forEach(function (c) {
        acc[c.id] = (acc[c.id] || 0) + c.pct;
      });
    });
    const list = Object.keys(acc).map(function (k) {
      const label = {
        rz: 'Distance from rolling median', ewma: 'Deviation from EWMA baseline',
        delta1: '1-hour jump', iqr: 'IQR fence breach', slope: 'Window trend',
        flat: 'Flatline', coverage: 'Missing samples', range: 'Physical range breach'
      }[k] || k;
      return { id: k, label: label, value: acc[k] };
    }).sort(function (a, b) { return b.value - a.value; });
    const total = list.reduce(function (s, i) { return s + i.value; }, 0) || 1;
    list.forEach(function (i) { i.pct = 100 * i.value / total; });
    return list;
  }

  /* ---------- detector agreement histogram ---------- */
  function detectorStats(events) {
    const acc = {};
    events.forEach(function (ev) {
      (ev.dets || []).forEach(function (d) { acc[d] = (acc[d] || 0) + 1; });
    });
    return Object.keys(acc).map(function (k) {
      return { id: k, name: detName(k), count: acc[k] };
    }).sort(function (a, b) { return b.count - a.count; });
  }

  AWS.explain = {
    explainEvent: explainEvent,
    globalImportance: globalImportance,
    detectorStats: detectorStats,
    detName: detName
  };
})(typeof window !== 'undefined' ? window : globalThis);

