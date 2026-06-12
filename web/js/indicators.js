// Simple moving average; returns array aligned to input (null until enough data).
export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// Relative strength line: close / benchmark close.
export function rsLine(closes, bench) {
  if (!bench) return null;
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (bench[i] != null && bench[i] > 0) out[i] = closes[i] / bench[i];
  }
  return out;
}

// Up/Down volume ratio over the trailing `period` bars.
export function upDownVolume(closes, volumes, period = 50) {
  let up = 0, down = 0;
  const n = closes.length;
  for (let i = Math.max(1, n - period); i < n; i++) {
    if (closes[i] > closes[i - 1]) up += volumes[i];
    else if (closes[i] < closes[i - 1]) down += volumes[i];
  }
  return down > 0 ? up / down : null;
}

// Average daily range (%) over the trailing `period` bars.
export function adrPct(highs, lows, period = 20) {
  const n = highs.length;
  let sum = 0, cnt = 0;
  for (let i = Math.max(0, n - period); i < n; i++) {
    if (lows[i] > 0) { sum += highs[i] / lows[i] - 1; cnt++; }
  }
  return cnt ? (sum / cnt) * 100 : null;
}

// % change over the trailing `bars` bars.
export function perf(closes, bars) {
  const n = closes.length;
  if (n <= bars) return null;
  const a = closes[n - 1 - bars], b = closes[n - 1];
  return a > 0 ? (b / a - 1) * 100 : null;
}
