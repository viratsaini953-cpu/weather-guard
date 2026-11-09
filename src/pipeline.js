/* ============================================================
   pipeline.js — the reproducible analysis pipeline
   series -> quality -> features -> detectors -> clustering
          -> rules -> explanations -> result object
   Deterministic: identical input + identical options + same seed
   always produce an identical result (asserted by the test harness).
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;

  function severityFromScore(s) {
    if (s >= 85) return 'critical';
    if (s >= 65) return 'high';
    if (s >= 45) return 'medium';
    return 'low';
  }

  /* Two independent questions:
       severity  — how far outside normal is it?  (score -> critical..low)
       confirmed — do we have deterministic evidence, or is it only a
                   statistical outlier? An impossible value, a missing
                   sample, a frozen sensor or a physics/quality rule is
                   deterministic; a z-score on its own is a review item. */
  function assessFinding(score, dets, cited) {
    const hard = dets.indexOf('range') >= 0 || dets.indexOf('missing') >= 0 || dets.indexOf('flat') >= 0 ||
      (cited || []).some(function (r) { return r.severity === 'critical' || r.severity === 'high'; });
    const sev = severityFromScore(score);
    /* "critical" is reserved for confirmed faults: an unexplained
       statistical outlier is at most a high-priority review item */
    return { severity: hard ? sev : (sev === 'critical' ? 'high' : sev), confirmed: hard };
  }

  function run(series, options) {
    const opts = Object.assign({}, AWS.config.DEFAULT_OPTS, options || {});
    const byKey = {};
    series.channels.forEach(function (c) { byKey[c.key] = c; });

    /* 1. data quality ---------------------------------------------------- */
    const quality = AWS.quality.evaluate(series);

    /* 2. rolling features ------------------------------------------------ */
    const windows = [6, 12, 24];
    if (windows.indexOf(opts.window) < 0) windows.push(opts.window);
    windows.sort(function (a, b) { return a - b; });
    const features = AWS.features.compute(series, windows, opts.model);
    const rows = features.byWindow[opts.window];

    /* 3. univariate detectors -> episodes -------------------------------- */
    const perChannel = {};
    const flagsByKey = {};
    series.channels.forEach(function (ch) {
      const flags = AWS.anomaly.detectChannel(ch, rows[ch.key], opts);
      flagsByKey[ch.key] = flags;
      perChannel[ch.key] = AWS.anomaly.groupEpisodes(ch, flags);
    });

    /* 4. multivariate detector ------------------------------------------ */
    const matrix = AWS.features.buildMatrix(series, features.byWindow, opts);
    const iforest = AWS.anomaly.isolationForest(matrix.X, opts);
    const mvIndices = [];
    iforest.flags.forEach(function (f, i) { if (f) mvIndices.push(i); });

    /* 5. clustering ------------------------------------------------------ */
    const X = matrix.X;
    let clusterModel, kmeta;
    if (opts.k && opts.k >= 2) {
      clusterModel = AWS.cluster.kmeans(X, opts.k, opts.seed, 80);
      kmeta = { k: opts.k, silhouette: AWS.cluster.silhouette(X, clusterModel.labels, opts.k), trials: [] };
    } else {
      const auto = AWS.cluster.autoK(X, opts.seed, 2, 6);
      clusterModel = auto.best.model;
      kmeta = { k: auto.best.k, silhouette: auto.best.silhouette, trials: auto.trials.map(function (t) { return { k: t.k, silhouette: t.silhouette }; }) };
    }
    const pca = AWS.cluster.pca(X);
    const sizes = new Array(kmeta.k).fill(0);
    clusterModel.labels.forEach(function (l) { sizes[l]++; });
    const profiles = AWS.cluster.describe(clusterModel.centroids, matrix.ids, clusterModel.labels, sizes);

    const clusters = {
      k: kmeta.k,
      labels: clusterModel.labels,
      silhouette: U.round(kmeta.silhouette, 3),
      trials: kmeta.trials,
      profiles: profiles,
      pca: pca,
      sizes: sizes
    };

    /* 6. rule engine ----------------------------------------------------- */
    const rules = AWS.rules.evaluate({ series: series, byKey: byKey, opts: opts });

    /* 7. assemble events with explanations ------------------------------- */
    const events = [];
    Object.keys(perChannel).forEach(function (key) {
      const ch = byKey[key];
      perChannel[key].forEach(function (ep, epIdx) {
        const peak = ep.peak;
        const row = rows[key][peak.i];
        const explanation = AWS.explain.explainEvent(ch, row, peak, {
          opts: opts, series: series, rules: rules
        });
        const assessed = assessFinding(ep.maxScore, Object.keys(ep.dets), explanation.citedRules);
        events.push({
          id: key + '-' + ep.start + '-' + epIdx,
          channelKey: key,
          channel: ch.label,
          short: ch.short,
          unit: ch.unit,
          decimals: ch.decimals,
          color: ch.color,
          start: ep.start,
          end: ep.end,
          count: ep.count,
          peakIndex: peak.i,
          time: series.times[peak.i],
          tStart: series.times[ep.start],
          tEnd: series.times[ep.end],
          value: ch.values[peak.i],
          expected: U.round(row.med, ch.decimals),
          z: U.round(peak.z, 2),
          dets: Object.keys(ep.dets),
          score: ep.maxScore,
          severity: assessed.severity,
          confirmed: assessed.confirmed,
          cluster: clusters.labels[peak.i],
          clusterLabel: profiles[clusters.labels[peak.i]] ? profiles[clusters.labels[peak.i]].label : '',
          explanation: explanation
        });
      });
    });
    events.sort(function (a, b) { return b.score - a.score || a.start - b.start; });

    /* 8. summary --------------------------------------------------------- */
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    events.forEach(function (e) { bySeverity[e.severity]++; });
    const channelsAffected = {};
    events.forEach(function (e) { channelsAffected[e.channelKey] = (channelsAffected[e.channelKey] || 0) + 1; });

    const totalSamples = series.times.length * series.channels.length;
    const flaggedSamples = events.reduce(function (s, e) { return s + e.count; }, 0);

    const confirmedCritical = events.filter(function (e) {
      return e.confirmed && (e.severity === 'critical' || e.severity === 'high');
    }).length;
    const confirmedAny = events.filter(function (e) { return e.confirmed; }).length;

    let status = 'healthy';
    if (confirmedCritical > 0 || quality.overall.score < 70) status = 'attention';
    else if (events.length > 0 || quality.overall.score < 88) status = 'watch';

    return {
      meta: Object.assign({}, series.meta, {
        options: opts, generatedAt: new Date().toISOString(), version: AWS.config.VERSION
      }),
      series: series,
      quality: quality,
      features: features,
      matrix: { ids: matrix.ids, X: matrix.X, raw: matrix.raw, medians: matrix.medians, scales: matrix.scales },
      iforest: {
        scores: iforest.scores,
        threshold: U.round(iforest.threshold, 4),
        count: mvIndices.length,
        indices: mvIndices
      },
      flagsByKey: flagsByKey,
      clusters: clusters,
      rules: rules,
      events: events,
      explain: {
        global: AWS.explain.globalImportance(events),
        detectors: AWS.explain.detectorStats(events)
      },
      summary: {
        records: series.times.length,
        events: events.length,
        severity: bySeverity,
        flaggedSamples: flaggedSamples,
        flaggedRate: flaggedSamples / Math.max(1, totalSamples),
        channelsAffected: channelsAffected,
        clusters: clusters.k,
        multivariate: mvIndices.length,
        confirmed: confirmedAny,
        confirmedCritical: confirmedCritical,
        dqScore: quality.overall.score,
        dqGrade: quality.overall.grade,
        status: status
      }
    };
  }

  AWS.pipeline = { run: run, severityFromScore: severityFromScore, assessFinding: assessFinding };
})(typeof window !== 'undefined' ? window : globalThis);





