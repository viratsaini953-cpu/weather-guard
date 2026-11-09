# AWS Data Quality — interactive dashboard

A self-contained web app that reads a real hourly weather feed and tells you which sensor readings are
**normal**, which are **worth a look**, and which are **broken** — with a written explanation for every decision.

No hardware, no API key, no framework, no build step. Open `index.html` and it runs.

> This folder is the **interface build** of the project. The repository root holds the Python research
> prototype (`src/awsdq/`, `run.py`, `docs/`), which measures the same problem batch-wise. This app is the
> real-time, interactive counterpart: same ideas, no Python, fully deterministic in the browser.

---

**Live demo:** https://viratsaini953-cpu.github.io/weather-guard/

## Quick start

```bash
# from this folder (aws-dq/app)
start index.html            # Windows   (macOS: open index.html)

# or serve it — recommended, so the live API is fetched over http
node server.js              # → http://127.0.0.1:5123
```

Data: [Open-Meteo](https://open-meteo.com/) — 9 channels, hourly, last 7 days, free and keyless.
If the request fails, the app falls back to a bundled snapshot of the same feed and says so in the status bar.

**Demo in 30 seconds**

1. **Overview** — station status, data-quality score, sensor stream with flagged samples.
2. Tick **Demo faults** (top right). Six synthetic faults are injected: spikes, a stuck barometer, a data
   dropout, a cross-sensor violation. Watch the findings appear; open **Anomalies** and click a row to read the
   reasoning.
3. **Validation** → *Run validation* to score the detectors against known ground truth.

---

## The seven tabs

| Tab | What it answers |
|-----|-----------------|
| **Overview** | Is the station healthy? What changed, and what are the top findings? |
| **Data quality** | Which of the seven QC tests failed, and how is the 0–100 index built? |
| **Anomalies** | Every flagged sample, why it fired, what would clear it, plus joint multi-sensor anomalies |
| **Patterns** | How hours cluster into weather regimes, and which regime each anomaly belongs to |
| **Rules & explanations** | Which physical rules fired, the action to take, and what drives the detections |
| **Validation** | Injected-fault recall / precision / latency, reproducible from a seed |
| **Help** | The pipeline, assumptions, and where every threshold lives |

### Languages

The language selector in the top bar switches the whole interface instantly — no reload, and the choice is
remembered for the next visit.

| | | | | | |
|---|---|---|---|---|---|
| English | हिन्दी (Hindi) | मराठी (Marathi) | Español | العربية (Arabic, right-to-left) | 中文 |

Interface labels, headings, hints, tables, status messages and help text are translated. Rule names, rule
rationales and the auto-generated per-reading explanation stay in English on purpose, so the numbers behind a
flag can be checked by anyone.

### Artwork

Three vector illustrations ship with the app (`assets/img/`): the station hero on the dashboard, a guide
illustration in the sidebar, and an empty-state drawing. They are hand-built SVG — no external requests, no
licence to manage, crisp on any screen.

---

## How it works

```
Open-Meteo API
      │  9 channels · hourly · 7 days
      ▼
normalise → rolling-window features → data-quality checks
      │                                    └─ 7 tests → DQ index 0–100
      ▼
one-step prediction residual (diurnal baseline + short trend)
      ▼
5 detectors ── robust z · IQR fence · EWMA · WMO spike · Isolation Forest
      ▼
agreement voting  →  anomaly episodes (severity + confirmed/review)
      ▼
k-means++ clusters (k by silhouette, PCA view)  +  17-rule engine
      ▼
explanation: ranked evidence · narrative · counterfactual · cited rule
```

Two decisions define the system:

1. **Detectors run on residuals, not raw values.** A 09:00 warming ramp is normal weather; a 6 °C jump at the
   same hour is not. A same-hour diurnal baseline blended with a short trend model keeps the residual scale
   small, so real spikes stand out.
2. **A statistical outlier is never called a fault.** Severity and certainty are separate axes: a finding is
   *confirmed* only with deterministic evidence (impossible value, missing sample, flatline, physics rule);
   otherwise it is a *review item*, capped at severity *high*.

---

## Measured results

Mumbai feed, 7 Nov 2026, window 12 h, seed 20261107:

| Metric | Result |
|--------|--------|
| Recall on injected faults | **1.00** (122 / 122 samples) |
| Precision on injected faults | **0.87** |
| F1 | **0.93** |
| False alarms on clean live data | **1.3 %** of samples |
| Data-quality index | **100 / A** |
| Confirmed faults on clean data | **0** (11 review items) |
| Pipeline runtime | **~0.2 s** for 192 h × 9 channels |

Acceptance criteria: [REQUIREMENTS.md](REQUIREMENTS.md) §8.

---

## Structure

```
app/
├── index.html            dashboard shell (7 tabs)
├── assets/styles.css     all styling
├── assets/img/           vector artwork (hero, guide, empty state)
├── src/
│   ├── util.js           statistics, seeded RNG, formatting
│   ├── config.js         channels, physical limits, every threshold
│   ├── data.js           API ingestion, normalisation, offline fallback
│   ├── features.js       rolling features + prediction residuals
│   ├── quality.js        7 QC checks + data-quality index
│   ├── anomaly.js        detectors, episodes, Isolation Forest
│   ├── cluster.js        k-means++, silhouette, PCA
│   ├── rules.js          17 domain rules with corrective actions
│   ├── explain.js        contributions, narratives, counterfactuals
│   ├── pipeline.js       deterministic orchestration
│   ├── faults.js         fault injection + precision/recall harness
│   ├── charts.js         hand-written SVG charts
│   ├── app.js            rendering and interaction
│   └── sample-data.js    bundled offline snapshot (real data)
├── data/live-sample.json raw snapshot used to build sample-data.js
├── docs/screenshots/     UI evidence
├── server.js             optional static server
├── REQUIREMENTS.md       full requirements, formulas, acceptance criteria
└── README.md
```

---

## Notes

- **Deterministic** — fixed seeds in k-means++, the Isolation Forest and the fault injector: same input, same output.
- **Offline-safe** — every dependency is local; the only network call is the weather API.
- **Tunable** — window (6/12/24 h), sensitivity and cluster count are in the UI; defaults live in `src/config.js`.
- **Honest limits** — seven days of data, no neighbour-station check, and drift is caught by a rule rather than
  by statistics. Documented in [REQUIREMENTS.md](REQUIREMENTS.md) §11.

Data © [Open-Meteo](https://open-meteo.com/) (CC-BY 4.0).


