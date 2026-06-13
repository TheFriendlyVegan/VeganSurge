// IBD-style base detection: cup / cup-with-handle / double bottom / flat base.
// Detection runs on WEEKLY bars (IBD counts base length in weeks); a daily
// chart aggregates to weekly first via aggregateWeekly(). Bases are returned
// with TIMESTAMPS so the chart can redraw them at any timeframe/zoom.
//
// Rules (with the usual IBD fudge factors):
//   prior uptrend : >= ~20% advance into the left-side high
//   flat base     : >= 5 wks, depth <= 15%
//   cup           : >= 6 wks, depth 12-50%, low roughly centered
//   double bottom : two lows within ~4%, a middle peak >= 7% above them
//   handle        : 1-5 wk drift in the UPPER HALF after the right side
//   pivot (buy point):
//     flat / cup-no-handle -> left-side high + 0.10
//     cup w/ handle        -> handle high   + 0.10
//     double bottom        -> middle peak   + 0.10

const round2 = (v) => Math.round(v * 100) / 100;

export function aggregateWeekly(bars) {
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let key = null;
  for (let i = 0; i < bars.t.length; i++) {
    const wk = Math.floor((bars.t[i] / 86400 + 3) / 7); // Monday-anchored week
    if (wk !== key) {
      key = wk;
      out.t.push(bars.t[i]);
      out.o.push(bars.o[i]);
      out.h.push(bars.h[i]);
      out.l.push(bars.l[i]);
      out.c.push(bars.c[i]);
      out.v.push(bars.v[i]);
    } else {
      const j = out.t.length - 1;
      out.h[j] = Math.max(out.h[j], bars.h[i]);
      out.l[j] = Math.min(out.l[j], bars.l[i]);
      out.c[j] = bars.c[i];
      out.v[j] += bars.v[i];
    }
  }
  return out;
}

function pivotHighs(h, w = 3) {
  const out = [];
  for (let i = w; i < h.length - 1; i++) {
    let ok = true;
    for (let k = i - w; k <= Math.min(i + w, h.length - 1) && ok; k++) {
      if (k !== i && h[k] > h[i]) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

export function detectBases(wb) {
  const n = wb.t.length;
  if (n < 10) return [];
  const bases = [];
  let guard = 0;

  for (const L of pivotHighs(wb.h, 3)) {
    if (L < guard || L > n - 4) continue;
    const H = wb.h[L];

    // prior uptrend: >= 20% off the lowest low of the preceding ~30 weeks
    let priorLow = Infinity;
    for (let k = Math.max(0, L - 30); k < L; k++) priorLow = Math.min(priorLow, wb.l[k]);
    if (!(isFinite(priorLow) && H >= priorLow * 1.2)) continue;

    // walk forward: track the base low, find recovery back near the left lip
    let lowi = -1, low = Infinity, R = -1;
    for (let i = L + 1; i < Math.min(n, L + 66); i++) {
      if (wb.l[i] < low) { low = wb.l[i]; lowi = i; }
      if (lowi > L && i - L >= 4 && wb.h[i] >= H * 0.92) { R = i; break; }
      if (wb.h[i] > H * 1.05 && lowi < 0) break; // ran away without basing
    }
    if (R < 0 || lowi <= L) continue;

    const depth = (H - low) / H;
    const weeks = R - L;
    if (depth < 0.08 || depth > 0.5 || weeks < 5) continue;

    // ---- classify ----
    let type = depth <= 0.15 ? "Flat Base" : "Cup";
    let dbPivot = null;

    // double bottom: first low -> middle peak -> second low (W)
    let firstLowI = -1, firstLow = Infinity;
    for (let i = L + 1; i < R; i++) if (wb.l[i] < firstLow) { firstLow = wb.l[i]; firstLowI = i; }
    let midPeakI = -1, midPeak = -Infinity;
    for (let i = firstLowI + 1; i < R; i++) if (wb.h[i] > midPeak) { midPeak = wb.h[i]; midPeakI = i; }
    let secLowI = -1, secLow = Infinity;
    for (let i = midPeakI + 1; i < R; i++) if (wb.l[i] < secLow) { secLow = wb.l[i]; secLowI = i; }
    if (
      firstLowI > L && midPeakI > firstLowI && secLowI > midPeakI &&
      midPeak >= firstLow * 1.07 &&
      secLow <= firstLow * 1.05 && secLow >= firstLow * 0.95
    ) {
      type = "Double Bottom";
      dbPivot = midPeak + 0.1;
    }

    if (type === "Cup") {
      if (weeks < 6) continue; // a real cup needs >= ~6 weeks
      const lowPos = (lowi - L) / weeks; // where the low sits in the base
      if (lowPos < 0.2 || lowPos > 0.85) continue; // low not centered -> reject
      if (depth < 0.12) type = "Flat Base";
    }

    // ---- handle: 1-5 weeks after R, drifting in the UPPER HALF ----
    // Track the handle's lowest low so the chart can draw the handle as a
    // straight line (right rim -> handle low) sized across the handle sessions.
    const mid = low + (H - low) * 0.5;
    let handleEnd = -1, handleHigh = wb.h[R], handleLow = Infinity, handleLowI = -1;
    for (let i = R + 1; i < Math.min(n, R + 6); i++) {
      if (wb.h[i] > H * 1.01) break;   // already broke out
      if (wb.l[i] < mid) break;        // fell out of the upper half
      handleEnd = i;
      handleHigh = Math.max(handleHigh, wb.h[i]);
      if (wb.l[i] < handleLow) { handleLow = wb.l[i]; handleLowI = i; }
    }

    // ---- pivot / right-edge timestamp ----
    let pivot, endIdx;
    if (type === "Double Bottom" && dbPivot != null) {
      pivot = dbPivot; endIdx = R;
    } else if (handleEnd > 0 && type === "Cup") {
      pivot = handleHigh + 0.1; endIdx = handleEnd; type = "Cup w/ Handle";
    } else {
      pivot = H + 0.1; endIdx = handleEnd > 0 ? handleEnd : R;
    }

    bases.push({
      type,
      pivot: round2(pivot),
      depth: Math.round(depth * 100),
      weeks: endIdx - L,
      t0: wb.t[L],          // left-side high
      tLow: wb.t[lowi],
      tRight: wb.t[R],      // right lip of the cup (before any handle)
      right: wb.h[R],       // price at the right lip
      tHandle: handleEnd > 0 ? wb.t[R] : null,
      tHandleLow: handleEnd > 0 ? wb.t[handleLowI] : null, // bottom of the handle
      handleLow: handleEnd > 0 ? handleLow : null,
      handlePct: handleEnd > 0 ? Math.round(((wb.h[R] - handleLow) / wb.h[R]) * 100) : null,
      tEnd: wb.t[endIdx],   // right edge (handle end or right lip)
      hLeft: H,
      low,
      pivotHigh: type === "Double Bottom" ? midPeak : handleEnd > 0 ? handleHigh : H,
    });
    guard = endIdx;
  }
  return bases.slice(-3);
}
