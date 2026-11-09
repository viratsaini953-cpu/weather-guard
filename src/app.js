/* ============================================================
   app.js — interface controller
   Reads the series, runs the pipeline, paints the dashboard.
   Every visible string goes through t() so the language switch
   repaints the whole page.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = root.AWS;
  const U = AWS.util;
  const C = AWS.config;
  const T = function (k, v) { return AWS.i18n.t(k, v); };
  const $ = function (sel) { return document.querySelector(sel); };
  const CLUSTER_COLORS = ['#1B6B4B', '#2E8B62', '#7FB08F', '#B0700B', '#8A6FB0', '#3F7FA6'];

  /* sensor names, translated (config.js keeps the canonical English) */
  const CH_LABELS = {
    en: { temp: 'Temperature', rh: 'Humidity', dew: 'Dew point', press: 'Pressure', wind: 'Wind speed', windDir: 'Wind direction', gust: 'Wind gust', precip: 'Rain', cloud: 'Cloud cover' },
    hi: { temp: 'तापमान', rh: 'नमी', dew: 'ओसांक', press: 'दबाव', wind: 'हवा की गति', windDir: 'हवा की दिशा', gust: 'झोंका', precip: 'बारिश', cloud: 'बादल' },
    mr: { temp: 'तापमान', rh: 'आर्द्रता', dew: 'दवबिंदू', press: 'दाब', wind: 'वाऱ्याचा वेग', windDir: 'वाऱ्याची दिशा', gust: 'वाऱ्याची झोक', precip: 'पाऊस', cloud: 'ढग' },
    es: { temp: 'Temperatura', rh: 'Humedad', dew: 'Punto de rocío', press: 'Presión', wind: 'Viento', windDir: 'Dirección', gust: 'Racha', precip: 'Lluvia', cloud: 'Nubosidad' },
    ar: { temp: 'الحرارة', rh: 'الرطوبة', dew: 'نقطة الندى', press: 'الضغط', wind: 'سرعة الريح', windDir: 'اتجاه الريح', gust: 'هبة', precip: 'المطر', cloud: 'السحاب' },
    zh: { temp: '气温', rh: '湿度', dew: '露点', press: '气压', wind: '风速', windDir: '风向', gust: '阵风', precip: '降雨', cloud: '云量' }
  };
  function chLabel(key) {
    const d = CH_LABELS[AWS.i18n.lang] || CH_LABELS.en;
    return d[key] || (C.BY_KEY[key] ? C.BY_KEY[key].label : key);
  }

  const state = {
    series: null,
    view: null,
    result: null,
    source: 'live',
    error: null,
    station: C.PRESETS[0],
    opts: {
      window: 12,
      model: 'blend',
      seed: C.DEFAULT_OPTS.seed,
      zThresh: C.DEFAULT_OPTS.zThresh,
      iqrK: C.DEFAULT_OPTS.iqrK,
      ewmaSigma: C.DEFAULT_OPTS.ewmaSigma,
      k: 0,
      injectDemo: false
    },
    tab: 'overview',
    overviewChannel: 'temp',
    filterChannel: '',
    filterSeverity: '',
    validation: null,
    loading: false
  };

  /* ------------------------------------------------------------
     helpers
     ------------------------------------------------------------ */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function chOf(key) { return C.BY_KEY[key] || { label: key, unit: '', decimals: 1 }; }
  function fmtV(v, key) {
    const ch = chOf(key);
    if (!U.isNum(v)) return '—';
    return U.fmtNum(v, ch.decimals) + ' ' + ch.unit;
  }
  function pctText(x) { return (x * 100).toFixed(x >= 0.1 ? 0 : 1) + '%'; }
  function sevPill(sev) { return '<span class="pill ' + sev + '">' + esc(T('sev.' + sev)) + '</span>'; }
  function emptyState(text, hint) {
    return '<div class="empty-state"><img src="assets/img/empty.svg" alt="" />' +
      '<p>' + esc(text) + '</p>' +
      (hint ? '<p class="hint">' + esc(hint) + '</p>' : '') + '</div>';
  }

  function setStatus(text, cls) {
    $('#status-text').textContent = text;
    $('#statusbar').className = 'statusbar' + (cls ? ' ' + cls : '');
  }

  /* ------------------------------------------------------------
     data
     ------------------------------------------------------------ */
  function loadSeries() {
    state.loading = true;
    setStatus('…', '');
    const preset = state.station;
    return AWS.data.fetchLive(preset.lat, preset.lon, preset.name)
      .then(function (s) {
        state.series = s; state.source = 'live'; state.error = null; return s;
      })
      .catch(function (err) {
        state.source = 'fallback';
        state.error = err && err.message ? err.message : String(err);
        state.series = AWS.data.sampleSeries(preset.name);
        return state.series;
      })
      .then(function (s) { state.loading = false; return s; });
  }

  function recompute() {
    if (!state.series) return;
    const input = state.opts.injectDemo ? AWS.faults.demo(state.series, 777) : state.series;
    state.view = input;
    state.result = AWS.pipeline.run(input, {
      window: state.opts.window,
      model: state.opts.model,
      seed: state.opts.seed,
      zThresh: state.opts.zThresh,
      iqrK: state.opts.iqrK,
      ewmaSigma: state.opts.ewmaSigma,
      k: state.opts.k
    });
  }

  /* ------------------------------------------------------------
     page head
     ------------------------------------------------------------ */
  const PAGE_KEY = {
    overview: 'home', quality: 'quality', anomalies: 'problems',
    patterns: 'patterns', rules: 'rules', validation: 'validation', about: 'about'
  };
  function renderPageHead() {
    const k = PAGE_KEY[state.tab] || 'home';
    $('#page-title').textContent = T('page.' + k + '.title');
    $('#page-sub').textContent = T('page.' + k + '.sub');
    document.title = T('page.' + k + '.title') + ' · ' + T('brand.name');
  }

  /* ============================================================
     OVERVIEW
     ============================================================ */
  function renderHero() {
    const r = state.result, s = r.summary, dq = r.quality.overall;
    const st = s.status;

    const title = st === 'healthy' ? T('hero.healthy.title') : st === 'watch' ? T('hero.watch.title') : T('hero.attention.title');
    const body = st === 'healthy'
      ? T('hero.healthy.body', { records: s.records })
      : st === 'watch'
        ? T('hero.watch.body', { events: s.events })
        : T('hero.attention.body', { faults: s.confirmedCritical });

    const action = st === 'healthy' ? T('hero.action.none')
      : st === 'watch' ? T('hero.action.watch') : T('hero.action.fault');

    const badgeClass = st === 'healthy' ? 'good' : st === 'watch' ? 'warn' : 'bad';
    const dot = st === 'healthy' ? '#7BE0AE' : st === 'watch' ? '#FFD08A' : '#FFB4B4';

    $('#hero').innerHTML =
      '<div class="hero-left">' +
        '<span class="hero-badge"><i style="background:' + dot + '"></i>' + esc(T('status.' + st)) + '</span>' +
        '<div class="hero-kicker">' + esc(T('hero.kicker')) + '</div>' +
        '<h2>' + esc(title) + '</h2>' +
        '<p class="hero-body">' + esc(body) + '</p>' +
        '<div class="hero-score"><b>' + Math.round(dq.score) + '</b><span>' + esc(T('hero.score')) + ' · ' + esc(T('hero.of')) + '</span></div>' +
        '<div class="hero-action"><b>' + esc(T('hero.action')) + '</b><span>' + esc(action) + '</span></div>' +
      '</div>' +
      '<div>' +
        '<div class="hero-img-wrap"><img class="hero-img" src="assets/img/station-hero.svg" alt="" /></div>' +
        '<div class="hero-cap">' + esc(T('hero.caption')) + '</div>' +
      '</div>';
  }

  function kpiCard(label, value, sub, primary, small) {
    return '<div class="kpi' + (primary ? ' primary' : '') + '">' +
      '<div class="k-label">' + esc(label) + '</div>' +
      '<div class="k-value">' + value + (small ? '<small>' + esc(small) + '</small>' : '') + '</div>' +
      '<div class="k-sub">' + esc(sub) + '</div></div>';
  }

  function renderKpis() {
    const s = state.result.summary, dq = state.result.quality.overall;
    const passed = state.result.quality.checks.filter(function (c) { return c.status === 'pass'; }).length;
    const last = state.view.times[state.view.times.length - 1];

    $('#kpis').innerHTML =
      kpiCard(T('kpi.hours'), s.records, U.fmtTime(last), true) +
      kpiCard(T('kpi.flagged'), s.flaggedSamples, T('kpi.flagged.sub', { pct: pctText(s.flaggedRate) })) +
      kpiCard(T('kpi.quality'), Math.round(dq.score), T('kpi.quality.sub', { grade: dq.grade, passed: passed })) +
      kpiCard(T('kpi.patterns'), s.clusters, T('kpi.patterns.sub', { v: state.result.clusters.silhouette }));
  }

  function channelOptions(selected) {
    const src = state.view || state.series;
    const list = (src && src.channels) ? src.channels : C.CHANNELS;
    return list.map(function (c) {
      return '<option value="' + c.key + '"' + (c.key === selected ? ' selected' : '') + '>' + esc(chLabel(c.key)) + '</option>';
    }).join('');
  }

  function seriesForChart(key) {
    const r = state.result;
    const rows = r.features.byWindow[state.opts.window][key];
    const bandLo = [], bandHi = [];
    rows.forEach(function (row) {
      if (U.isNum(row.pred) && U.isNum(row.rScale)) {
        bandLo.push(row.pred - state.opts.zThresh * row.rScale);
        bandHi.push(row.pred + state.opts.zThresh * row.rScale);
      } else { bandLo.push(NaN); bandHi.push(NaN); }
    });
    const markers = r.events.filter(function (e) { return e.channelKey === key; }).map(function (e) {
      return {
        i: e.peakIndex,
        color: e.severity === 'critical' ? '#C43C3C' : e.severity === 'high' ? '#DD7A22' : '#C99A22',
        label: T('sev.' + e.severity) + ' · ' + e.score
      };
    });
    return { rows: rows, bandLo: bandLo, bandHi: bandHi, markers: markers, ch: chOf(key) };
  }

  function renderOverviewChart() {
    const key = state.overviewChannel;
    const sd = seriesForChart(key);
    const ch = chOf(key);
    const values = state.view.channels.filter(function (c) { return c.key === key; })[0].values;
    AWS.charts.line($('#overview-chart'), {
      times: state.view.times,
      values: values,
      band: { lo: sd.bandLo, hi: sd.bandHi },
      markers: sd.markers,
      color: ch.color,
      unit: ch.unit,
      decimals: ch.decimals,
      label: chLabel(key),
      height: 320,
      emptyText: T('st.missing')
    });
  }

  function renderLatest() {
    const r = state.result;
    const i = state.view.times.length - 1;
    const rows = state.view.channels.map(function (ch) {
      const v = ch.values[i];
      const flags = r.flagsByKey[ch.key];
      const f = flags ? flags[i] : null;
      const prev = ch.values[i - 1];
      let delta = (U.isNum(v) && U.isNum(prev)) ? v - prev : NaN;
      if (U.isNum(delta) && ch.circular) delta = ((delta % 360) + 540) % 360 - 180;

      let status = '<span class="pill pass">' + esc(T('st.ok')) + '</span>';
      if (!U.isNum(v)) status = '<span class="pill fail">' + esc(T('st.missing')) + '</span>';
      else if (f && f.flag) status = '<span class="pill ' + (f.score >= 70 ? 'fail' : 'warn') + '">' + esc(T('st.flagged')) + '</span>';

      return '<tr><td>' + esc(chLabel(ch.key)) + '</td>' +
        '<td class="num mono">' + (U.isNum(v) ? U.fmtNum(v, ch.decimals) + ' ' + ch.unit : '—') + '</td>' +
        '<td class="num mono">' + (U.isNum(delta) ? U.fmtSigned(delta, ch.decimals) : '—') + '</td>' +
        '<td>' + status + '</td></tr>';
    }).join('');

    $('#latest-table').innerHTML =
      '<table><thead><tr><th>' + esc(T('th.sensor')) + '</th><th class="num">' + esc(T('th.now')) + '</th>' +
      '<th class="num">' + esc(T('th.change')) + '</th><th>' + esc(T('th.status')) + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function findingHTML(ev) {
    const ch = chOf(ev.channelKey);
    return '<div class="finding ' + ev.severity + '">' +
      '<div class="f-top"><span class="f-title">' + esc(chLabel(ev.channelKey)) + ' · ' + fmtV(ev.value, ev.channelKey) + '</span>' + sevPill(ev.severity) + '</div>' +
      '<div class="f-meta">' + U.fmtTime(ev.time) + ' · ' + esc(T('a.expected')) + ' ' +
      U.fmtNum(ev.expected, ch.decimals) + ' ' + ch.unit + ' · ' +
      (ev.confirmed ? '<b style="color:var(--bad)">' + esc(T('short.confirmed')) + '</b>' : esc(T('short.review'))) + '</div>' +
      '<div class="f-why">' + esc(ev.explanation ? ev.explanation.narrative : '') + '</div>' +
      '</div>';
  }

  function renderTopFindings() {
    const events = state.result.events.slice(0, 5);
    const host = $('#top-findings');
    if (!events.length) {
      host.innerHTML = emptyState(T('a.none'), T('a.noneHint'));
      return;
    }
    host.innerHTML = events.map(findingHTML).join('');
    host.querySelectorAll('.finding').forEach(function (n) {
      n.addEventListener('click', function () { n.classList.toggle('open'); });
    });
  }

  /* ==== part 2 continues below ==== */

  /* verdict words for the quality table */
  const VERDICT = {
    en: { pass: 'pass', warn: 'watch', fail: 'fail' },
    hi: { pass: 'पास', warn: 'ध्यान', fail: 'फेल' },
    mr: { pass: 'उत्तीर्ण', warn: 'लक्ष', fail: 'अनुत्तीर्ण' },
    es: { pass: 'bien', warn: 'revisar', fail: 'mal' },
    ar: { pass: 'سليم', warn: 'تحت المراقبة', fail: 'خلل' },
    zh: { pass: '通过', warn: '注意', fail: '未通过' }
  };
  function verdictWord(s) {
    const d = VERDICT[AWS.i18n.lang] || VERDICT.en;
    return d[s] || s;
  }

  /* ============================================================
     QUALITY
     ============================================================ */
  const QC_WORD = {
    en: { 'QC-1': 'Completeness', 'QC-2': 'Range', 'QC-3': 'Step', 'QC-4': 'Persistence', 'QC-5': 'Consistency', 'QC-6': 'Timestamps' },
    hi: { 'QC-1': 'पूर्णता', 'QC-2': 'सीमा', 'QC-3': 'उछाल', 'QC-4': 'स्थिरता', 'QC-5': 'मेल', 'QC-6': 'समय' },
    mr: { 'QC-1': 'पूर्णता', 'QC-2': 'मर्यादा', 'QC-3': 'उडी', 'QC-4': 'स्थिरता', 'QC-5': 'सुसंगती', 'QC-6': 'वेळ' },
    es: { 'QC-1': 'Completitud', 'QC-2': 'Rango', 'QC-3': 'Saltos', 'QC-4': 'Persistencia', 'QC-5': 'Coherencia', 'QC-6': 'Marcas de tiempo' },
    ar: { 'QC-1': 'الاكتمال', 'QC-2': 'المدى', 'QC-3': 'القفزات', 'QC-4': 'الثبات', 'QC-5': 'الاتساق', 'QC-6': 'التوقيت' },
    zh: { 'QC-1': '完整性', 'QC-2': '范围', 'QC-3': '跳变', 'QC-4': '冻结', 'QC-5': '一致性', 'QC-6': '时间戳' }
  };
  function qcWord(id) {
    const d = QC_WORD[AWS.i18n.lang] || QC_WORD.en;
    return d[id] || QC_WORD.en[id] || id;
  }

  function renderQuality() {
    const q = state.result.quality;
    const o = q.overall;
    const worst = q.checks.slice().sort(function (a, b) {
      const rank = { fail: 0, warn: 1, pass: 2 };
      return rank[a.status] - rank[b.status];
    })[0];
    const cls = o.score >= 90 ? 'good' : o.score >= 70 ? 'warn' : 'bad';

    $('#dq-hero').innerHTML =
      '<div class="s-label">' + esc(T('q.index')) + '</div>' +
      '<div class="s-value"><b>' + o.score.toFixed(0) + '</b><span>/ 100 · ' + esc(T('q.grade')) + ' ' + o.grade + '</span></div>' +
      '<div class="badge ' + cls + '">' + esc(worst.status === 'pass' ? T('status.healthy') : verdictWord(worst.status) + ' · ' + worst.name) + '</div>' +
      '<p class="hint">' + esc(T('q.summary', { n: o.records, ch: o.channels, pct: o.missingRate.toFixed(2), h: o.ageHours })) + '</p>';

    $('#dq-explain').textContent = T('q.how.body');

    AWS.charts.bars($('#dq-penalties'), {
      items: Object.keys(o.penalties).map(function (k) {
        return { label: qcWord(k), value: o.penalties[k], display: '−' + U.fmtNum(o.penalties[k], 1) };
      }),
      max: 30
    });

    $('#qc-table').innerHTML =
      '<table><thead><tr><th>' + esc(T('th.test')) + '</th><th>' + esc(T('th.rule')) + '</th>' +
      '<th>' + esc(T('th.result')) + '</th><th class="num">' + esc(T('th.count')) + '</th><th>' + esc(T('th.verdict')) + '</th></tr></thead><tbody>' +
      q.checks.map(function (c) {
        return '<tr><td><b>' + c.id + '</b></td><td class="hint" style="margin:0">' + esc(c.spec) + '</td>' +
          '<td>' + esc(c.detail) + '</td><td class="num mono">' + c.count + '</td>' +
          '<td><span class="pill ' + c.status + '">' + esc(verdictWord(c.status)) + '</span></td></tr>';
      }).join('') + '</tbody></table>';

    $('#channel-scores').innerHTML =
      '<table><thead><tr><th>' + esc(T('th.sensor')) + '</th><th class="num">' + esc(T('th.valid')) + '</th>' +
      '<th class="num">' + esc(T('th.missing')) + '</th><th class="num">' + esc(T('th.oor')) + '</th>' +
      '<th class="num">' + esc(T('th.steps')) + '</th><th class="num">' + esc(T('th.flat')) + '</th>' +
      '<th style="width:140px">' + esc(T('th.score')) + '</th></tr></thead><tbody>' +
      q.channels.map(function (c) {
        const color = c.score >= 90 ? '#1B6B4B' : c.score >= 70 ? '#C99A22' : '#C43C3C';
        return '<tr><td>' + esc(chLabel(c.key)) + ' <span class="hint">' + c.unit + '</span></td>' +
          '<td class="num mono">' + c.valid + '</td><td class="num mono">' + c.missing + '</td>' +
          '<td class="num mono">' + c.outOfRange + '</td><td class="num mono">' + c.stepViolations + '</td>' +
          '<td class="num mono">' + c.flatEpisodes + '</td>' +
          '<td><div class="bar-row" style="grid-template-columns:1fr 44px"><div class="bar-track"><div class="bar-fill" style="width:' + c.score + '%;background:' + color + '"></div></div>' +
          '<div class="bar-value">' + c.score + '</div></div></td></tr>';
      }).join('') + '</tbody></table>';

    renderHeatmap();
  }

  function renderHeatmap() {
    const r = state.result;
    const rows = state.view.channels.map(function (ch) {
      const flags = r.flagsByKey[ch.key] || [];
      return {
        label: chLabel(ch.key),
        values: ch.values.map(function (v, i) {
          if (!U.isNum(v)) return 2;
          const f = flags[i];
          if (f && f.flag) return f.score >= 70 ? 2 : 1;
          return 0;
        })
      };
    });
    AWS.charts.heatmap($('#heatmap'), { rows: rows, cols: state.view.times });
  }

  /* ============================================================
     PROBLEMS
     ============================================================ */
  function renderAnomalies() {
    const r = state.result;

    $('#filter-channel').innerHTML = '<option value="">' + esc(T('a.allSensors')) + '</option>' +
      state.view.channels.map(function (c) {
        return '<option value="' + c.key + '"' + (c.key === state.filterChannel ? ' selected' : '') + '>' + esc(chLabel(c.key)) + '</option>';
      }).join('');

    $('#filter-severity').innerHTML = '<option value="">' + esc(T('a.allLevels')) + '</option>' +
      ['critical', 'high', 'medium', 'low'].map(function (s) {
        return '<option value="' + s + '"' + (s === state.filterSeverity ? ' selected' : '') + '>' + esc(T('sev.' + s)) + '</option>';
      }).join('');

    const chartKey = state.filterChannel || state.overviewChannel;
    const sd = seriesForChart(chartKey);
    const ch = chOf(chartKey);
    const values = state.view.channels.filter(function (c) { return c.key === chartKey; })[0].values;
    AWS.charts.line($('#anomaly-chart'), {
      times: state.view.times,
      values: values,
      band: { lo: sd.bandLo, hi: sd.bandHi },
      markers: sd.markers,
      color: ch.color,
      unit: ch.unit,
      decimals: ch.decimals,
      label: chLabel(chartKey),
      height: 260,
      emptyText: T('st.missing')
    });

    const list = r.events.filter(function (e) {
      if (state.filterChannel && e.channelKey !== state.filterChannel) return false;
      if (state.filterSeverity && e.severity !== state.filterSeverity) return false;
      return true;
    });

    if (!list.length) {
      $('#anomaly-list').innerHTML = emptyState(T('a.none'), T('a.noneHint'));
    } else {
      const rowsHtml = list.map(function (e) {
        return '<div class="anomaly-row">' +
          '<div class="anomaly-head">' +
          '<span class="a-when">' + U.fmtTime(e.time) + '</span>' +
          '<span class="a-chan">' + esc(chLabel(e.channelKey)) + '</span>' +
          '<span class="a-val mono">' + fmtV(e.value, e.channelKey) + '</span>' +
          '<span>' + sevPill(e.severity) + '</span>' +
          '<span class="a-det hint" style="margin:0">' + (e.confirmed ? esc(T('short.confirmed')) : esc(T('short.review'))) +
          ' · ' + e.dets.length + ' ' + esc(T('a.checks')) + ' · ' + e.score + '</span>' +
          '<span class="chev">›</span>' +
          '</div>' +
          '<div class="anomaly-body">' + eventBody(e) + '</div>' +
          '</div>';
      }).join('');

      $('#anomaly-list').innerHTML =
        '<div class="anomaly-list-block">' +
        '<div class="anomaly-header"><span>' + esc(T('a.time')) + '</span><span>' + esc(T('a.sensor')) + '</span>' +
        '<span>' + esc(T('a.value')) + '</span><span>' + esc(T('a.level')) + '</span>' +
        '<span>' + esc(T('a.evidence')) + '</span><span></span></div>' +
        rowsHtml + '</div>';

      $('#anomaly-list').querySelectorAll('.anomaly-head').forEach(function (head) {
        head.addEventListener('click', function () { head.parentElement.classList.toggle('open'); });
      });
    }

    const mv = r.iforest.indices;
    $('#multivariate-list').innerHTML = mv.length
      ? mv.map(function (i) {
        return '<span class="chip"><b>' + U.fmtTime(state.view.times[i]) + '</b> · ' + U.fmtNum(r.iforest.scores[i], 2) + '</span>';
      }).join('')
      : emptyState(T('a.none'));
  }

  function eventBody(e) {
    const ex = e.explanation || {};
    const ch = chOf(e.channelKey);
    const contrib = (ex.contributions || []).map(function (c) {
      return '<div class="c-row"><span>' + esc(c.label) + '</span>' +
        '<span class="c-track"><span class="c-fill" style="width:' + Math.min(100, c.pct) + '%"></span></span>' +
        '<span class="c-pct">' + Math.round(c.pct) + '%</span></div>';
    }).join('');

    const rules = (ex.citedRules || []).map(function (rr) {
      return '<span class="chip"><b>' + rr.id + '</b> ' + esc(rr.name) + '</span>';
    }).join('');

    return '<div class="explain-grid"><div>' +
      '<div class="hint" style="margin-bottom:4px">' + esc(T('a.why')) + '</div>' +
      '<p class="narrative">' + esc(ex.narrative || '') + '</p>' +
      '<div class="kv"><b>' + esc(T('a.clear')) + ':</b>&nbsp;' + esc(ex.counterfactual || '—') + '</div>' +
      (rules ? '<div class="kv" style="flex-wrap:wrap;margin-top:10px"><b>' + esc(T('a.rules')) + ':</b>&nbsp;' + rules + '</div>' : '') +
      '</div><div>' +
      '<div class="hint" style="margin-bottom:4px">' + esc(T('r.imp.title')) + '</div>' +
      '<div class="contrib">' + contrib + '</div>' +
      '<div class="kv"><b>' + esc(T('a.confidence')) + ':</b>&nbsp;' + esc(ex.confidence || '—') + ' · ' + e.dets.length + '</div>' +
      '<div class="kv"><b>' + esc(T('a.expected')) + ':</b>&nbsp;' + U.fmtNum(e.expected, ch.decimals) + ' ' + ch.unit +
      ' &nbsp;·&nbsp; <b>' + esc(T('a.z')) + ':</b>&nbsp;' + (U.isNum(e.z) ? e.z.toFixed(2) : '—') + '</div>' +
      '<div class="kv"><b>' + esc(T('a.group')) + ':</b>&nbsp;' + esc(e.clusterLabel || '—') + '</div>' +
      '</div></div>';
  }

  /* ==== part 3 continues below ==== */

  /* ============================================================
     PATTERNS
     ============================================================ */
  const GROUP_WORD = { en: 'Group', hi: 'समूह', mr: 'गट', es: 'Grupo', ar: 'المجموعة', zh: '分组' };
  function groupWord() { return GROUP_WORD[AWS.i18n.lang] || GROUP_WORD.en; }

  function renderPatterns() {
    const r = state.result;
    const cl = r.clusters;
    const flagged = {};
    r.events.forEach(function (e) { flagged[e.peakIndex] = true; });

    const points = cl.pca.coords.map(function (xy, i) {
      const lab = cl.labels[i];
      return {
        x: xy[0], y: xy[1],
        color: CLUSTER_COLORS[lab % CLUSTER_COLORS.length],
        flagged: !!flagged[i],
        label: U.fmtTime(state.view.times[i]) + ' · ' + groupWord() + ' ' + (lab + 1)
      };
    });

    AWS.charts.scatter($('#cluster-plot'), {
      points: points,
      xLabel: 'PC 1 (' + Math.round(cl.pca.explained[0] * 100) + '%)',
      yLabel: 'PC 2',
      height: 350
    });

    $('#cluster-legend').innerHTML = cl.profiles.map(function (p) {
      return '<div class="profile">' +
        '<div class="p-name"><span class="p-dot" style="background:' + CLUSTER_COLORS[p.index % CLUSTER_COLORS.length] + '"></span>' +
        groupWord() + ' ' + (p.index + 1) + '</div>' +
        '<div class="p-size">' + esc(T('p.hours', { n: p.size })) + ' · ' +
        Math.round(p.size / state.view.times.length * 100) + '%</div>' +
        '</div>';
    }).join('');

    $('#cluster-profiles').innerHTML = cl.profiles.map(function (p) {
      const sig = (p.signature || []).slice(0, 4).map(function (sg) {
        const channelKey = String(sg.id).replace(/^rz_/, '').replace(/^d1_/, '').replace(/^range_/, '');
        const name = chLabel(channelKey) || sg.id;
        return '<code>' + esc(name) + ' ' + (sg.sd > 0 ? '+' : '') + sg.sd + '</code>';
      }).join(' ');
      return '<div class="profile">' +
        '<div class="p-name"><span class="p-dot" style="background:' + CLUSTER_COLORS[p.index % CLUSTER_COLORS.length] + '"></span>' +
        groupWord() + ' ' + (p.index + 1) + '</div>' +
        '<div class="p-size">' + esc(T('p.hours', { n: p.size })) + '</div>' +
        '<div class="p-sig">' + sig + '</div></div>';
    }).join('');

    const trials = cl.trials && cl.trials.length ? cl.trials : [{ k: cl.k, silhouette: cl.silhouette }];
    AWS.charts.bars($('#silhouette'), {
      items: trials.map(function (t) {
        return {
          label: 'k = ' + t.k + (t.k === cl.k ? ' ✓' : ''),
          value: Math.max(0, t.silhouette),
          display: U.fmtNum(t.silhouette, 3),
          color: t.k === cl.k ? '#1B6B4B' : '#A9C9B6'
        };
      }),
      max: Math.max.apply(null, trials.map(function (t) { return t.silhouette; }).concat([0.1]))
    });
  }

  /* ============================================================
     RULES
     ============================================================ */
  const CAT_KEY = { 'Data quality': 'data-quality', 'Physics': 'physics', 'Meteorology': 'meteorology', 'Stability': 'stability' };

  function renderRules() {
    const r = state.result;
    const fired = r.rules.fired;

    $('#rules-list').innerHTML = fired.length ? fired.map(function (rr) {
      const cat = CAT_KEY[rr.category] ? T('cat.' + CAT_KEY[rr.category]) : rr.category;
      return '<div class="rule">' +
        '<div class="r-head"><span class="r-id">' + rr.id + '</span>' +
        '<span class="r-name">' + esc(rr.name) + '</span>' + sevPill(rr.severity) +
        '<span class="pill neutral">' + esc(cat) + '</span>' +
        '<span class="r-count">' + esc(rr.count === 1 ? '1×' : T('r.times', { n: rr.count })) + '</span></div>' +
        '<p>' + esc(rr.rationale) + '</p>' +
        '<div class="r-action"><b>' + esc(T('r.action')) + ':</b> ' + esc(rr.action) + '</div>' +
        '<div class="r-ex">' + rr.examples.map(function (x) {
          return '<span>' + U.fmtTime(x.t) + ' — ' + esc(x.text) + '</span>';
        }).join('') + '</div>' +
        '</div>';
    }).join('') : emptyState(T('r.none'));

    const imp = r.explain.global;
    AWS.charts.bars($('#importance'), {
      items: imp.length ? imp.map(function (i) {
        return { label: i.label, value: i.pct, display: Math.round(i.pct) + '%' };
      }) : [{ label: T('r.noneShort'), value: 0, display: '—' }],
      max: 100
    });

    const ds = r.explain.detectors;
    AWS.charts.bars($('#detector-stats'), {
      items: ds.length ? ds.map(function (d) {
        return { label: d.name, value: d.count, display: d.count + '×' };
      }) : [{ label: T('r.noneShort'), value: 0, display: '—' }],
      max: Math.max.apply(null, ds.map(function (d) { return d.count; }).concat([1]))
    });
  }

  /* ============================================================
     VALIDATION
     ============================================================ */
  function renderFaultTypes() {
    $('#fault-types').innerHTML =
      '<table><thead><tr><th>' + esc(T('v.th.fault')) + '</th><th>' + esc(T('v.th.detector')) + '</th></tr></thead><tbody>' +
      AWS.faults.TYPES.map(function (t) {
        return '<tr><td><b>' + esc(t.name) + '</b> ' + sevPill(t.severity) + '</td>' +
          '<td>' + esc(t.expected) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  function runValidation() {
    const btn = $('#run-validation');
    if (!state.series || !state.result) return;      // data still loading
    btn.disabled = true;
    btn.textContent = T('v.running');
    $('#validation-body').innerHTML = '<div class="placeholder">' + esc(T('v.running')) + '</div>';

    setTimeout(function () {
      const rep = AWS.faults.run(state.series, {
        window: state.opts.window,
        model: state.opts.model,
        zThresh: state.opts.zThresh,
        iqrK: state.opts.iqrK,
        ewmaSigma: state.opts.ewmaSigma,
        seed: state.opts.seed
      });
      state.validation = rep;
      renderValidation(rep);
      btn.disabled = false;
      btn.textContent = T('v.rerun');
    }, 40);
  }

  function renderValidation(rep) {
    const t = rep.totals;
    const verdict = t.pass
      ? '<div class="verdict pass"><b>' + esc(T('v.passTitle')) + '</b> — ' +
      esc(T('v.passBody', { r: pctText(t.recall), p: pctText(t.precision), f: U.fmtNum(t.f1, 2) })) + '</div>'
      : '<div class="verdict fail"><b>' + esc(T('v.failTitle')) + '</b> — ' +
      esc(T('v.failBody', { r: pctText(t.recall), p: pctText(t.precision), f: U.fmtNum(t.f1, 2) })) + '</div>';

    const metrics = '<div class="metrics">' +
      metric(T('v.recall'), pctText(t.recall), t.tp + ' / ' + (t.tp + t.fn)) +
      metric(T('v.precision'), pctText(t.precision), t.tp + ' / ' + (t.tp + t.fp)) +
      metric(T('v.f1'), U.fmtNum(t.f1, 2), 'F1') +
      metric(T('v.types'), rep.byType.length, T('v.typesSub', { seed: rep.seed, n: rep.trials.length })) +
      '</div>';

    const rows = rep.byType.map(function (b) {
      const okR = b.recall >= 0.85, okF = b.f1 >= 0.85;
      const verdictPill = (okR && okF)
        ? '<span class="pill pass">' + esc(T('v.meets')) + '</span>'
        : '<span class="pill fail">' + esc(T('v.below')) + '</span>' +
          (okR ? ' <span class="hint">F1 ' + U.fmtNum(b.f1, 2) + '</span>' : '');
      return '<tr><td><b>' + esc(b.name) + '</b></td>' +
        '<td class="hint" style="margin:0">' + esc(b.expected) + '</td>' +
        '<td class="num mono">' + b.tp + ' / ' + (b.tp + b.fn) + '</td>' +
        '<td class="num mono">' + pctText(b.recall) + '</td>' +
        '<td class="num mono">' + pctText(b.precision) + '</td>' +
        '<td class="num mono">' + U.fmtNum(b.f1, 2) + '</td>' +
        '<td class="num mono">' + (b.latency == null ? '—' : b.latency + ' h') + '</td>' +
        '<td>' + verdictPill + '</td></tr>';
    }).join('');

    $('#validation-body').innerHTML = verdict + metrics +
      '<div class="table-wrap"><table><thead><tr><th>' + esc(T('v.th.fault')) + '</th><th>' + esc(T('v.th.detector')) + '</th>' +
      '<th class="num">' + esc(T('v.th.found')) + '</th><th class="num">Recall</th><th class="num">Precision</th><th class="num">F1</th>' +
      '<th class="num">Latency</th><th>' + esc(T('v.th.verdict')) + '</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      '<div class="hint" style="margin-top:14px">' + esc(T('v.method')) + ' ' + esc(T('v.method2')) + '</div>';
  }

  function metric(label, value, sub) {
    return '<div class="metric"><div class="m-label">' + esc(label) + '</div><div class="m-value">' + value + '</div><div class="m-sub">' + esc(sub) + '</div></div>';
  }

  /* ============================================================
     ABOUT
     ============================================================ */
  function renderAbout() {
    const m = state.result.meta;
    $('#about-source').innerHTML =
      esc(T('about.source')) + ': <b>' + esc(state.source === 'live' ? 'Open-Meteo (live)' : 'Open-Meteo (saved copy)') + '</b> · ' +
      esc(m.label || '') + ' (' + U.fmtNum(m.latitude, 3) + ', ' + U.fmtNum(m.longitude, 3) + ') · ' +
      esc(m.timezone || '') + ' · ' + state.view.times.length + ' h · ' +
      U.fmtTime(state.view.times[0]) + ' → ' + U.fmtTime(state.view.times[state.view.times.length - 1]) +
      (state.error ? '<br><span class="pill warn">' + esc(state.error) + '</span>' : '');
  }

  /* ============================================================
     RENDER ALL
     ============================================================ */
  function renderAll() {
    if (!state.result) return;
    const s = state.result.summary;
    renderPageHead();
    AWS.i18n.applyStatic();

    const text = (state.source === 'live' ? T('status.live') : T('status.offline')) + ' · ' +
      (state.result.meta.label || '') + ' · ' + s.records + ' h · ' +
      U.fmtTime(state.view.times[state.view.times.length - 1]) +
      (state.opts.injectDemo ? ' · ' + T('demo.on') : '');
    setStatus(text, s.status === 'healthy' ? '' : s.status);

    $('#overview-channel').innerHTML = channelOptions(state.overviewChannel);
    renderHero();
    renderKpis();
    renderOverviewChart();
    renderLatest();
    renderTopFindings();

    renderQuality();
    renderAnomalies();
    renderPatterns();
    renderRules();
    renderFaultTypes();
    renderAbout();
    if (state.validation) renderValidation(state.validation);

    $('#footer-meta').textContent =
      s.records + ' h · ' + T('footer.window', { w: state.opts.window }) + ' · ' + T('footer.seed', { s: state.opts.seed });
  }

  /* ============================================================
     EVENTS
     ============================================================ */
  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll('.nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.promo-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.goto === name);
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-' + name);
    });
    renderPageHead();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function refresh() {
    recompute();
    $('#run-validation').disabled = false;
    renderAll();
    state.validation = null;
    $('#validation-body').innerHTML = '<div class="placeholder">' + esc(T('v.placeholder')) + '</div>';
  }

  function buildLanguageSelect() {
    const sel = $('#language');
    sel.innerHTML = AWS.i18n.LANGS.map(function (l) {
      return '<option value="' + l.code + '">' + l.native + '</option>';
    }).join('');
    sel.value = AWS.i18n.lang;
  }

  function init() {
    buildLanguageSelect();

    $('#station').innerHTML = C.PRESETS.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.name) + '</option>';
    }).join('');

    $('#overview-channel').innerHTML = channelOptions(state.overviewChannel);

    document.querySelectorAll('.nav button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });
    document.querySelectorAll('.promo-btn').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.goto); });
    });

    $('#language').addEventListener('change', function (e) {
      AWS.i18n.setLang(e.target.value, true);
      renderAll();
    });

    $('#station').addEventListener('change', function (e) {
      state.station = C.PRESETS.filter(function (p) { return p.id === e.target.value; })[0] || C.PRESETS[0];
      loadSeries().then(refresh).catch(function (err) {
        setStatus('Error: ' + err.message, 'attention');
      });
    });

    $('#window').addEventListener('change', function (e) {
      state.opts.window = parseInt(e.target.value, 10);
      refresh();
    });

    $('#overview-channel').addEventListener('change', function (e) {
      state.overviewChannel = e.target.value;
      renderOverviewChart();
    });

    $('#filter-channel').addEventListener('change', function (e) {
      state.filterChannel = e.target.value;
      renderAnomalies();
    });
    $('#filter-severity').addEventListener('change', function (e) {
      state.filterSeverity = e.target.value;
      renderAnomalies();
    });
    $('#cluster-k').addEventListener('change', function (e) {
      state.opts.k = parseInt(e.target.value, 10) || 0;
      refresh();
    });
    let autoTimer = null;
    $('#auto').addEventListener('change', function (e) {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
      if (!e.target.checked) return;
      autoTimer = setInterval(function () {
        loadSeries().then(function () { recompute(); renderAll(); }).catch(function () { /* keep last data */ });
      }, 10 * 60 * 1000);
    });

    $('#demo').addEventListener('change', function (e) {
      state.opts.injectDemo = e.target.checked;
      refresh();
    });
    $('#refresh').addEventListener('click', function () { loadSeries().then(refresh); });
    $('#run-validation').disabled = true;             // enabled once data arrives
    $('#run-validation').addEventListener('click', runValidation);
    $('#export-csv').addEventListener('click', exportCSV);
    $('#export-json').addEventListener('click', exportJSON);

    AWS.i18n.setLang(AWS.i18n.detect(), true);
    document.getElementById("language").value = AWS.i18n.lang;

    loadSeries().then(refresh).catch(function (err) {
      state.series = AWS.data.sampleSeries();
      state.source = 'fallback';
      state.error = err && err.message ? String(err.message) : String(err);
      refresh();
    });
  }

  /* ============================================================
     EXPORT
     ============================================================ */
  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 800);
  }

  function stamp() {
    const d = new Date();
    return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') +
      '-' + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0');
  }

  function exportCSV() {
    const r = state.result;
    const head = ['timestamp', 'channel', 'value', 'unit', 'expected', 'robust_z', 'severity', 'confirmed', 'score',
      'samples', 'detectors', 'explanation'];
    const rows = r.events.map(function (e) {
      return [e.time, e.channel, e.value, e.unit, e.expected, e.z, e.severity, e.confirmed, e.score, e.count,
        e.dets.join('|'), (e.explanation && e.explanation.narrative) || ''];
    });
    const csv = [head].concat(rows).map(function (row) {
      return row.map(function (v) {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
    download('aws-anomalies-' + stamp() + '.csv', '\ufeff' + csv, 'text/csv;charset=utf-8');
  }

  function exportJSON() {
    const r = state.result;
    const out = {
      generated_at: new Date().toISOString(),
      language: AWS.i18n.lang,
      station: r.meta,
      options: state.opts,
      summary: r.summary,
      quality: { index: r.quality.overall, checks: r.quality.checks, channels: r.quality.channels },
      clusters: {
        k: r.clusters.k, silhouette: r.clusters.silhouette,
        profiles: r.clusters.profiles.map(function (p) {
          return { size: p.size, signature: p.signature };
        })
      },
      rules: r.rules.fired.map(function (x) {
        return { id: x.id, name: x.name, severity: x.severity, count: x.count, channels: x.channels };
      }),
      anomalies: r.events.map(function (e) {
        return {
          time: e.time, channel: e.channelKey, value: e.value, expected: e.expected, z: e.z,
          severity: e.severity, confirmed: e.confirmed, score: e.score, samples: e.count, detectors: e.dets,
          narrative: e.explanation && e.explanation.narrative,
          counterfactual: e.explanation && e.explanation.counterfactual,
          confidence: e.explanation && e.explanation.confidence
        };
      })
    };
    download('aws-analysis-' + stamp() + '.json', JSON.stringify(out, null, 2), 'application/json');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : globalThis);









