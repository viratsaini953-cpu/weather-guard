/* ============================================================
   rules.js — explicit, human-auditable domain rules
   Statistical detectors answer "is this unusual?".
   Rules answer "is this physically possible, and what does it mean?".
   Every rule states its rationale and the corrective action, so a
   station technician can act on the output without a data scientist.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;

  const SEV_ORDER = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

  /* Magnus formula dew point from T (°C) and RH (%) */
  function dewPointFrom(T, RH) {
    const a = 17.62, b = 243.12;
    const alpha = Math.log(RH / 100) + (a * T) / (b + T);
    return (b * alpha) / (a - alpha);
  }

  function mk(id, name, category, severity, rationale, action) {
    return {
      id: id, name: name, category: category, severity: severity,
      rationale: rationale, action: action, hits: [], channels: []
    };
  }

  function hit(rule, series, i, channelKey, text) {
    rule.hits.push({ i: i, t: series.times[i], text: text, channel: channelKey });
    if (channelKey && rule.channels.indexOf(channelKey) < 0) rule.channels.push(channelKey);
  }

  function evaluate(ctx) {
    const series = ctx.series;
    const byKey = ctx.byKey;
    const n = series.times.length;
    const R = [];

    /* ---------- completeness rules ---------- */
    const gapRule = mk('DQ-01', 'Timestamp gap', 'Data quality', 'medium',
      'An AWS logs one record per interval. A gap means records were never stored or transmitted, so time-series statistics over that period are unreliable.',
      'Check the logger buffer and the uplink (GPRS/LoRa) for the affected window before using those hours.');
    const dupRule = mk('DQ-02', 'Duplicate timestamp', 'Data quality', 'medium',
      'Two records with the same timestamp double-count in averages and break rolling windows.',
      'De-duplicate at ingestion, keeping the record with the most complete payload.');
    const missRule = mk('DQ-03', 'Missing values', 'Data quality', 'high',
      'Null values break rolling statistics; if they exceed the acceptance limit the channel cannot be scored for that window.',
      'Inspect the sensor cable and the logger channel configuration, then re-download the payload.');
    const staleRule = mk('DQ-04', 'Stale feed', 'Data quality', 'low',
      'The newest observation is older than two reporting intervals, so the dashboard is showing history, not current conditions.',
      'Verify the station clock and the scheduled upload job.');
    const rangeRule = mk('DQ-05', 'Value outside physical range', 'Data quality', 'critical',
      'No real atmosphere at this site can produce this value; it is a sensor or conversion error.',
      'Recalibrate or replace the sensor; until then exclude the value from climatological aggregates.');
    const stepRule = mk('DQ-06', 'Implausible hourly step', 'Data quality', 'high',
      'A change larger than the physical maximum for one hour is normally a spike, a loose connection or a unit conversion error.',
      'Compare with the neighbouring stations; if isolated, flag the sample as bad rather than deleting the channel.');
    const flatRule = mk('DQ-07', 'Flatline (stuck sensor)', 'Data quality', 'high',
      'A real sensor always shows small fluctuations. Six or more identical readings indicate a frozen value, a blocked intake or a latched ADC.',
      'Power-cycle the sensor, clean the intake/filter, and check for a constant-value bug in the datalogger.');
    const zeroVarRule = mk('DQ-08', 'Zero variance over 24 h', 'Data quality', 'high',
      'Atmospheric pressure always varies slightly over a day; an exactly constant 24-hour series is a frozen barometer.',
      'Verify the pressure sensor and its firmware version.');
    const driftRule = mk('DQ-09', 'Suspected drift / bias', 'Data quality', 'medium',
      'A change over 24 h larger than the plausible maximum for that variable suggests progressive calibration drift, a partly blocked radiation shield or a failing sensor — statistical detectors miss it because the change is gradual.',
      'Schedule a field calibration check against a portable reference and apply a bias correction to the archive.');

    /* ---------- cross-sensor / physics rules ---------- */
    const dewGtT = mk('WX-01', 'Dew point above air temperature', 'Physics', 'critical',
      'Dew point is by definition <= air temperature. A violation means one of the two sensors is wrong (usually a wet or drifted humidity sensor).',
      'Compare both channels with a reference; replace the RH sensor if it reads saturated.');
    const gustLtWind = mk('WX-02', 'Gust below mean wind speed', 'Physics', 'critical',
      'A gust is a short-duration peak, so it cannot be lower than the 10-minute mean it summarises.',
      'Check the anemometer sampling window and the channel mapping in the logger.');
    const dewMismatch = mk('WX-03', 'Dew point inconsistent with T/RH', 'Physics', 'medium',
      'Dew point must satisfy the Magnus relation with temperature and humidity. A mismatch > 2.5 °C means one channel is uncalibrated.',
      'Recompute the dew point from T and RH, then recalibrate the humidity sensor.');
    const precipDry = mk('WX-04', 'Rain reported in dry air', 'Physics', 'high',
      'Measurable rain with very low humidity is usually a tipping-bucket false tip (wind vibration, insect, debris).',
      'Clean the funnel and check the bucket calibration.');
    const saturation = mk('WX-05', 'Persistent saturation', 'Physics', 'medium',
      'Dew point within 0.2 °C of temperature for 12 h with no rain suggests a saturated or waterlogged humidity sensor.',
      'Dry and re-calibrate the RH sensor; inspect the radiation shield.');
    const pressJump = mk('WX-06', 'Rapid pressure change', 'Meteorology', 'info',
      'A 3-hour pressure change above 4 hPa is a real synoptic signal (front, squall, tropical system), not a fault. It is reported so the operator does not confuse it with a barometer error.',
      'No maintenance action. Cross-check against the regional synoptic chart.');
    const tempJump = mk('WX-07', 'Rapid temperature change', 'Meteorology', 'info',
      'Large 3-hour temperature swings can be real (foehn, thunderstorm outflow) or a sensor fault. The rule flags it for review rather than declaring a fault.',
      'Review the hourly curve shape: real events are smooth, faults are single-sample steps.');
    const dirJump = mk('WX-08', 'Wind vane instability', 'Physics', 'medium',
      'A > 150° direction change within one hour at moderate wind speed is usually vane friction or a loose coupling, not a real wind shift.',
      'Service the wind vane bearings and verify the north alignment.');

    /* --- evaluate: completeness --- */
    for (let i = 1; i < n; i++) {
      const dt = series.ts[i] - series.ts[i - 1];
      if (dt <= 0) hit(dupRule, series, i, null, 'Non-increasing timestamp (' + series.times[i] + ')');
      else if (dt > 1.5 * 3600e3) {
        const hours = (dt / 3600e3).toFixed(0);
        hit(gapRule, series, i, null, hours + ' h gap before ' + U.fmtTime(series.times[i]));
      }
    }
    const seen = {};
    series.times.forEach(function (t, i) { if (seen[t] != null) hit(dupRule, series, i, null, 'Duplicate of ' + t); seen[t] = i; });

    series.channels.forEach(function (ch) {
      const vals = ch.values;
      let nulls = 0;
      for (let i = 0; i < vals.length; i++) if (!U.isNum(vals[i])) nulls++;
      const rate = nulls / Math.max(1, vals.length);
      if (rate > 0.02) {
        hit(missRule, series, 0, ch.key, U.round(rate * 100, 1) + '% of ' + ch.short + ' samples are missing (' + nulls + '/' + vals.length + ')');
      }
      for (let i = 0; i < vals.length; i++) {
        const x = vals[i];
        if (U.isNum(x) && (x < ch.min || x > ch.max)) {
          hit(rangeRule, series, i, ch.key, ch.short + ' = ' + U.fmtNum(x, ch.decimals) + ' ' + ch.unit + ' (allowed ' + ch.min + '…' + ch.max + ')');
        }
        if (U.isNum(x) && i > 0 && U.isNum(vals[i - 1])) {
          let d = x - vals[i - 1];
          if (ch.circular) {                       // shortest angular path
            d = ((d % 360) + 540) % 360 - 180;
          }
          if (Math.abs(d) > ch.stepMax) {
            hit(stepRule, series, i, ch.key, ch.short + ' changed ' + U.fmtSigned(d, ch.decimals) + ' ' + ch.unit + ' in 1 h');
          }
        }
      }
      /* flat runs — only for channels that must always fluctuate */
      if (ch.persistence) {
        let run = 1;
        for (let i = 1; i < vals.length; i++) {
          if (U.isNum(vals[i]) && U.isNum(vals[i - 1]) && Math.abs(vals[i] - vals[i - 1]) < 1e-9) run++;
          else run = 1;
          if (run === 6) hit(flatRule, series, i, ch.key, ch.short + ' constant for 6 h at ' + U.fmtNum(vals[i], ch.decimals) + ' ' + ch.unit);
        }
        /* 24 h zero variance */
        for (let i = 24; i < vals.length; i += 24) {
          const win = vals.slice(i - 23, i + 1);
          const v = U.clean(win);
          if (v.length >= 20 && U.sd(v) < 1e-9) {
            hit(zeroVarRule, series, i, ch.key, ch.short + ' had zero variance for 24 h ending ' + U.fmtTime(series.times[i]));
          }
        }
      }

      /* gradual drift: 24 h change beyond the plausible maximum,
         reported once per episode (peak of the running breach) */
      if (ch.driftMax) {
        let inRun = false, peak = null;
        for (let i = 24; i < vals.length; i++) {
          const d = (U.isNum(vals[i]) && U.isNum(vals[i - 24])) ? Math.abs(vals[i] - vals[i - 24]) : 0;
          if (d > ch.driftMax) {
            if (!inRun) { inRun = true; peak = { i: i, d: d }; }
            else if (d > peak.d) peak = { i: i, d: d };
          } else if (inRun) {
            hit(driftRule, series, peak.i, ch.key,
              ch.short + ' moved ' + U.fmtNum(peak.d, ch.decimals) + ' ' + ch.unit + ' in 24 h (limit ' + ch.driftMax + ')');
            inRun = false;
          }
        }
        if (inRun && peak) {
          hit(driftRule, series, peak.i, ch.key,
            ch.short + ' moved ' + U.fmtNum(peak.d, ch.decimals) + ' ' + ch.unit + ' in 24 h (limit ' + ch.driftMax + ')');
        }
      }
    });

    /* --- evaluate: cross-sensor --- */
    const T = byKey.temp.values, RH = byKey.rh.values, TD = byKey.dew.values;
    const WS = byKey.wind.values, GU = byKey.gust.values, PR = byKey.precip.values;
    const P = byKey.press.values, DIR = byKey.windDir.values;

    for (let i = 0; i < n; i++) {
      if (U.isNum(TD[i]) && U.isNum(T[i]) && TD[i] > T[i] + 0.5) {
        hit(dewGtT, series, i, 'dew', 'Dew point ' + U.fmtNum(TD[i], 1) + ' °C > air temp ' + U.fmtNum(T[i], 1) + ' °C');
      }
      if (U.isNum(GU[i]) && U.isNum(WS[i]) && GU[i] < WS[i] - 0.5) {
        hit(gustLtWind, series, i, 'gust', 'Gust ' + U.fmtNum(GU[i], 1) + ' < wind ' + U.fmtNum(WS[i], 1) + ' km/h');
      }
      if (U.isNum(T[i]) && U.isNum(RH[i]) && RH[i] > 1 && RH[i] < 100 && U.isNum(TD[i])) {
        const calc = dewPointFrom(T[i], RH[i]);
        if (Math.abs(calc - TD[i]) > 2.5) {
          hit(dewMismatch, series, i, 'dew', 'Reported ' + U.fmtNum(TD[i], 1) + ' °C vs computed ' + U.fmtNum(calc, 1) + ' °C');
        }
      }
      if (U.isNum(PR[i]) && PR[i] > 0.2 && U.isNum(RH[i]) && RH[i] < 60) {
        hit(precipDry, series, i, 'precip', U.fmtNum(PR[i], 1) + ' mm rain at ' + U.fmtNum(RH[i], 0) + '% RH');
      }
      if (U.isNum(P[i]) && i >= 3 && U.isNum(P[i - 3]) && Math.abs(P[i] - P[i - 3]) > 4) {
        hit(pressJump, series, i, 'press', U.fmtSigned(P[i] - P[i - 3], 1) + ' hPa in 3 h');
      }
      if (U.isNum(T[i]) && i >= 3 && U.isNum(T[i - 3]) && Math.abs(T[i] - T[i - 3]) > 8) {
        hit(tempJump, series, i, 'temp', U.fmtSigned(T[i] - T[i - 3], 1) + ' °C in 3 h');
      }
      if (U.isNum(DIR[i]) && i >= 1 && U.isNum(DIR[i - 1]) && U.isNum(WS[i]) && WS[i] > 20) {
        let d = Math.abs(DIR[i] - DIR[i - 1]);
        d = Math.min(d, 360 - d);
        if (d > 150) hit(dirJump, series, i, 'windDir', d.toFixed(0) + '° direction shift at ' + U.fmtNum(WS[i], 0) + ' km/h');
      }
    }

    /* saturation runs (12 h) */
    let satRun = 0;
    for (let i = 0; i < n; i++) {
      if (U.isNum(T[i]) && U.isNum(TD[i]) && T[i] - TD[i] < 0.2) satRun++; else satRun = 0;
      if (satRun === 12) {
        const rain12 = PR.slice(i - 11, i + 1).reduce(function (s, v) { return s + (U.isNum(v) ? v : 0); }, 0);
        if (rain12 <= 0.5) hit(saturation, series, i, 'rh', 'Dew-point depression < 0.2 °C for 12 h with no rain');
      }
    }

    /* staleness vs. newest sample */
    const lastTs = series.ts[series.ts.length - 1];
    const ageH = (Date.now() - lastTs) / 3600e3;
    if (ageH > 2) {
      hit(staleRule, series, n - 1, null, 'Newest record is ' + ageH.toFixed(0) + ' h old');
    }

    R.push(gapRule, dupRule, missRule, staleRule, rangeRule, stepRule, flatRule, zeroVarRule, driftRule,
      dewGtT, gustLtWind, dewMismatch, precipDry, saturation, pressJump, tempJump, dirJump);

    const fired = R.filter(function (r) { return r.hits.length > 0; }).map(function (r) {
      return {
        id: r.id, name: r.name, category: r.category, severity: r.severity,
        rationale: r.rationale, action: r.action,
        count: r.hits.length, channels: r.channels,
        examples: r.hits.slice(0, 3),
        hitsAll: r.hits.map(function (h) { return h.i; }),
        lastHit: r.hits[r.hits.length - 1]
      };
    }).sort(function (a, b) {
      return (SEV_ORDER[b.severity] - SEV_ORDER[a.severity]) || (b.count - a.count);
    });

    const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: fired.length };
    fired.forEach(function (f) { summary[f.severity]++; });

    return { fired: fired, summary: summary, evaluated: R.length, SEV_ORDER: SEV_ORDER };
  }

  AWS.rules = { evaluate: evaluate, dewPointFrom: dewPointFrom, SEV_ORDER: SEV_ORDER };
})(typeof window !== 'undefined' ? window : globalThis);


