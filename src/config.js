/* ============================================================
   config.js — channel registry, physical limits, tunables.
   Every threshold here is documented in REQUIREMENTS.md so the
   system can be reproduced and evaluated independently.
   ============================================================ */
(function (root) {
  'use strict';
  const AWS = (root.AWS = root.AWS || {});

  /* Sensor channels of an Automatic Weather Station (AWS).
     min/max = physical plausibility limits (QC range test, WMO style).
     stepMin/stepMax = maximum plausible change per 1 hour.
     circular = angular quantity, excluded from linear feature maths. */
  /* stat          = included in statistical outlier detection
     persistence   = flatline test applies (channels that must always vary)
     driftMax      = maximum plausible change over 24 h before a bias/drift
                     review is triggered (null = not applicable)
     circular      = angular quantity -> circular difference in the step test */
  const CHANNELS = [
    { key: 'temp', label: 'Air temperature', short: 'Temp', unit: '°C', min: -50, max: 55, stepMax: 8, floor: 1, decimals: 1, color: '#e05a2b', stat: true, persistence: true, driftMax: 15 },
    { key: 'rh', label: 'Relative humidity', short: 'Humidity', unit: '%', min: 0, max: 100, stepMax: 45, floor: 8, decimals: 0, color: '#0f8b8d', stat: true, persistence: true, driftMax: 70 },
    { key: 'dew', label: 'Dew point', short: 'Dew pt', unit: '°C', min: -60, max: 45, stepMax: 8, floor: 1, decimals: 1, color: '#2a9d8f', stat: true, persistence: true, driftMax: 15 },
    { key: 'press', label: 'Surface pressure', short: 'Pressure', unit: 'hPa', min: 800, max: 1080, stepMax: 6, floor: 0.6, decimals: 1, color: '#4f46e5', stat: true, persistence: true, driftMax: 15 },
    { key: 'wind', label: 'Wind speed', short: 'Wind', unit: 'km/h', min: 0, max: 250, stepMax: 60, floor: 6, decimals: 1, color: '#0ea5e9', stat: true, persistence: true, driftMax: 45 },
    { key: 'windDir', label: 'Wind direction', short: 'Wind dir', unit: '°', min: 0, max: 360, stepMax: 180, floor: 30, decimals: 0, circular: true, stat: false, persistence: false, driftMax: null, color: '#7c3aed' },
    { key: 'gust', label: 'Wind gust', short: 'Gust', unit: 'km/h', min: 0, max: 350, stepMax: 90, floor: 8, decimals: 1, color: '#0284c7', stat: true, persistence: true, driftMax: 60 },
    { key: 'precip', label: 'Precipitation', short: 'Rain', unit: 'mm', min: 0, max: 150, stepMax: 60, floor: 0.2, decimals: 1, color: '#2563eb', stat: false, persistence: false, driftMax: null },
    { key: 'cloud', label: 'Cloud cover', short: 'Cloud', unit: '%', min: 0, max: 100, stepMax: 100, floor: 10, decimals: 0, color: '#64748b', stat: false, persistence: false, driftMax: null }
  ];

  const BY_KEY = {};
  CHANNELS.forEach(function (c) { BY_KEY[c.key] = c; });

  /* Feature families used by the clustering / isolation-forest layer.
     Kept small (8 dims) so clusters stay interpretable. */
  const FEATURE_VECTOR = [
    { id: 'rz_temp', label: 'Temp anomaly (robust z)', channel: 'temp', kind: 'rz', w: 12 },
    { id: 'rz_rh', label: 'Humidity anomaly (robust z)', channel: 'rh', kind: 'rz', w: 12 },
    { id: 'rz_press', label: 'Pressure anomaly (robust z)', channel: 'press', kind: 'rz', w: 12 },
    { id: 'rz_wind', label: 'Wind anomaly (robust z)', channel: 'wind', kind: 'rz', w: 12 },
    { id: 'd1_temp', label: 'Temp 1h change', channel: 'temp', kind: 'delta1', w: 12 },
    { id: 'd1_press', label: 'Pressure 1h change', channel: 'press', kind: 'delta1', w: 12 },
    { id: 'd1_wind', label: 'Wind 1h change', channel: 'wind', kind: 'delta1', w: 12 },
    { id: 'range_temp', label: 'Temp 24h range', channel: 'temp', kind: 'range', w: 24 }
  ];

  const PRESETS = [
    { id: 'mumbai', name: 'Mumbai, IN', lat: 19.076, lon: 72.8777 },
    { id: 'delhi', name: 'New Delhi, IN', lat: 28.6139, lon: 77.209 },
    { id: 'kolkata', name: 'Kolkata, IN', lat: 22.5726, lon: 88.3639 },
    { id: 'chennai', name: 'Chennai, IN', lat: 13.0827, lon: 80.2707 },
    { id: 'bengaluru', name: 'Bengaluru, IN', lat: 12.9716, lon: 77.5946 },
    { id: 'london', name: 'London, UK', lat: 51.5072, lon: -0.1276 },
    { id: 'nyc', name: 'New York, US', lat: 40.7128, lon: -74.006 },
    { id: 'singapore', name: 'Singapore, SG', lat: 1.3521, lon: 103.8198 }
  ];

  /* Tunables exposed in the UI. Defaults are the documented baseline. */
  const DEFAULT_OPTS = {
    window: 12,          // rolling/training window in hours (6 | 12 | 24)
    model: 'blend',      // residual predictor: 'trend' | 'seasonal' | 'blend'
    zThresh: 3.5,        // robust z threshold (Iglewicz & Hoaglin)
    iqrK: 3.0,           // Tukey far-out fence multiplier
    ewmaLambda: 0.3,     // EWMA smoothing
    ewmaSigma: 3.0,      // EWMA control limit (x sigma)
    k: 0,                // 0 = auto-select cluster count by silhouette
    seed: 20261107,      // fixed seed => reproducible results
    injectDemo: false    // demo mode: inject known sensor faults
  };

  AWS.config = {
    CHANNELS: CHANNELS,
    BY_KEY: BY_KEY,
    FEATURE_VECTOR: FEATURE_VECTOR,
    PRESETS: PRESETS,
    DEFAULT_OPTS: DEFAULT_OPTS,
    API_BASE: 'https://api.open-meteo.com/v1/forecast',
    API_VARS: [
      'temperature_2m', 'relative_humidity_2m', 'dew_point_2m', 'surface_pressure',
      'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m', 'precipitation', 'cloud_cover'
    ],
    /* Open-Meteo variable -> internal channel key */
    API_MAP: {
      temperature_2m: 'temp',
      relative_humidity_2m: 'rh',
      dew_point_2m: 'dew',
      surface_pressure: 'press',
      wind_speed_10m: 'wind',
      wind_direction_10m: 'windDir',
      wind_gusts_10m: 'gust',
      precipitation: 'precip',
      cloud_cover: 'cloud'
    },
    VERSION: '1.0.0'
  };
})(typeof window !== 'undefined' ? window : globalThis);






