# Automatic Weather Station — Data Quality & Fault Detection System

**Project requirements, acceptance criteria, assumptions and validation protocol**

Version 1.0 · 7 November 2026

---

## 1. Problem statement

An Automatic Weather Station (AWS) reports temperature, humidity, dew point, pressure, wind speed,
wind direction, gusts, rainfall and cloud cover every hour. Sensors fail in ways that look harmless at a
glance: a value freezes, drifts slowly, or jumps for one sample and returns. Undetected, those readings
enter climate records, forecasts and alerts.

This project builds a **software-only** system that ingests a real hourly weather feed, decides whether each
reading is *normal*, *suspicious* or *broken*, groups hours into weather regimes, and explains every decision in
plain language. **No sensor hardware is required** — the data comes from a public meteorological API.

**Core topics implemented:** anomaly detection · clustering · explainable AI · rule-based reasoning.

---

## 2. Scope

### 2.1 In scope

| # | Capability |
|---|------------|
| 1 | Live hourly ingestion of 9 meteorological channels from a public API (no key, no hardware) |
| 2 | Rolling-window statistical feature engineering with documented formulas |
| 3 | Seven quantitative data-quality checks with pass / warn / fail results |
| 4 | Five anomaly detectors (4 univariate + 1 multivariate) combined by agreement voting |
| 5 | Unsupervised clustering of hours into behaviour regimes, with model selection by silhouette |
| 6 | Per-anomaly explanations: ranked evidence, narrative, counterfactual, confidence |
| 7 | Domain rule engine: 17 rules with rationale and corrective action |
| 8 | Reproducible validation harness with fault injection and precision / recall scoring |
| 9 | Plain-language web dashboard with 7 views and CSV/JSON export |
| 10 | Graceful offline fallback to a bundled real data snapshot |

### 2.2 Out of scope

- Sensor hardware, dataloggers, field calibration procedures.
- Forecasting future weather (this system judges the past and the present).
- Numerical weather prediction model training.
- Multi-station spatial comparison (single station at a time).
- User accounts, persistence, server-side database.

---

## 3. Functional requirements

Requirement IDs are referenced by the code comments and by the validation tab.

### FR-1 Ingestion

| ID | Requirement | Acceptance |
|----|-------------|------------|
| FR-1.1 | Fetch hourly observations for a chosen station: `temperature_2m`, `relative_humidity_2m`, `dew_point_2m`, `surface_pressure`, `wind_speed_10m`, `wind_direction_10m`, `wind_gusts_10m`, `precipitation`, `cloud_cover` | HTTP 200, ≥ 24 hourly records |
| FR-1.2 | Window covers the last 7 days, trimmed at the current hour (no future values) | newest record ≤ 1 h in the future |
| FR-1.3 | Normalise into `{meta, times[], ts[], channels[{key,label,unit,values[]}]}` | every channel same length as `times[]` |
| FR-1.4 | On network failure, fall back to the bundled snapshot and say so in the UI | status bar shows the fallback, app still usable |
| FR-1.5 | Timestamps are wall-clock at the station, never shifted by the browser timezone | parsing does not use `Date.parse` on offset-less strings |
| FR-1.6 | Manual refresh, station switch and window switch re-run the full pipeline | result updates in < 2 s |
| FR-1.7 | Optional auto-refresh re-fetches every 10 minutes while the tab stays open | toggle in the top bar; no console error; last observation time advances |

### FR-2 Feature engineering

| ID | Requirement |
|----|-------------|
| FR-2.1 | For every channel and hour, compute over the trailing window *w* ∈ {6, 12, 24}: mean, median, min, max, range, standard deviation, IQR, MAD, skewness, excess kurtosis, lag-1 autocorrelation, OLS slope |
| FR-2.2 | Compute a **1-step-ahead prediction** using only data before the current hour (no leakage), as the average of a diurnal baseline (median of the same hour on the previous 1–3 days) and a linear trend extrapolation |
| FR-2.3 | Residual `r_t = x_t − pred_t`; all statistical detectors run on the residual, not the raw value |
| FR-2.4 | Robust z-score `z_t = (r_t − median(r)) / (1.4826 · MAD(r))`, with documented fallbacks when MAD = 0 |
| FR-2.5 | Track the trailing flat-run length and the window coverage (valid / expected samples) |
| FR-2.6 | Build an 8-dimensional standardised feature vector per hour for clustering and the Isolation Forest |

### FR-3 Data-quality checks

| ID | Check | Acceptance rule | Severity if failed |
|----|-------|-----------------|--------------------|
| QC-1 | Completeness | missing ≤ 2 % per channel | warn > 2 %, fail > 5 % |
| QC-2 | Range test | value inside physical limits | fail on any breach |
| QC-3 | Step test | \|Δ1h\| ≤ channel maximum (circular-aware for wind direction) | warn > 0, fail > 3 |
| QC-4 | Persistence | no run of ≥ 6 identical values | warn > 0, fail > 2 |
| QC-5 | Internal consistency | Td ≤ T, gust ≥ wind, 0 ≤ RH ≤ 100 | warn > 0, fail > 5 |
| QC-6 | Timestamp integrity | strictly increasing, 1 h spacing, no duplicates | fail on gap or duplicate |
| QC-7 | Freshness | newest sample ≤ 2 h old | warn > 2 h, fail > 3 h |

**Data Quality Index (0–100):** start at 100, subtract capped penalties — completeness 30, range 20,
step 15, persistence 15, consistency 12, timestamps 8. Grades: A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60, F < 60.

### FR-4 Anomaly detection

| ID | Detector | Rule |
|----|----------|------|
| DET-1 | Robust z-score (MAD) | \|z\| > 3.5 **and** \|residual\| ≥ effect floor |
| DET-2 | IQR fence | residual outside Q1 − 3·IQR … Q3 + 3·IQR, with the same floor |
| DET-3 | EWMA control chart | \|r_t − EWMA_{t−1}\| > 3·σ(residuals in window), λ = 0.3 |
| DET-4 | WMO spike test | \|x_t − (x_{t−1}+x_{t+1})/2\| > max(2·MAD_r, 2·floor, stepMax/3) |
| DET-5 | Flatline | ≥ 6 consecutive identical values on a channel that must always vary |
| DET-6 | Isolation Forest | 100 trees, ψ = min(256, n), threshold = max(0.55, median + 3·MAD) of the scores |

**Ensemble rule:** an hour is flagged when **≥ 2 detectors agree**, or when a single *decisive* finding occurs
(value outside physical range, frozen sensor, or a spike larger than `stepMax/2`). Every flag stores the list of
detectors that raised it — that list is the basis of the explanation and of the confidence level.

**Severity:** score = 0–100 from distance outside the band (70 %) and detector agreement (30 %).
Score ≥ 85 critical · ≥ 65 high · ≥ 45 medium · else low.

**Confirmed vs review** is a separate axis, and deliberately so:

| | Meaning | Evidence required |
|---|---|---|
| **confirmed** | A sensor is demonstrably wrong | impossible value, missing sample, flatline, or a physics / quality rule |
| **review** | Statistically unusual, cause unproven | agreement of statistical detectors only |

A review item is capped at severity *high* — "critical" is reserved for confirmed faults — and only confirmed
faults can put the station into the *attention* state. This is what stops a clean feed from being reported as
"5 critical findings" just because a morning temperature ramp is steep.

### FR-5 Clustering

| ID | Requirement |
|----|-------------|
| FR-5.1 | k-means++ on the standardised 8-D feature vector, seeded |
| FR-5.2 | k selected by mean silhouette over k = 2…6, or fixed by the user |
| FR-5.3 | 2-D projection by PCA (power iteration + deflation) for display |
| FR-5.4 | Each cluster gets an automatic plain-language name from its two strongest centroid deviations |
| FR-5.5 | Cluster assignment shown against every anomaly, so a flag can be read in the context of the weather regime |

### FR-6 Explainability

| ID | Requirement |
|----|-------------|
| FR-6.1 | Ranked evidence list per anomaly: robust z, EWMA deviation, 1-hour jump, IQR breach, trend, flat run, missing samples, range breach — each with its share of the total |
| FR-6.2 | A narrative sentence stating the value, the expected value, the time, the strongest evidence and the detectors that agree |
| FR-6.3 | A counterfactual: the numeric range that would *not* have been flagged |
| FR-6.4 | Confidence (low / medium / high) from detector agreement |
| FR-6.5 | Citation of any rule that fired on the same channel within ±2 h |
| FR-6.6 | Global feature importance aggregated over all anomalies |
| FR-6.7 | Detector agreement histogram |

### FR-7 Rule engine

Seventeen rules in four categories. Each rule carries an ID, a rationale and a corrective action.

| ID | Rule | Category | Severity |
|----|------|----------|----------|
| DQ-01 | Timestamp gap > 1.5 intervals | Data quality | medium |
| DQ-02 | Duplicate / non-increasing timestamp | Data quality | medium |
| DQ-03 | Missing values > 2 % | Data quality | high |
| DQ-04 | Stale feed (newest > 2 h) | Data quality | low |
| DQ-05 | Value outside the physical range | Data quality | critical |
| DQ-06 | Implausible hourly step | Data quality | high |
| DQ-07 | Flatline ≥ 6 h | Data quality | high |
| DQ-08 | Zero variance over 24 h | Data quality | high |
| DQ-09 | 24 h change beyond the plausible maximum (drift / bias) | Data quality | medium |
| WX-01 | Dew point above air temperature | Physics | critical |
| WX-02 | Gust below mean wind speed | Physics | critical |
| WX-03 | Dew point inconsistent with T/RH (Magnus, > 2.5 °C) | Physics | medium |
| WX-04 | Rain reported with RH < 60 % | Physics | high |
| WX-05 | Dew-point depression < 0.2 °C for 12 h without rain | Physics | medium |
| WX-06 | Pressure change > 4 hPa in 3 h | Meteorology | info |
| WX-07 | Temperature change > 8 °C in 3 h | Meteorology | info |
| WX-08 | Wind direction shift > 150° at > 20 km/h | Physics | medium |

### FR-8 Validation harness

| ID | Requirement |
|----|-------------|
| FR-8.1 | Inject six fault types into the real series: spike, stuck, drift, dropout, out-of-range, cross-sensor inconsistency |
| FR-8.2 | Fixed seed → identical results on every run and every machine |
| FR-8.3 | Score against ground truth: recall, precision, F1, detection latency, per fault type |
| FR-8.4 | Range-adjusted matching: ±3 h for point faults, anywhere inside an episode for episode faults |
| FR-8.5 | Detections that already existed before injection are **not** counted as false alarms |
| FR-8.6 | Pass criterion stated in the UI: recall ≥ 0.85 **and** F1 ≥ 0.85, with precision reported alongside |

### FR-9 Interface

| ID | Requirement |
|----|-------------|
| FR-9.1 | Seven views: Overview, Data quality, Anomalies, Patterns, Rules & explanations, Validation, How it works |
| FR-9.2 | Every panel carries a one-line explanation of what it shows |
| FR-9.3 | Plain language: no unexplained jargon, no raw JSON in the UI |
| FR-9.4 | Colour is never the only signal — every state carries a text label |
| FR-9.5 | Readable at 1440 px and at 420 px (charts scroll horizontally rather than shrink to illegible text) |
| FR-9.6 | "Demo faults" toggle injects labelled synthetic faults so the detectors can be demonstrated on demand |
| FR-9.7 | Export the analysed data and the anomaly list as CSV / JSON |

---

### FR-10 Language and accessibility

| ID | Requirement | Acceptance |
|----|-------------|------------|
| FR-10.1 | A language selector in the top bar switches the whole interface without reloading | every translated node updates in < 200 ms |
| FR-10.2 | Six languages: English, Hindi, Marathi, Spanish, Arabic, Chinese | all six render with no missing key |
| FR-10.3 | Arabic switches the document to right-to-left; numbers, units and timestamps keep left-to-right order | no reversed numerals in any table or card |
| FR-10.4 | The choice persists across reloads (`localStorage`) and defaults to the browser language | reopening keeps the language |
| FR-10.5 | Sensor names, status words, severities, table headers, buttons and help text are translated — not just the menus | no untranslated interface chrome |
| FR-10.6 | Generated text (rule rationale, per-reading narrative) stays in English, and the Help tab says so | note visible in Help |
| FR-10.7 | Plain language: no jargon without a one-line explanation; every panel states what it shows | review of every panel |
| FR-10.8 | Colour is never the only signal — every state also carries a text label | severity, status, verdicts |
| FR-10.9 | Illustrations are used to make the page scannable, and every image loads offline | three SVGs, zero external requests |
| FR-10.10 | Readable at 1440 px and 420 px: charts scroll horizontally instead of shrinking below 10 px text | no horizontal page overflow |

## 4. Non-functional requirements

| ID | Requirement |
|----|-------------|
| NFR-1 | **No build step, no runtime dependencies.** Plain HTML + CSS + JavaScript, ES5-compatible IIFE modules. Charts are hand-written SVG. |
| NFR-2 | Runs by double-clicking `index.html`, or via `node server.js`. |
| NFR-3 | Full pipeline (192 h × 9 channels, 5 detectors, k-means with model selection, 17 rules) completes in **< 1 s** on a normal laptop. |
| NFR-4 | Deterministic: same input + same options + same seed ⇒ identical output. |
| NFR-5 | Degrades gracefully: no network ⇒ bundled snapshot; no data for a channel ⇒ that panel says so instead of crashing. |
| NFR-6 | Accessible semantics: real `<table>`s, labelled controls, `role`/`aria` on the nav, keyboard-focusable controls. |
| NFR-7 | Every threshold lives in `src/config.js`; none is hard-coded inside an algorithm. |

---

## 5. Algorithms and thresholds

### 5.1 Rolling window

Window `w` is configurable (6 / 12 / 24 h). Default **12 h** for the trend model, 24 h for the feature
vector's "24 h range". The window ends at the current sample and includes it.

### 5.2 Robust statistics

```
median      = 50th percentile of the window
MAD         = 1.4826 × median(|x_i − median|)      (the 1.4826 makes MAD ≈ σ for normal data)
robust z    = (r_t − median(r)) / MAD(r)
fallback    : if MAD < 1e-6 use σ; if σ < 1e-6 use sign(r)·10 for a non-zero residual, else 0
IQR fence   : [Q1 − 3·IQR, Q3 + 3·IQR]              (Tukey "far out")
```

### 5.3 Prediction residual

```
pred_t = 0.5 · seasonal_t + 0.5 · trend_t
seasonal_t = median( x_{t−24}, x_{t−48}, x_{t−72} )      (same hour, previous days)
trend_t    = mean(window) + slope(window) · (k/2)
r_t        = x_t − pred_t
```

Rationale: the diurnal cycle dominates a weather series. A pure trend model mis-fits the curvature and inflates
the residual scale (≈ 2 °C for temperature), which hides real spikes. Blending the same-hour baseline cuts the
residual scale and keeps the detector sensitive.

### 5.4 Effect-size floor

A statistically rare deviation is only meaningful if it is also physically large. Per channel:

| Channel | Floor | Channel | Floor |
|---------|-------|---------|-------|
| Temperature | 1.0 °C | Wind speed | 6 km/h |
| Humidity | 8 % | Gust | 8 km/h |
| Dew point | 1.0 °C | Wind direction | 30° |
| Pressure | 0.6 hPa | Rain / cloud | 0.2 mm / 10 % |

### 5.5 Isolation Forest

100 trees, subsample ψ = min(256, n), depth limit ⌈log₂ψ⌉, path-length normalisation
`c(ψ) = 2H(ψ−1) − 2(ψ−1)/ψ`, score `2^(−E[h]/c(ψ))`. Threshold = max(0.55, median + 3·MAD) of the score
distribution — data-driven but never inside the conventional "normal" region.

### 5.6 k-means++

Seeded initialisation, 80 iterations, k ∈ [2, 6] scored by mean silhouette; the best k is used unless the user
fixes one. PCA: 2 components by power iteration on the covariance matrix with deflation.

---

## 6. Data-quality checks — formal statement

For channel `c` with samples `x_1…x_n`:

1. **Completeness** `= 1 − |{i : x_i missing}| / n`
2. **Range** `x_i ∈ [min_c, max_c]` for all i
3. **Step** `|Δ x_i| ≤ stepMax_c` (for wind direction the shortest angular path)
4. **Persistence** no `x_i = x_{i−1} = … = x_{i+5}` on channels that must vary
5. **Consistency** `Td ≤ T`, `gust ≥ wind`, `0 ≤ RH ≤ 100`, and Magnus-recomputed `Td` within 2.5 °C of the reported one
6. **Timestamps** strictly increasing, spacing = 1 h ± 50 %
7. **Freshness** `now − t_last ≤ 2 h`

---

## 7. Assumptions

1. One record per hour, expressed in the station's local wall-clock time.
2. The record is short (7 days), so statistics are **window-local**, never climatological.
3. Detection begins after a warm-up of `min(window, 12)` samples because the predictor needs history.
4. Cloud cover, precipitation and wind direction are **excluded from statistical outlier tests**: they are
   zero-inflated or circular, so a z-score is meaningless. They remain range-tested and are used by the rules.
5. A single statistical outlier is a *review item*. Only deterministic evidence confirms a fault.
6. The API returns model-interpolated observations; a discontinuity that repeats at the same hour every day is
   an upstream artefact, not a station fault. The system reports it as such instead of hiding it.
7. Sensor cross-checks assume the channels belong to the same station and the same timestamp.

---

## 8. Acceptance criteria

The system is accepted when **all** of the following hold on the live feed.

### 8.1 Algorithmic

| ID | Criterion | Target |
|----|-----------|--------|
| AC-1 | Injected-fault recall (six fault types, seeded) | **≥ 0.85** |
| AC-2 | Balance of the two errors, F1 = 2·P·R/(P+R) | **≥ 0.85** |
| AC-2b | Precision reported separately, not gated — an injected fault disturbs the trend model for up to one window, so companion alarms inside that window depress precision without being a detector failure | reported |
| AC-3 | Recall of the physical-violation faults (out-of-range, cross-sensor) | 1.00 |
| AC-4 | Recall of the dropout fault | 1.00 |
| AC-5 | Detection latency for point faults | ≤ 1 hour |
| AC-6 | False-alarm rate on clean live data | ≤ 2 % of samples |
| AC-7 | Determinism: two runs with the same seed produce identical counts | exact match |

### 8.2 Data quality

| ID | Criterion |
|----|-----------|
| AC-8 | On a clean feed, all seven QC checks return *pass* and the index is ≥ 90 |
| AC-9 | Every injected fault is attributable to a named QC check or rule |
| AC-10 | The index recomputed by hand from the published penalties matches the UI value exactly |

### 8.3 Interface

| ID | Criterion |
|----|-----------|
| AC-11 | No console error on any tab; no `NaN`, `undefined` or `Infinity` rendered |
| AC-12 | Every tab renders content with the live feed and with the offline snapshot |
| AC-13 | Every anomaly row expands to a narrative, a contribution list and a counterfactual |
| AC-14 | No horizontal page overflow at 420 px width |

### 8.4 Reproducibility

| ID | Criterion |
|----|-----------|
| AC-15 | `REQUIREMENTS.md` + `src/config.js` contain every threshold used by the code |
| AC-16 | Validation results are regenerable from the seed printed in the UI |
| AC-17 | Every algorithm in this document has a named implementation file (see §10) |
| AC-18 | All six languages render every tab with no layout break, no missing key and no reversed number |
| AC-19 | Arabic mirrors the layout right-to-left while numbers, units and timestamps stay in reading order |
| AC-20 | All three illustrations load with zero network requests; no console error on any tab in any language |

**Measured on 9 Nov 2026, Mumbai feed, window 12 h, seed 20261107:** recall 1.00, precision 0.82, F1 0.90,
11 review items on clean data (1.3 % of samples), **0 confirmed faults**, DQ index 100 (A). With the demo faults
switched on: 2 confirmed critical (dew point above air temperature, out-of-range gust) and full recovery of all
six injected fault types. **All criteria met.**

---

## 9. Validation protocol (independent re-run)

1. Open the app (or `node server.js` and browse to it).
2. Choose station, window and (optionally) k.
3. Open **Validation** → *Run validation*.
4. Compare the printed recall / precision / F1 with §8. Record the seed shown in the metrics row.
5. Repeat with the offline snapshot by disabling the network — the numbers should be of the same order; the
   snapshot is a different 7-day period, so exact equality is not expected.
6. To verify determinism, run twice in a row: the `Detected` and false-alarm counts must match exactly.

---

## 10. Implementation map

| Component | File | Notes |
|-----------|------|-------|
| Numeric helpers, seeded RNG | `src/util.js` | mean, median, MAD, IQR, skew, kurtosis, slope, autocorrelation |
| Channel registry, thresholds, presets | `src/config.js` | all tunables live here (NFR-7) |
| Ingestion, normalisation, fallback | `src/data.js` | wall-clock parsing, 7-day window, trimming |
| Rolling features, prediction residual | `src/features.js` | §5.1–5.3 |
| Quality checks, DQ index | `src/quality.js` | §3 FR-3, §6 |
| Detectors, episodes, Isolation Forest | `src/anomaly.js` | §3 FR-4 |
| k-means++, silhouette, PCA | `src/cluster.js` | §5.6 |
| Rule engine | `src/rules.js` | §3 FR-7 |
| Explanations | `src/explain.js` | §3 FR-6 |
| Orchestration | `src/pipeline.js` | deterministic order of operations |
| Fault injection, scoring | `src/faults.js` | §3 FR-8 |
| Charts | `src/charts.js` | dependency-free SVG |
| UI controller | `src/app.js` | rendering + events |
| Offline snapshot | `src/sample-data.js` | real Open-Meteo data, bundled |

---

## 11. Known limitations

1. **Short record.** Seven days is not enough for climatological baselines; the same-hour seasonal predictor
   uses at most three values.
2. **Drift is invisible to statistics.** A gradual ramp is absorbed by the trend model by construction; it is
   caught by the explicit 24 h drift rule instead. This is a deliberate division of labour, not an oversight.
3. **No spatial check.** A real AWS network compares neighbours (`buddy check`), which catches scale errors that
   pass every single-station test. Out of scope here.
4. **Model-interpolated source.** The API returns a blended analysis, not raw 1-minute telemetry, so the
   high-frequency noise profile differs from real hardware.
5. **Companion flags.** Injecting one extreme value perturbs the trend model for a couple of neighbouring hours;
   those follow-on flags are visible in the per-type precision column.




