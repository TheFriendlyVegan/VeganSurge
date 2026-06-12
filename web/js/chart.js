// VeganSurge canvas chart engine — IBD/MarketSurge conventions.
// Dotted gridlines, dynamic font scaling, multiple chart types, studies
// (EMA/Bollinger/VWAP), RS line w/ rating + new-high dots, S&P 500 overlay,
// swing labels, volume peak labels, bottom-anchored earnings flags,
// quarterly footer grid, pattern overlays, alert lines, track-price box.

import { sma, rsLine } from "./indicators.js";
import { fmtPrice, fmtNum, fmtDate, fmtDateTime, fmtPct } from "./fmt.js";

const COLORS = {
  up: "#2534e9",        // MS blue
  down: "#df38b0",      // MS magenta
  gridDot: "#dcdcdc",   // dotted minor gridlines
  gridSolid: "#d9d9d9", // solid major (labeled) gridlines
  gridQtr: "#c7c7c7",   // solid quarter-boundary verticals
  gridStrong: "#dfe4ea",
  axis: "#5d6c7c",
  text: "#1a2028",
  rs: "#2534e9",
  rsLabel: "#5050ff",
  spx: "#1a1a1a",
  avgVol: "#ff5c40",    // solid orange-red avg volume line
  pos: "#007942",
  neg: "#d3494f",
  earnArrow: "#39424d",
  earnCaption: "#72767b",
  crosshair: "#5b6470",
  pivot: "#454545",
  pattern: "#2f7d32",
  alert: "#027d42",
  bb: "#7048e8",
  ema: "#0c8599",
  vwap: "#e8590c",
  footerSep: "#acb7c0",
  footerZebra: "#f0f1f1",
  footerHeaderFY: "#0073a2",
  footerCurrentSep: "#4b5969",
};

const MA_STYLES = {
  d: [
    { period: 21, color: "#2f9e44", label: "21d" },
    { period: 50, color: "#ff3939", label: "50d" },
    { period: 200, color: "#1a1a1a", label: "200d" },
  ],
  w: [
    { period: 10, color: "#ff3939", label: "10w" },
    { period: 40, color: "#1a1a1a", label: "40w" },
  ],
};

const DATE_AXIS_H = 24;
const VOL_FRAC = 0.2;
const RS_HIGH_WINDOW = { d: 252, w: 52, m: 12 };

export class Chart {
  constructor(canvas, overlay, markupCanvas) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.markupCanvas = markupCanvas;
    this.ctx = canvas.getContext("2d");
    this.octx = overlay.getContext("2d");
    this.bars = null;
    this.tf = "d";
    this.log = true;
    this.view = { start: 0, count: 1 };
    this.mouse = null;
    this.quarters = [];
    this.alertPrices = [];
    this.rsRating = null;
    this.chartType = "hlc";
    this.flags = {
      alerts: true,
      dataBox: false,
      footer: true,
      earnings: true,
      pivots: true,
      volPeaks: true,
      volLog: true, // MS default: logarithmic volume scale
      spx: true,
      rs: true,
      volAvg: true,
      mas: true,
      patterns: false,
      tightAreas: false,
      pivotZones: true,
      rsDots: true,
    };
    this.studies = { ema21: false, bb: false, vwap: false };
    this.afterRender = null;
    this._raf = 0;

    this._bindEvents();
    new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
    this.resize();
  }

  get isIntraday() {
    return this.tf.startsWith("i");
  }

  // dynamic font scale: grows with chart size
  px(s) {
    return Math.max(9, Math.round(s * this.fontScale));
  }
  font(s, weight = "") {
    return `${weight ? weight + " " : ""}${this.px(s)}px Segoe UI, sans-serif`;
  }

  // ---------- data ----------

  setData(data, { keepView = false, financials = null } = {}) {
    const prior =
      keepView && this.bars && this.tf === data.tf
        ? { count: this.view.count, fromEnd: this.n - (this.view.start + this.view.count) }
        : null;
    this.tf = data.tf;
    this.dayMode = !!data.day;
    const b = data.bars;
    this.bars = {
      t: b.t,
      o: Float64Array.from(b.o),
      h: Float64Array.from(b.h),
      l: Float64Array.from(b.l),
      c: Float64Array.from(b.c),
      v: Float64Array.from(b.v),
    };
    this.n = b.t.length;
    this.mas = (MA_STYLES[this.tf] || []).map((s) => ({
      ...s,
      values: sma(this.bars.c, s.period),
    }));
    this.bench = data.bench || null;
    this.rs = this.bench ? rsLine(this.bars.c, this.bench) : null;
    this.rsNewHigh = this.rs ? this._computeRsNewHighs() : null;
    this.volAvg = sma(this.bars.v, this.tf === "w" ? 10 : 50);
    this.earnings = (data.earnings || []).filter((e) => e.t >= b.t[0]);
    if (financials) this.financials = financials;
    this.quarters = (this.financials?.quarterly || []).filter(
      (q) => q.t >= b.t[0] && (q.eps != null || q.sales != null)
    );
    this.computeStudies();
    this._layout();
    if (prior) {
      this.view.count = prior.count;
      this.view.start = this.n - prior.fromEnd - prior.count;
      this._clampView();
      this.requestRender();
    } else {
      this.resetView();
    }
  }

  computeStudies() {
    if (!this.bars) return;
    const c = this.bars.c;
    this.ema21 = null;
    this.bb = null;
    this.vwap = null;
    if (this.studies.ema21) {
      const out = new Array(this.n).fill(null);
      const k = 2 / 22;
      let e = c[0];
      for (let i = 0; i < this.n; i++) {
        e = i ? c[i] * k + e * (1 - k) : c[0];
        if (i >= 10) out[i] = e;
      }
      this.ema21 = out;
    }
    if (this.studies.bb) {
      const mid = sma(c, 20);
      const up = new Array(this.n).fill(null);
      const lo = new Array(this.n).fill(null);
      for (let i = 19; i < this.n; i++) {
        let s = 0;
        for (let k = i - 19; k <= i; k++) s += (c[k] - mid[i]) ** 2;
        const sd = Math.sqrt(s / 20);
        up[i] = mid[i] + 2 * sd;
        lo[i] = mid[i] - 2 * sd;
      }
      this.bb = { mid, up, lo };
    }
    if (this.studies.vwap && this.isIntraday) {
      const out = new Array(this.n).fill(null);
      let cumPV = 0, cumV = 0, day = -1;
      for (let i = 0; i < this.n; i++) {
        const d = new Date(this.bars.t[i] * 1000).getDate();
        if (d !== day) { day = d; cumPV = 0; cumV = 0; }
        const tp = (this.bars.h[i] + this.bars.l[i] + this.bars.c[i]) / 3;
        cumPV += tp * this.bars.v[i];
        cumV += this.bars.v[i];
        if (cumV > 0) out[i] = cumPV / cumV;
      }
      this.vwap = out;
    }
  }

  setAlertLines(prices) {
    this.alertPrices = prices || [];
    this.requestRender();
  }
  setRsRating(r) {
    this.rsRating = r;
    this.requestRender();
  }

  _computeRsNewHighs() {
    const win = RS_HIGH_WINDOW[this.tf] || 252;
    const out = new Uint8Array(this.n);
    for (let i = 1; i < this.n; i++) {
      const r = this.rs[i];
      if (r == null) continue;
      let isHigh = true;
      for (let k = Math.max(0, i - win); k < i; k++) {
        if (this.rs[k] != null && this.rs[k] >= r) {
          isHigh = false;
          break;
        }
      }
      if (isHigh && i >= 10) out[i] = 1;
    }
    return out;
  }

  defaultBarCount() {
    if (this.dayMode) return this.n;
    if (this.isIntraday) return Math.min(this.n, { i1: 390, i5: 234, i10: 195, i15: 260, i60: 320 }[this.tf] || 280);
    return Math.min(this.n, { d: 252, w: 260, m: 240 }[this.tf] || 252);
  }

  resetView() {
    const want = this.defaultBarCount();
    const margin = Math.max(3, want * 0.08); // MS-style future projection margin
    this.view.count = want + margin;
    this.view.start = this.n - want;
    this.requestRender();
  }

  setLog(on) {
    this.log = on;
    this.requestRender();
  }

  updateLastBar(q) {
    if (!this.bars || !this.n || this.dayMode) return;
    const i = this.n - 1;
    if (q.last == null) return;
    this.bars.c[i] = q.last;
    if (q.dayHigh != null) this.bars.h[i] = Math.max(this.bars.h[i], q.dayHigh);
    if (q.dayLow != null) this.bars.l[i] = Math.min(this.bars.l[i], q.dayLow);
    if (q.volume != null) this.bars.v[i] = q.volume;
    for (const ma of this.mas) {
      if (i >= ma.period - 1) {
        let s = 0;
        for (let k = i - ma.period + 1; k <= i; k++) s += this.bars.c[k];
        ma.values[i] = s / ma.period;
      }
    }
    this.requestRender();
  }

  // ---------- geometry ----------

  footerLines() {
    if (!this.flags.footer || !this.quarters.length) return 0;
    // MS uses the same 3-row footer (header / EPS / Sales) on daily and weekly
    if (this.tf === "d" || this.tf === "w") return 3;
    return 0;
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    for (const cv of [this.canvas, this.overlay]) {
      cv.width = Math.max(50, Math.round(rect.width * dpr));
      cv.height = Math.max(50, Math.round(rect.height * dpr));
    }
    this.w = rect.width;
    this.h = rect.height;
    this.fontScale = Math.max(0.95, Math.min(1.6, rect.width / 1250));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._layout();
    this.requestRender();
  }

  _layout() {
    this.axisW = Math.round(46 + 18 * this.fontScale);
    this.footerRowH = Math.round(this.px(11) * 1.5);
    const dateAxisH = Math.round(DATE_AXIS_H * this.fontScale);
    const footerH = this.footerLines() * this.footerRowH + (this.footerLines() ? 6 : 0);
    this.footerH = footerH;
    const plotW = this.w - this.axisW;
    const plotH = this.h - dateAxisH - footerH;
    const volH = Math.round(plotH * VOL_FRAC);
    this.pricePane = { x: 0, y: 0, w: plotW, h: plotH - volH - 8 };
    this.volPane = { x: 0, y: plotH - volH, w: plotW, h: volH };
    this.dateAxisY = this.volPane.y + this.volPane.h;
    this.dateAxisH = dateAxisH;
    this.footerY = this.dateAxisY + dateAxisH;
  }

  indexToX(i) {
    return ((i - this.view.start + 0.5) / this.view.count) * this.pricePane.w;
  }
  xToIndex(x) {
    return this.view.start + (x / this.pricePane.w) * this.view.count - 0.5;
  }
  barWidth() {
    return this.pricePane.w / this.view.count;
  }

  _indexOfTime(ts) {
    const t = this.bars.t;
    let lo = 0, hi = this.n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < ts) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _visibleRange() {
    const i0 = Math.max(0, Math.floor(this.view.start));
    const i1 = Math.min(this.n - 1, Math.ceil(this.view.start + this.view.count));
    return [i0, i1];
  }

  _computeScales() {
    const [i0, i1] = this._visibleRange();
    let lo = Infinity, hi = -Infinity, vmax = 0, vmin = Infinity;
    for (let i = i0; i <= i1; i++) {
      if (this.bars.l[i] < lo) lo = this.bars.l[i];
      if (this.bars.h[i] > hi) hi = this.bars.h[i];
      if (this.bars.v[i] > vmax) vmax = this.bars.v[i];
      if (this.bars.v[i] > 0 && this.bars.v[i] < vmin) vmin = this.bars.v[i];
    }
    this.vLo = isFinite(vmin) ? Math.max(vmin * 0.7, vmax / 40) : vmax / 25;
    if (this.flags.mas) {
      for (const ma of this.mas) {
        for (let i = i0; i <= i1; i++) {
          const v = ma.values[i];
          if (v != null) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
      }
    }
    if (!isFinite(lo) || !isFinite(hi) || lo <= 0) { lo = 1; hi = 2; }
    if (hi === lo) { hi *= 1.05; lo *= 0.95; }

    if (this.log) {
      const pad = (Math.log(hi) - Math.log(lo)) * 0.06;
      this.pLo = Math.log(lo) - pad;
      this.pHi = Math.log(hi) + pad;
    } else {
      const pad = (hi - lo) * 0.06;
      this.pLo = lo - pad;
      this.pHi = hi + pad;
    }
    this.vMax = vmax || 1;

    this.rsScale = null;
    if (this.rs && this.flags.rs) {
      let rlo = Infinity, rhi = -Infinity;
      for (let i = i0; i <= i1; i++) {
        const r = this.rs[i];
        if (r != null) { if (r < rlo) rlo = r; if (r > rhi) rhi = r; }
      }
      if (isFinite(rlo) && rlo > 0 && rhi > rlo) {
        this.rsScale = { lo: Math.log(rlo), hi: Math.log(rhi) };
      }
    }

    this.spxScale = null;
    if (this.bench && this.flags.spx && !this.isIntraday) {
      let blo = Infinity, bhi = -Infinity;
      for (let i = i0; i <= i1; i++) {
        const b = this.bench[i];
        if (b != null) { if (b < blo) blo = b; if (b > bhi) bhi = b; }
      }
      if (isFinite(blo) && blo > 0 && bhi > blo) {
        this.spxScale = { lo: Math.log(blo), hi: Math.log(bhi) };
      }
    }
  }

  priceToY(p) {
    const v = this.log ? Math.log(Math.max(p, 1e-9)) : p;
    return this.pricePane.y + (1 - (v - this.pLo) / (this.pHi - this.pLo)) * this.pricePane.h;
  }
  yToPrice(y) {
    const f = 1 - (y - this.pricePane.y) / this.pricePane.h;
    const v = this.pLo + f * (this.pHi - this.pLo);
    return this.log ? Math.exp(v) : v;
  }
  rsToY(r) {
    const { lo, hi } = this.rsScale;
    const top = this.pricePane.y + this.pricePane.h * 0.55;
    const bot = this.pricePane.y + this.pricePane.h * 0.97;
    return bot - ((Math.log(r) - lo) / (hi - lo)) * (bot - top);
  }
  spxToY(b) {
    const { lo, hi } = this.spxScale;
    const top = this.pricePane.y + this.pricePane.h * 0.03;
    const bot = this.pricePane.y + this.pricePane.h * 0.26;
    return bot - ((Math.log(b) - lo) / (hi - lo)) * (bot - top);
  }
  volToY(v) {
    let f;
    if (this.flags.volLog) {
      // log scale across the realistic range (~25x below max, MS-style),
      // not down to zero — otherwise all bars render near-full height
      const hi = Math.log(this.vMax);
      const lo = Math.log(Math.max(1, this.vLo || this.vMax / 25));
      f = hi > lo ? Math.max(0, (Math.log(Math.max(v, 1)) - lo) / (hi - lo)) : 0;
    } else {
      f = v / this.vMax;
    }
    return this.volPane.y + this.volPane.h * (1 - f * 0.92);
  }
  volFromY(y) {
    const f = (1 - (y - this.volPane.y) / this.volPane.h) / 0.92;
    if (!this.flags.volLog) return f * this.vMax;
    const hi = Math.log(this.vMax);
    const lo = Math.log(Math.max(1, this.vLo || this.vMax / 25));
    return Math.exp(lo + f * (hi - lo));
  }

  // ---------- rendering ----------

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.bars || !this.n) return;

    this._computeScales();
    this._drawGrid(ctx);
    this._drawTimeAxis(ctx);
    this._drawPriceAxis(ctx);
    this._drawPatterns(ctx);
    this._drawVolume(ctx);
    this._drawSpx(ctx);
    this._drawRS(ctx);
    if (this.flags.mas) this._drawMAs(ctx);
    this._drawStudies(ctx);
    this._drawBars(ctx);
    if (this.flags.pivots) this._drawPivots(ctx);
    if (this.flags.earnings) this._drawEarningsFlags(ctx);
    this._drawFooter(ctx);
    if (this.flags.alerts) this._drawAlertLines(ctx);
    this._drawLegend(ctx);
    this._drawCrosshair();
    this.afterRender?.();
  }

  _drawGrid(ctx) {
    const p = this.pricePane;
    ctx.strokeStyle = COLORS.gridStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, p.y + 0.5, p.w, p.h);
    ctx.strokeRect(0.5, this.volPane.y + 0.5, this.volPane.w, this.volPane.h);
  }

  _priceTicks() {
    const ticks = [];
    const steps = Math.max(2, Math.floor(this.pricePane.h / (this.px(11) * 2.6)));
    for (let s = 0; s <= steps; s++) {
      const y = this.pricePane.y + (s / steps) * this.pricePane.h;
      let price = this.yToPrice(y);
      const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(price) || 1)) - 1);
      price = Math.round(price / mag) * mag;
      if (!ticks.length || Math.abs(ticks[ticks.length - 1] - price) > 1e-9) ticks.push(price);
    }
    return ticks;
  }

  _drawPriceAxis(ctx) {
    ctx.font = this.font(11);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let lastY = -100;
    for (const price of this._priceTicks()) {
      const y = this.priceToY(price);
      if (y < this.pricePane.y + 6 || y > this.pricePane.y + this.pricePane.h - 6) continue;
      if (Math.abs(y - lastY) < this.px(11) * 1.6) continue;
      // MS style: solid light major line at each labeled tick, plus a
      // dotted minor line midway between ticks
      if (lastY > -100) {
        const mid = (lastY + y) / 2;
        ctx.strokeStyle = COLORS.gridDot;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(0, Math.round(mid) + 0.5);
        ctx.lineTo(this.pricePane.w, Math.round(mid) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      lastY = y;
      ctx.strokeStyle = COLORS.gridSolid;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.pricePane.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(fmtPrice(price), this.pricePane.w + 6, y);
    }
    const last = this.bars.c[this.n - 1];
    const y = this.priceToY(last);
    if (y > this.pricePane.y && y < this.pricePane.y + this.pricePane.h) {
      const up = this.n < 2 || last >= this.bars.c[this.n - 2];
      const bh = this.px(11) + 6;
      ctx.fillStyle = up ? COLORS.up : COLORS.down;
      ctx.fillRect(this.pricePane.w + 1, y - bh / 2, this.axisW - 2, bh);
      ctx.fillStyle = "#fff";
      ctx.fillText(fmtPrice(last), this.pricePane.w + 6, y);
    }
  }

  _drawTimeAxis(ctx) {
    const [i0, i1] = this._visibleRange();
    const t = this.bars.t;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const intraday = this.isIntraday;
    const minGap = this.px(11) * 6;
    let lastX = -1000;

    for (let i = Math.max(i0, 1); i <= i1; i++) {
      const d = new Date(t[i] * 1000);
      const dp = new Date(t[i - 1] * 1000);
      let label = null, strong = false;
      if (intraday) {
        if (d.getDate() !== dp.getDate()) {
          label = fmtDate(t[i], false);
          strong = true;
        } else if (d.getHours() !== dp.getHours() && this.barWidth() > 9) {
          label = `${d.getHours() % 12 || 12}${d.getHours() >= 12 ? "p" : "a"}`;
        }
      } else {
        if (d.getFullYear() !== dp.getFullYear()) {
          label = String(d.getFullYear());
          strong = true;
        } else if (d.getMonth() !== dp.getMonth()) {
          label = fmtDate(t[i], false).split(" ")[0];
        }
      }
      if (!label) continue;
      const x = this.indexToX(i);
      if (x < 0 || x > this.pricePane.w) continue;
      if (!strong && x - lastX < minGap) continue;
      if (strong && x - lastX < 30) continue;
      lastX = x;
      // MS verticals: quarter boundaries solid #c7c7c7 full height,
      // plain months dotted light, year/day boundaries solid
      const isQtr = !intraday && [0, 3, 6, 9].includes(d.getMonth());
      ctx.strokeStyle = strong ? COLORS.gridQtr : isQtr ? COLORS.gridQtr : COLORS.gridDot;
      if (!strong && !isQtr) ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, this.pricePane.y);
      ctx.lineTo(Math.round(x) + 0.5, this.dateAxisY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = strong ? "#1a2028" : COLORS.axis;
      ctx.font = strong ? this.font(11, "bold") : this.font(11);
      ctx.fillText(label, x, this.dateAxisY + 5);
    }
  }

  // ---------- price plots ----------

  _barColor(i) {
    const prev = i > 0 ? this.bars.c[i - 1] : this.bars.o[i];
    return this.bars.c[i] >= prev ? COLORS.up : COLORS.down;
  }

  _drawBars(ctx) {
    const type = this.chartType;
    if (type === "line" || type === "mountain") return this._drawLineType(ctx, type);
    if (type === "candle" || type === "hollow") return this._drawCandles(ctx, type === "hollow");
    // hlc / cbar / bar
    const [i0, i1] = this._visibleRange();
    const bw = this.barWidth();
    const tick = Math.max(1.5, Math.min(bw * 0.38, 8));
    const lw = Math.max(1, Math.min(bw * 0.16, 2.4));
    ctx.lineWidth = lw;
    ctx.lineCap = "butt";
    const openTicks = type !== "hlc" || bw > 7;

    for (const phase of ["up", "down", "mono"]) {
      if (type === "bar" && phase !== "mono") continue;
      if (type !== "bar" && phase === "mono") continue;
      ctx.strokeStyle = phase === "mono" ? "#1a1a1a" : COLORS[phase];
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        if (type !== "bar") {
          const prev = i > 0 ? this.bars.c[i - 1] : this.bars.o[i];
          const isUp = this.bars.c[i] >= prev;
          if ((phase === "up") !== isUp) continue;
        }
        const x = Math.round(this.indexToX(i));
        ctx.moveTo(x + 0.5, this.priceToY(this.bars.h[i]));
        ctx.lineTo(x + 0.5, this.priceToY(this.bars.l[i]));
        const yc = this.priceToY(this.bars.c[i]);
        ctx.moveTo(x + 0.5, yc);
        ctx.lineTo(x + 0.5 + tick, yc);
        if (openTicks) {
          const yo = this.priceToY(this.bars.o[i]);
          ctx.moveTo(x + 0.5 - tick, yo);
          ctx.lineTo(x + 0.5, yo);
        }
      }
      ctx.stroke();
    }
  }

  _drawCandles(ctx, hollow) {
    const [i0, i1] = this._visibleRange();
    const bw = this.barWidth();
    const half = Math.max(1, Math.min(bw * 0.36, 9));
    ctx.lineWidth = 1;
    for (let i = i0; i <= i1; i++) {
      const o = this.bars.o[i], c = this.bars.c[i];
      const up = c >= o;
      const color = up ? COLORS.up : COLORS.down;
      const x = Math.round(this.indexToX(i)) + 0.5;
      const yh = this.priceToY(this.bars.h[i]);
      const yl = this.priceToY(this.bars.l[i]);
      const yo = this.priceToY(o);
      const yc = this.priceToY(c);
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, yh);
      ctx.lineTo(x, Math.min(yo, yc));
      ctx.moveTo(x, Math.max(yo, yc));
      ctx.lineTo(x, yl);
      ctx.stroke();
      const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
      if (hollow && up) {
        ctx.strokeRect(x - half, top, half * 2, hgt);
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(x - half, top, half * 2, hgt);
      }
    }
  }

  _drawLineType(ctx, type) {
    const [i0, i1] = this._visibleRange();
    ctx.strokeStyle = COLORS.up;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = "round";
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const x = this.indexToX(i), y = this.priceToY(this.bars.c[i]);
      i === i0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (type === "mountain") {
      ctx.lineTo(this.indexToX(i1), this.pricePane.y + this.pricePane.h);
      ctx.lineTo(this.indexToX(i0), this.pricePane.y + this.pricePane.h);
      ctx.closePath();
      const g = ctx.createLinearGradient(0, this.pricePane.y, 0, this.pricePane.y + this.pricePane.h);
      g.addColorStop(0, "rgba(23,99,184,0.25)");
      g.addColorStop(1, "rgba(23,99,184,0.02)");
      ctx.fillStyle = g;
      ctx.fill();
    }
  }

  _drawMAs(ctx) {
    for (const ma of this.mas) this._drawLine(ctx, ma.values, ma.color, 1.3, (v) => this.priceToY(v));
  }

  _drawStudies(ctx) {
    if (this.ema21) this._drawLine(ctx, this.ema21, COLORS.ema, 1.3, (v) => this.priceToY(v));
    if (this.vwap) this._drawLine(ctx, this.vwap, COLORS.vwap, 1.3, (v) => this.priceToY(v));
    if (this.bb) {
      ctx.setLineDash([3, 3]);
      this._drawLine(ctx, this.bb.up, COLORS.bb, 1, (v) => this.priceToY(v));
      this._drawLine(ctx, this.bb.lo, COLORS.bb, 1, (v) => this.priceToY(v));
      ctx.setLineDash([]);
      this._drawLine(ctx, this.bb.mid, COLORS.bb, 1, (v) => this.priceToY(v));
    }
  }

  _drawSpx(ctx) {
    if (!this.spxScale) return;
    this._drawLine(ctx, this.bench, COLORS.spx, 1.1, (v) => this.spxToY(v));
    // label ~15% in from the right and below the line, clear of the tools bar
    const [i0, i1] = this._visibleRange();
    const li = Math.max(i0, Math.min(this.n - 1, Math.round(i1 - (i1 - i0) * 0.15)));
    for (let i = li; i >= i0; i--) {
      if (this.bench[i] != null) {
        ctx.fillStyle = COLORS.spx;
        ctx.font = this.font(11.5);
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("S&P 500", Math.min(this.indexToX(i), this.pricePane.w - 40), this.spxToY(this.bench[i]) + 5);
        break;
      }
    }
  }

  _drawRS(ctx) {
    if (!this.rs || !this.rsScale) return;
    this._drawLine(ctx, this.rs, COLORS.rs, 1.5, (v) => this.rsToY(v));

    if (this.rsNewHigh && this.flags.rsDots) {
      const [i0, i1] = this._visibleRange();
      ctx.fillStyle = COLORS.rs;
      // dot size follows bar spacing so dense timeframes don't merge into chains
      const r = Math.min(Math.max(this.barWidth() * 0.3, 1.4), this.px(3));
      let lastX = -1e9;
      for (let i = i0; i <= i1; i++) {
        if (!this.rsNewHigh[i] || this.rs[i] == null) continue;
        const x = this.indexToX(i);
        if (x - lastX < r * 3) continue;
        lastX = x;
        ctx.beginPath();
        ctx.arc(x, this.rsToY(this.rs[i]), r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // MS-style two-line label at the line's right end: "RS Rating" / big value
    const [, i1] = this._visibleRange();
    for (let i = Math.min(i1, this.n - 1); i >= 0; i--) {
      if (this.rs[i] != null) {
        const lineEndX = this.indexToX(i);
        const y = this.rsToY(this.rs[i]);
        const inMargin = lineEndX < this.pricePane.w - this.px(11) * 6;
        const x = inMargin ? lineEndX + 8 : this.pricePane.w - 6;
        ctx.textAlign = inMargin ? "left" : "right";
        ctx.fillStyle = COLORS.rsLabel;
        ctx.font = this.font(10.5);
        ctx.textBaseline = "bottom";
        const caption = this.rsRating != null ? "RS Rating" : "RS";
        const value =
          this.rsRating != null
            ? String(this.rsRating)
            : String(Number((this.rs[i] * 1000).toPrecision(3)));
        ctx.fillText(caption, x, y - this.px(13) - 2);
        ctx.font = this.font(13.5, "bold");
        ctx.fillText(value, x, y - 1);
        break;
      }
    }
  }

  _drawLine(ctx, values, color, width, yFn) {
    const [i0, i1] = this._visibleRange();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = "round";
    ctx.beginPath();
    let started = false;
    for (let i = i0; i <= i1; i++) {
      const v = values[i];
      if (v == null) { started = false; continue; }
      const x = this.indexToX(i);
      const y = yFn(v);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // ---------- volume ----------

  _drawVolume(ctx) {
    const [i0, i1] = this._visibleRange();
    const bw = this.barWidth();
    const rectW = Math.max(1, bw * 0.6);
    const base = this.volPane.y + this.volPane.h;
    for (let i = i0; i <= i1; i++) {
      ctx.fillStyle = this._barColor(i);
      const x = this.indexToX(i);
      const y = this.volToY(this.bars.v[i]);
      ctx.fillRect(x - rectW / 2, y, rectW, base - y);
    }
    if (this.volAvg && this.flags.volAvg) {
      // MS: solid orange-red average-volume line
      this._drawLine(ctx, this.volAvg, COLORS.avgVol, 1.3, (v) => this.volToY(v));
    }
    // MS: stack of log-spaced volume scale labels down the right gutter
    ctx.fillStyle = COLORS.axis;
    ctx.font = this.font(10);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    const nLabels = Math.max(2, Math.min(5, Math.floor(this.volPane.h / (this.px(10) * 1.5))));
    for (let li = 0; li < nLabels; li++) {
      const y = this.volPane.y + 6 + (li / nLabels) * (this.volPane.h - 12);
      const v = this.volFromY(y);
      if (!isFinite(v) || v < 1) continue;
      ctx.fillText(fmtNum(v, 1), this.pricePane.w + 6, y);
    }

    // volume peak labels (local maxima, MS-style numbers above the spikes)
    if (this.flags.volPeaks) {
      const span = i1 - i0;
      if (span >= 20) {
        const w = Math.max(5, Math.round(span * 0.04));
        const minGapPx = this.px(11) * 5;
        let lastX = -1e9;
        ctx.font = this.font(9.5);
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillStyle = COLORS.pivot;
        for (let i = Math.max(i0, w); i <= Math.min(i1, this.n - 1 - w); i++) {
          const x = this.indexToX(i);
          if (x - lastX < minGapPx) continue;
          const v = this.bars.v[i];
          if (v < this.vMax * 0.25) continue;
          let ok = true;
          for (let k = i - w; k <= i + w && ok; k++) {
            if (k !== i && this.bars.v[k] >= v) ok = false;
          }
          if (ok) {
            ctx.fillText(fmtNum(v, 1), x, this.volToY(v) - 2);
            lastX = x;
          }
        }
      }
    }
  }

  // ---------- annotations ----------

  _drawPivots(ctx) {
    if (this.dayMode) return;
    const [i0, i1] = this._visibleRange();
    const span = i1 - i0;
    if (span < 20) return;
    const w = Math.max(4, Math.round(span * 0.035));
    ctx.font = this.font(11.5);
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.pivot;
    const minGapPx = this.px(11) * 6.5;
    let lastHighX = -1e9, lastLowX = -1e9;

    for (let i = Math.max(i0, w); i <= Math.min(i1, this.n - 1 - w); i++) {
      const x = this.indexToX(i);
      if (x - lastHighX > minGapPx) {
        const hv = this.bars.h[i];
        let ok = true;
        for (let k = i - w; k <= i + w && ok; k++) {
          if (k !== i && this.bars.h[k] >= hv) ok = false;
        }
        if (ok) {
          ctx.textBaseline = "bottom";
          ctx.fillText(fmtPrice(hv), x, this.priceToY(hv) - 3);
          lastHighX = x;
        }
      }
      if (x - lastLowX > minGapPx) {
        const lv = this.bars.l[i];
        let ok = true;
        for (let k = i - w; k <= i + w && ok; k++) {
          if (k !== i && this.bars.l[k] <= lv) ok = false;
        }
        if (ok) {
          ctx.textBaseline = "top";
          ctx.fillText(fmtPrice(lv), x, this.priceToY(lv) + 3);
          lastLowX = x;
        }
      }
    }
  }

  // MS earnings band: per report, a stacked [↑ arrow / "EPS" / bold ±%]
  // anchored at the bottom of the price pane, just above the volume pane.
  _drawEarningsFlags(ctx) {
    if (!this.earnings?.length || this.isIntraday) return;
    const [i0, i1] = this._visibleRange();
    const s = this.fontScale;
    const pctH = this.px(11.5);
    const capH = this.px(10);
    const aw = 5.5 * s, ah = 13 * s, sw = 2.2 * s;
    const bottom = this.pricePane.y + this.pricePane.h - 4;
    const barsPerQtr = { d: 63, w: 13, m: 3 }[this.tf] || 63;
    const minTextGap = this.px(10) * 3.2;
    const showTextGlobal = this.barWidth() * barsPerQtr > minTextGap;
    let lastTextX = -1e9;
    ctx.textAlign = "center";
    for (const e of this.earnings) {
      const idx = this._indexOfTime(e.t - 43200);
      if (idx < i0 || idx > i1) continue;
      const x = this.indexToX(idx);
      // per-marker collision avoidance: arrow always, text only with room
      const showText = showTextGlobal && x - lastTextX >= minTextGap;
      if (showText) lastTextX = x;
      const pctColor = e.yoy == null ? COLORS.earnCaption : e.yoy >= 0 ? COLORS.pos : COLORS.neg;
      let y = bottom;
      if (showText && e.yoy != null) {
        ctx.font = this.font(11.5, "bold");
        ctx.textBaseline = "bottom";
        ctx.fillStyle = pctColor;
        const txt = (e.yoy > 0 ? "+" : "") + Math.round(e.yoy) + "%";
        const tx = Math.max(x, ctx.measureText(txt).width / 2 + 2); // don't clip at left edge
        ctx.fillText(txt, tx, y);
        y -= pctH + 1;
      }
      if (showText) {
        ctx.font = this.font(10);
        ctx.textBaseline = "bottom";
        ctx.fillStyle = COLORS.earnCaption;
        ctx.fillText("EPS", x, y);
        y -= capH + 2;
      }
      // up arrow (dark slate, MS style)
      ctx.fillStyle = COLORS.earnArrow;
      ctx.beginPath();
      ctx.moveTo(x, y - ah);
      ctx.lineTo(x - aw, y - ah + aw * 1.25);
      ctx.lineTo(x - sw / 2, y - ah + aw * 1.25);
      ctx.lineTo(x - sw / 2, y);
      ctx.lineTo(x + sw / 2, y);
      ctx.lineTo(x + sw / 2, y - ah + aw * 1.25);
      ctx.lineTo(x + aw, y - ah + aw * 1.25);
      ctx.closePath();
      ctx.fill();
    }
  }

  // pattern recognition overlays: pivot zones + tight areas
  _drawPatterns(ctx) {
    if (!this.flags.patterns && !this.flags.pivotZones && !this.flags.tightAreas) return;
    if (this.isIntraday || !this.n) return;
    const [i0, i1] = this._visibleRange();
    const showPivotZones = this.flags.pivotZones || this.flags.patterns;
    const showTight = this.flags.tightAreas || this.flags.patterns;

    if (showTight) {
      const minRun = this.tf === "w" ? 3 : 5;
      const tol = 0.015;
      let runStart = -1;
      let runLo = 0, runHi = 0;
      const shade = (a, b) => {
        if (b - a + 1 < minRun) return;
        if (b < i0 || a > i1) return;
        const x0 = this.indexToX(a) - this.barWidth() / 2;
        const x1 = this.indexToX(b) + this.barWidth() / 2;
        const y0 = this.priceToY(runHi * (1 + 0.004));
        const y1 = this.priceToY(runLo * (1 - 0.004));
        ctx.fillStyle = "rgba(2,125,66,0.09)";
        ctx.strokeStyle = "rgba(2,125,66,0.45)";
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      };
      for (let i = Math.max(0, i0 - 10); i <= i1; i++) {
        const c = this.bars.c[i];
        if (runStart === -1) {
          runStart = i; runLo = c; runHi = c;
          continue;
        }
        const lo = Math.min(runLo, c), hi = Math.max(runHi, c);
        if ((hi - lo) / ((hi + lo) / 2) <= tol) {
          runLo = lo; runHi = hi;
        } else {
          shade(runStart, i - 1);
          runStart = i; runLo = c; runHi = c;
        }
      }
      shade(runStart, i1);
    }

    if (showPivotZones) {
      // most recent significant pivot high -> dashed buy-point line to the
      // right edge. Only a *current* base counts: recent bars, near price.
      const w = Math.max(5, Math.round((i1 - i0) * 0.04));
      const recency = { d: 140, w: 65, m: 24 }[this.tf] || 140;
      const lastClose = this.bars.c[this.n - 1];
      const searchLo = Math.max(Math.max(i0, w), this.n - 1 - recency);
      let pivotIdx = -1;
      for (let i = Math.min(i1, this.n - 1 - w); i >= searchLo; i--) {
        const hv = this.bars.h[i];
        let ok = true;
        for (let k = i - w; k <= i + w && ok; k++) {
          if (k !== i && this.bars.h[k] >= hv) ok = false;
        }
        if (ok) { pivotIdx = i; break; }
      }
      if (pivotIdx >= 0 && this.bars.h[pivotIdx] < lastClose * 0.7) pivotIdx = -1; // stale base
      if (pivotIdx >= 0) {
        const price = this.bars.h[pivotIdx];
        const y = this.priceToY(price);
        const x0 = this.indexToX(pivotIdx);
        ctx.strokeStyle = COLORS.pattern;
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(this.pricePane.w, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = this.font(10.5, "bold");
        ctx.fillStyle = COLORS.pattern;
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText(fmtPrice(price) + " pivot", Math.max(x0 + 6, this.pricePane.w - this.px(10) * 9), y - 3);
      }
    }
  }

  _drawAlertLines(ctx) {
    if (!this.alertPrices.length) return;
    for (const p of this.alertPrices) {
      const y = this.priceToY(p);
      if (y < this.pricePane.y || y > this.pricePane.y + this.pricePane.h) continue;
      ctx.strokeStyle = COLORS.alert;
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.pricePane.w, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      const bh = this.px(10) + 6;
      ctx.fillStyle = COLORS.alert;
      ctx.fillRect(this.pricePane.w + 1, y - bh / 2, this.axisW - 2, bh);
      ctx.fillStyle = "#fff";
      ctx.font = this.font(10, "bold");
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText("⚑" + fmtPrice(p), this.pricePane.w + 3, y);
    }
  }

  // ---------- quarterly footer ----------

  _drawFooter(ctx) {
    const lines = this.footerLines();
    if (!lines) return;
    const [i0, i1] = this._visibleRange();
    const t0 = this.bars.t[i0], t1 = this.bars.t[i1];
    const y0 = this.footerY;
    const plotW = this.pricePane.w;
    const rowH = this.footerRowH;
    const rowY = (r) => y0 + 4 + rowH * (r + 0.5);
    const fyMonth = this.financials?.fyMonth;

    // zebra band behind the EPS row (full width incl. gutter — MS style)
    ctx.fillStyle = COLORS.footerZebra;
    ctx.fillRect(0, y0 + 4 + rowH, this.w, rowH);

    ctx.strokeStyle = COLORS.footerSep;
    ctx.beginPath();
    ctx.moveTo(0, y0 + 0.5);
    ctx.lineTo(this.w, y0 + 0.5);
    ctx.stroke();

    // right-gutter row labels (bold, right-aligned like MS)
    ctx.font = this.font(9, "bold");
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("EPS ($), %", this.w - 4, rowY(1));
    ctx.fillText("Sales ($M), %", this.w - 4, rowY(2));

    const pctColor = (p) => (p == null ? COLORS.axis : p >= 0 ? COLORS.pos : COLORS.neg);
    const fmtPctCell = (p) =>
      p == null ? "N/A"
      : Math.abs(p) >= 1000 ? (p > 0 ? "+999%" : "-999%")
      : (p > 0 ? "+" : "") + Math.round(p) + "%";

    const qs = this.quarters;
    const lastReported = qs.length ? qs[qs.length - 1] : null;
    for (let qi = 0; qi < qs.length; qi++) {
      const q = qs[qi];
      if (q.t < t0 - 92 * 86400 || q.t > t1 + 200 * 86400) continue;
      const xEnd = Math.min(this.indexToX(this._indexOfTime(q.t)), plotW);
      const prevT = qi > 0 ? qs[qi - 1].t : q.t - 91 * 86400;
      const xStart = Math.max(this.indexToX(this._indexOfTime(prevT)), 0);
      const cw = xEnd - xStart;
      if (cw < 24) continue;

      // quarter separator; the latest reported quarter's right edge is
      // emphasized dark slate (start of the in-progress quarter)
      const isCurrentEdge = q === lastReported;
      ctx.strokeStyle = isCurrentEdge ? COLORS.footerCurrentSep : COLORS.footerSep;
      ctx.lineWidth = isCurrentEdge ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(xEnd) + 0.5, y0);
      ctx.lineTo(Math.round(xEnd) + 0.5, this.h);
      ctx.stroke();
      ctx.lineWidth = 1;

      // header: left-aligned bold; fiscal-year-end quarter in blue
      ctx.textBaseline = "middle";
      ctx.font = this.font(10.5, "bold");
      const endMonth = new Date(q.t * 1000).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
      const isFY = fyMonth && endMonth === fyMonth;
      ctx.fillStyle = isFY ? COLORS.footerHeaderFY : COLORS.text;
      ctx.textAlign = "left";
      const header = cw > this.px(10) * 17 ? q.full : q.label;
      if (cw > 34) ctx.fillText(header, xStart + 5, rowY(0), cw - 10);

      // value rows: right-aligned tab stops (cur 24% · "vs" 38% · prior 74% · % 98%)
      ctx.font = this.font(10);
      const wide = cw > this.px(10) * 13;
      const fmtEps = (v) => (v == null ? "" : v.toFixed(2));
      const fmtSales = (v) =>
        v == null ? "" : v >= 1000 ? Math.round(v).toLocaleString("en-US") : String(v);
      const drawVs = (r, cur, prior, pct) => {
        if (!cur && pct == null) return;
        const pctTxt = fmtPctCell(pct);
        if (wide && cur && prior) {
          ctx.fillStyle = COLORS.text;
          ctx.textAlign = "right";
          ctx.fillText(cur, xStart + cw * 0.24, rowY(r));
          ctx.fillStyle = COLORS.axis;
          ctx.font = this.font(9);
          ctx.fillText("vs", xStart + cw * 0.4, rowY(r));
          ctx.font = this.font(10);
          ctx.fillStyle = COLORS.text;
          ctx.fillText(prior, xStart + cw * 0.74, rowY(r));
          ctx.fillStyle = pctColor(pct);
          ctx.fillText(pctTxt, xStart + cw * 0.98, rowY(r));
        } else {
          ctx.fillStyle = pctColor(pct);
          ctx.textAlign = "right";
          ctx.fillText(pctTxt, xEnd - 4, rowY(r), cw - 6);
        }
      };
      drawVs(1, fmtEps(q.eps), fmtEps(q.epsPrior), q.epsPct);
      drawVs(2, fmtSales(q.sales), fmtSales(q.salesPrior), q.salesPct);
    }
  }

  _drawLegend(ctx) {
    ctx.font = this.font(10.5);
    ctx.textBaseline = "top";
    ctx.textAlign = "left";
    let x = 8;
    const y = this.pricePane.y + 6;
    if (this.flags.mas) {
      for (const ma of this.mas) {
        ctx.fillStyle = ma.color;
        ctx.fillText(`— ${ma.label}`, x, y);
        x += ctx.measureText(`— ${ma.label}`).width + 12;
      }
    }
    if (this.rs && this.rsScale) {
      ctx.fillStyle = COLORS.rs;
      ctx.fillText("— RS", x, y);
    }
  }

  // ---------- crosshair + track box ----------

  _drawCrosshair() {
    const ctx = this.octx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!this.mouse || !this.bars) return;
    const { x, y } = this.mouse;
    if (x > this.pricePane.w || y > this.dateAxisY) return;

    const i = Math.round(this.xToIndex(x));
    if (i < 0 || i >= this.n) return;
    const bx = this.indexToX(i);

    ctx.strokeStyle = COLORS.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(Math.round(bx) + 0.5, this.pricePane.y);
    ctx.lineTo(Math.round(bx) + 0.5, this.dateAxisY);
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(this.pricePane.w, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    if (y <= this.pricePane.y + this.pricePane.h) {
      const bh = this.px(11) + 6;
      ctx.fillStyle = "#3c4654";
      ctx.fillRect(this.pricePane.w + 1, y - bh / 2, this.axisW - 2, bh);
      ctx.fillStyle = "#fff";
      ctx.font = this.font(11);
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(fmtPrice(this.yToPrice(y)), this.pricePane.w + 6, y);
    }

    const dateStr = this.isIntraday ? fmtDateTime(this.bars.t[i]) : fmtDate(this.bars.t[i]);
    ctx.font = this.font(11);
    const tw = ctx.measureText(dateStr).width + 12;
    const dbx = Math.min(Math.max(bx - tw / 2, 0), this.pricePane.w - tw);
    ctx.fillStyle = "#3c4654";
    ctx.fillRect(dbx, this.dateAxisY + 2, tw, this.px(11) + 7);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(dateStr, dbx + tw / 2, this.dateAxisY + 2 + (this.px(11) + 7) / 2);

    if (this.flags.dataBox) {
      this._drawTrackBox(ctx, i, x, y);
    } else {
      this._drawOhlcStrip(ctx, i);
    }
  }

  _drawOhlcStrip(ctx, i) {
    const o = this.bars.o[i], h = this.bars.h[i], l = this.bars.l[i], c = this.bars.c[i], v = this.bars.v[i];
    const prev = i > 0 ? this.bars.c[i - 1] : o;
    const chg = prev ? ((c - prev) / prev) * 100 : 0;
    const parts = [
      ["O ", fmtPrice(o)], ["H ", fmtPrice(h)], ["L ", fmtPrice(l)], ["C ", fmtPrice(c)],
      ["", ` ${fmtPct(chg)}`], ["Vol ", fmtNum(v)],
    ];
    ctx.font = this.font(11);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    let px = 8;
    const py = this.pricePane.y + this.px(11) * 2;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillRect(4, py - 3, this.px(11) * 32, this.px(11) + 8);
    for (const [k, val] of parts) {
      ctx.fillStyle = COLORS.axis;
      ctx.fillText(k, px, py);
      px += ctx.measureText(k).width;
      ctx.fillStyle = k === "" ? (chg >= 0 ? COLORS.up : COLORS.down) : COLORS.text;
      ctx.fillText(val, px, py);
      px += ctx.measureText(val).width + 10;
    }
  }

  // MS "Track Price" data box: floating card near the cursor
  _drawTrackBox(ctx, i, mx, my) {
    const b = this.bars;
    const o = b.o[i], h = b.h[i], l = b.l[i], c = b.c[i], v = b.v[i];
    const prev = i > 0 ? b.c[i - 1] : o;
    const chg = c - prev;
    const pct = prev ? (chg / prev) * 100 : 0;
    const clsRange = h > l ? Math.round(((c - l) / (h - l)) * 100) + "%" : "—";
    const va = this.volAvg?.[i];
    const volPct = va ? ((v / va - 1) * 100) : null;

    const rows = [
      ["Date", this.isIntraday ? fmtDateTime(b.t[i]) : fmtDate(b.t[i]), COLORS.text],
      ["Open", fmtPrice(o), COLORS.text],
      ["High", fmtPrice(h), COLORS.text],
      ["Low", fmtPrice(l), COLORS.text],
      ["Last", `${fmtPrice(c)} ${chg >= 0 ? "+" : "−"}$${Math.abs(chg).toFixed(2)}`, chg >= 0 ? COLORS.pos : COLORS.down],
      ["% Chg", fmtPct(pct), pct >= 0 ? COLORS.pos : COLORS.down],
      ["Cls Range", clsRange, COLORS.text],
      ["Vol", v.toLocaleString("en-US"), COLORS.text],
      ["Vol %", volPct != null ? fmtPct(volPct) : "—", volPct == null ? COLORS.text : volPct >= 0 ? COLORS.pos : COLORS.down],
    ];
    for (const ma of this.mas) {
      const mv = ma.values[i];
      if (mv != null) {
        const d = ((c / mv - 1) * 100);
        rows.push([`SMA(${ma.period})`, `${fmtPrice(mv)} ${fmtPct(d)}`, ma.color]);
      }
    }

    const fs = this.px(11);
    const rowH = fs + 6;
    const W = fs * 17;
    const H = rows.length * rowH + 12;
    let X = mx + 18, Y = my + 14;
    if (X + W > this.pricePane.w - 4) X = mx - W - 18;
    if (Y + H > this.dateAxisY - 4) Y = this.dateAxisY - H - 4;
    if (Y < 4) Y = 4;

    ctx.fillStyle = "rgba(255,255,255,0.97)";
    ctx.strokeStyle = "#d4dae1";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(X, Y, W, H, 6);
    ctx.fill();
    ctx.stroke();
    ctx.font = this.font(11);
    ctx.textBaseline = "middle";
    rows.forEach((r, ri) => {
      const yy = Y + 8 + ri * rowH + rowH / 2 - 3;
      ctx.fillStyle = COLORS.axis;
      ctx.textAlign = "left";
      ctx.fillText(r[0], X + 10, yy);
      ctx.fillStyle = r[2];
      ctx.textAlign = "right";
      ctx.font = this.font(11, "600");
      ctx.fillText(r[1], X + W - 10, yy);
      ctx.font = this.font(11);
    });
  }

  // ---------- interaction ----------

  _bindEvents() {
    const el = this.overlay;

    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (!this.bars) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const anchor = this.xToIndex(x);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      let count = this.view.count * factor;
      count = Math.max(15, Math.min(count, this.n * 1.5));
      this.view.start = anchor - ((anchor - this.view.start) * count) / this.view.count;
      this.view.count = count;
      this._clampView();
      this.requestRender();
    }, { passive: false });

    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      drag = { x: e.clientX, start: this.view.start };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      const rect = el.getBoundingClientRect();
      this.mouse = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (drag) {
        const dx = e.clientX - drag.x;
        this.view.start = drag.start - dx / this.barWidth();
        this._clampView();
        this.requestRender();
      } else {
        this._drawCrosshair();
      }
    });
    el.addEventListener("pointerup", (e) => {
      drag = null;
      el.releasePointerCapture(e.pointerId);
    });
    el.addEventListener("pointerleave", () => {
      this.mouse = null;
      this.octx.clearRect(0, 0, this.w, this.h);
    });
    el.addEventListener("dblclick", () => this.resetView());
  }

  _clampView() {
    const maxStart = this.n - 5;
    const minStart = -this.view.count * 0.5;
    this.view.start = Math.max(minStart, Math.min(this.view.start, maxStart));
  }
}
