/* ============================================================
   quality.js — data-quality scoring
   Turns the raw QC test results into (a) a per-channel score and
   (b) a single 0-100 Data Quality Index with a letter grade.
   The index is deliberately simple and additive so a reviewer can
   recompute it by hand from the published penalties.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;

  const WEIGHTS = {
    completeness: 30,
    range: 20,
    step: 15,
    persistence: 15,
    consistency: 12,
    timestamps: 8
  };

  function grade(score) {
    if (score >= 90) return 'A';
    if (score >= 80) return 'B';
    if (score >= 70) return 'C';
    if (score >= 60) return 'D';
    return 'F';
  }

  function evaluate(series) {
    const byKey = {};
    series.channels.forEach(function (c) { byKey[c.key] = c; });
    const n = series.times.length;

    /* ---- per channel counters ---- */
    const rows = series.channels.map(function (ch) {
      let valid = 0, missing = 0, outOfRange = 0, stepViol = 0, flatSamples = 0;
      let run = 1, flatEpisodes = 0;
      for (let i = 0; i < ch.values.length; i++) {
        const x = ch.values[i];
        if (!U.isNum(x)) { missing++; run = 1; continue; }
        valid++;
        if (x < ch.min || x > ch.max) outOfRange++;
        if (i > 0 && U.isNum(ch.values[i - 1])) {
          let d = x - ch.values[i - 1];
          if (ch.circular) d = ((d % 360) + 540) % 360 - 180;
          if (Math.abs(d) > ch.stepMax) stepViol++;
          if (Math.abs(d) < 1e-9 && ch.persistence) run++; else run = 1;
          if (ch.persistence && run >= 6) { flatSamples++; if (run === 6) flatEpisodes++; }
        }
      }
      const total = ch.values.length || 1;
      const missRate = missing / total;

      let score = 100;
      score -= Math.min(45, missRate * 100 * 3);       // 1% missing ~ 3 pts (capped)
      score -= Math.min(40, outOfRange * 12);
      score -= Math.min(24, stepViol * 6);
      score -= Math.min(25, flatEpisodes * 12);
      score = U.clamp(score, 0, 100);

      return {
        key: ch.key, label: ch.label, short: ch.short, unit: ch.unit,
        valid: valid, missing: missing, total: total,
        missingRate: missRate,
        outOfRange: outOfRange, stepViolations: stepViol,
        flatSamples: flatSamples, flatEpisodes: flatEpisodes,
        min: U.clean(ch.values).length ? Math.min.apply(null, U.clean(ch.values)) : NaN,
        max: U.clean(ch.values).length ? Math.max.apply(null, U.clean(ch.values)) : NaN,
        mean: U.mean(ch.values),
        score: U.round(score, 1), grade: grade(score)
      };
    });

    /* ---- station-level QC checks (published acceptance tests) ---- */
    const T = byKey.temp.values, RH = byKey.rh.values, TD = byKey.dew.values;
    const WS = byKey.wind.values, GU = byKey.gust.values;

    let gaps = 0, dups = 0, irregular = 0;
    for (let i = 1; i < n; i++) {
      const dt = series.ts[i] - series.ts[i - 1];
      if (dt <= 0) dups++;
      else if (dt > 1.5 * 3600e3) gaps++;
      else if (dt < 0.5 * 3600e3) irregular++;
    }

    let inconsistencies = 0;
    for (let i = 0; i < n; i++) {
      if (U.isNum(TD[i]) && U.isNum(T[i]) && TD[i] > T[i] + 0.5) inconsistencies++;
      if (U.isNum(GU[i]) && U.isNum(WS[i]) && GU[i] < WS[i] - 0.5) inconsistencies++;
      if (U.isNum(RH[i]) && (RH[i] < 0 || RH[i] > 100)) inconsistencies++;
    }

    const ageH = (Date.now() - series.ts[n - 1]) / 3600e3;
    const totalMissing = rows.reduce(function (s, r) { return s + r.missing; }, 0);
    const totalSamples = rows.reduce(function (s, r) { return s + r.total; }, 0);
    const totalOut = rows.reduce(function (s, r) { return s + r.outOfRange; }, 0);
    const totalStep = rows.reduce(function (s, r) { return s + r.stepViolations; }, 0);
    const totalFlat = rows.reduce(function (s, r) { return s + r.flatEpisodes; }, 0);
    const missingRate = totalMissing / Math.max(1, totalSamples);

    const checks = [
      {
        id: 'QC-1', name: 'Completeness', spec: 'missing samples ≤ 2% per channel',
        count: totalMissing, status: missingRate > 0.05 ? 'fail' : missingRate > 0.02 ? 'warn' : 'pass',
        detail: (U.round(missingRate * 100, 2)) + '% of ' + totalSamples + ' values missing'
      },
      {
        id: 'QC-2', name: 'Range test', spec: 'value inside physical limits (WMO guidance)',
        count: totalOut, status: totalOut > 0 ? 'fail' : 'pass',
        detail: totalOut + ' value(s) outside sensor limits'
      },
      {
        id: 'QC-3', name: 'Step test', spec: '|Δ1h| ≤ channel physical maximum',
        count: totalStep, status: totalStep > 3 ? 'fail' : totalStep > 0 ? 'warn' : 'pass',
        detail: totalStep + ' implausible hourly step(s)'
      },
      {
        id: 'QC-4', name: 'Persistence / flatline', spec: 'no run of ≥ 6 identical values',
        count: totalFlat, status: totalFlat > 2 ? 'fail' : totalFlat > 0 ? 'warn' : 'pass',
        detail: totalFlat + ' flatline episode(s)'
      },
      {
        id: 'QC-5', name: 'Internal consistency', spec: 'Td ≤ T, gust ≥ wind, 0 ≤ RH ≤ 100',
        count: inconsistencies, status: inconsistencies > 5 ? 'fail' : inconsistencies > 0 ? 'warn' : 'pass',
        detail: inconsistencies + ' cross-sensor violation(s)'
      },
      {
        id: 'QC-6', name: 'Timestamp integrity', spec: 'strictly increasing, 1 h spacing, no duplicates',
        count: gaps + dups + irregular, status: (gaps + dups) > 0 ? 'fail' : irregular > 0 ? 'warn' : 'pass',
        detail: gaps + ' gap(s), ' + dups + ' duplicate(s), ' + irregular + ' irregular interval(s)'
      },
      {
        id: 'QC-7', name: 'Freshness', spec: 'newest sample ≤ 2 h old',
        count: U.round(ageH, 1), status: ageH > 3 ? 'fail' : ageH > 2 ? 'warn' : 'pass',
        detail: 'newest sample is ' + U.round(ageH, 1) + ' h old'
      }
    ];

    /* ---- composite index from published weights ---- */
    let index = 100;
    const perCheckPenalty = {
      'QC-1': Math.min(WEIGHTS.completeness, missingRate * 100 * 4),
      'QC-2': Math.min(WEIGHTS.range, totalOut * 6),
      'QC-3': Math.min(WEIGHTS.step, totalStep * 2),
      'QC-4': Math.min(WEIGHTS.persistence, totalFlat * 7),
      'QC-5': Math.min(WEIGHTS.consistency, inconsistencies * 3),
      'QC-6': Math.min(WEIGHTS.timestamps, (gaps + dups) * 4)
    };
    Object.keys(perCheckPenalty).forEach(function (k) { index -= perCheckPenalty[k]; });
    index = U.round(U.clamp(index, 0, 100), 1);

    return {
      channels: rows,
      checks: checks,
      overall: {
        score: index,
        grade: grade(index),
        records: n,
        channels: series.channels.length,
        missingRate: missingRate,
        ageHours: U.round(ageH, 1),
        penalties: perCheckPenalty
      }
    };
  }

  AWS.quality = { evaluate: evaluate, grade: grade, WEIGHTS: WEIGHTS };
})(typeof window !== 'undefined' ? window : globalThis);

