/* ============================================================
   data.js — ingestion layer
   Live source : Open-Meteo hourly archive/forecast API (no key).
   Fallback    : bundled real snapshot (src/sample-data.js).
   Normalises everything into a single "series" object:
     { meta, times[], ts[], channels[{key,label,unit,values[]}] }
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});
  const U = AWS.util;

  /* Parse "2026-11-07T14:00" as wall-clock time (site local time).
     Avoids browser-timezone shifts when the station is elsewhere. */
  function parseWallClock(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
    if (!m) return new Date(s).getTime();
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0, 0).getTime();
  }

  function num(v) { return (v === null || v === undefined || v === '') ? NaN : Number(v); }

  /* payload -> series. `cutAtNow` drops future hours so the record
     behaves like a real station feed (no forecasting). */
  function normalize(payload, meta) {
    const cfg = AWS.config;
    const hourly = payload.hourly || {};
    const times = (hourly.time || []).slice();

    let cut = times.length;
    if (meta.cutAtNow) {
      const now = Date.now();
      for (let i = 0; i < times.length; i++) {
        if (parseWallClock(times[i]) > now) { cut = i; break; }
      }
    }
    const idx = [];
    for (let i = 0; i < cut; i++) idx.push(i);

    const channels = cfg.CHANNELS.map(function (def) {
      const apiVar = Object.keys(cfg.API_MAP).filter(function (k) { return cfg.API_MAP[k] === def.key; })[0];
      const src = hourly[apiVar] || [];
      return {
        key: def.key, label: def.label, short: def.short, unit: def.unit,
        min: def.min, max: def.max, stepMax: def.stepMax, decimals: def.decimals,
        circular: !!def.circular, skipFeatures: !!def.skipFeatures, color: def.color,
        stat: def.stat !== false, persistence: !!def.persistence, driftMax: def.driftMax,
        floor: def.floor, unitStep: def.unitStep,
        values: idx.map(function (i) { return num(src[i]); })
      };
    });

    const t = idx.map(function (i) { return times[i]; });
    return {
      meta: Object.assign({
        mode: 'live', source: 'Open-Meteo', intervalHours: 1,
        timezone: payload.timezone || 'UTC',
        elevation: payload.elevation,
        latitude: payload.latitude, longitude: payload.longitude,
        fetchedAt: new Date().toISOString()
      }, meta || {}),
      times: t,
      ts: t.map(parseWallClock),
      channels: channels
    };
  }

  function buildUrl(lat, lon) {
    const cfg = AWS.config;
    const params = [
      'latitude=' + encodeURIComponent(lat),
      'longitude=' + encodeURIComponent(lon),
      'hourly=' + cfg.API_VARS.join(','),
      'past_days=7',
      'forecast_days=1',
      'timezone=auto'
    ];
    return cfg.API_BASE + '?' + params.join('&');
  }

  function getJSON(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctrl) ctrl.abort();
        reject(new Error('Request timed out after ' + Math.round(timeoutMs / 1000) + 's'));
      }, timeoutMs);

      const opts = ctrl ? { signal: ctrl.signal, cache: 'no-store' } : {};
      fetch(url, opts).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (j) {
        if (done) return;
        done = true; clearTimeout(timer); resolve(j);
      }).catch(function (e) {
        if (done) return;
        done = true; clearTimeout(timer); reject(e);
      });
    });
  }

  function fetchLive(lat, lon, label) {
    const url = buildUrl(lat, lon);
    return getJSON(url, 15000).then(function (payload) {
      if (!payload || !payload.hourly || !payload.hourly.time) {
        throw new Error('Unexpected response shape from Open-Meteo');
      }
      const s = normalize(payload, {
        mode: 'live', label: label || (lat.toFixed(3) + ', ' + lon.toFixed(3)),
        cutAtNow: true, endpoint: url
      });
      if (s.times.length < 24) throw new Error('Too few hourly observations returned');
      return s;
    });
  }

  function sampleSeries(label) {
    const p = root.AWS_SAMPLE;
    if (!p) throw new Error('No bundled snapshot available');
    return normalize(p, {
      mode: 'sample',
      label: label || ('Offline snapshot — ' + (p.timezone || '')),
      cutAtNow: false,
      fetchedAt: p.fetched_at || null,
      note: p.note || ''
    });
  }

  AWS.data = {
    normalize: normalize,
    buildUrl: buildUrl,
    fetchLive: fetchLive,
    sampleSeries: sampleSeries,
    parseWallClock: parseWallClock
  };
})(typeof window !== 'undefined' ? window : globalThis);

