import { api } from "./api.js";
import { Chart } from "./chart.js";
import { initTools } from "./tools.js";
import { upDownVolume, adrPct, perf } from "./indicators.js";
import { fmtPrice, fmtNum, fmtPct, fmtChange, clsSign, esc } from "./fmt.js";

const $ = (id) => document.getElementById(id);

// Deep links: ?symbol=NVDA&tf=w&day=2026-06-04&pip=1  or  #NVDA/w  or  #TSLA/i5/2026-06-04
const params = new URLSearchParams(location.search);
const [hashSym, hashTf, hashDay] = location.hash.replace(/^#/, "").split("/");
const urlSymbol = params.get("symbol") || hashSym || "";
const urlTf = params.get("tf") || hashTf || "";
const urlDay = params.get("day") || hashDay || "";
const PIP = params.get("pip") === "1";
if (PIP) document.body.classList.add("pip");

const TFS = ["d", "w", "m", "i1", "i5", "i10", "i15", "i60"];

// ---------- persisted state (with migration from the old single watchlist) ----------

function loadLists() {
  try {
    const lists = JSON.parse(localStorage.getItem("vs.lists"));
    if (lists && typeof lists === "object" && Object.keys(lists).length) return lists;
  } catch {}
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem("ms.watchlist")); } catch {}
  return {
    Main: legacy?.length
      ? legacy
      : ["AAPL", "MSFT", "NVDA", "TSLA", "META", "AMZN", "GOOGL", "AVGO", "SPY", "QQQ"],
  };
}

const state = {
  symbol: urlSymbol.toUpperCase() || localStorage.getItem("ms.symbol") || "AAPL",
  tf: TFS.includes(urlTf) ? urlTf : localStorage.getItem("ms.tf") || "d",
  lastIntraday: localStorage.getItem("ms.lastIntraday") || "i10",
  day: /^\d{4}-\d{2}-\d{2}$/.test(urlDay) ? urlDay : null,
  log: localStorage.getItem("ms.log") !== "0",
  profile: null,
  quote: null,
  financials: null,
  rsRating: null,
  daily: null,
  lists: loadLists(),
  activeList: localStorage.getItem("vs.activeList"),
  alerts: (() => { try { return JSON.parse(localStorage.getItem("vs.alerts")) || {}; } catch { return {}; } })(),
  loadToken: 0,
};
if (state.tf === "i" || state.tf === "i30") state.tf = "i10";
if (state.lastIntraday === "i30") state.lastIntraday = "i10";
if (state.tf.startsWith("i")) state.lastIntraday = state.tf;
if (!state.lists[state.activeList]) state.activeList = Object.keys(state.lists)[0];

const isIntraday = () => state.tf.startsWith("i");
const wl = () => state.lists[state.activeList] || [];

function saveLists() {
  localStorage.setItem("vs.lists", JSON.stringify(state.lists));
  localStorage.setItem("vs.activeList", state.activeList);
}
function saveAlerts() {
  localStorage.setItem("vs.alerts", JSON.stringify(state.alerts));
}

const chart = new Chart($("chart"), $("overlay"), $("markup"));
chart.setLog(state.log);
const tools = initTools(chart, state, { onCompare: openCompareWindow });

// ---------------- symbol loading ----------------

async function loadSymbol(symbol, { keepView = false } = {}) {
  symbol = symbol.toUpperCase().trim();
  if (!symbol) return;
  const token = ++state.loadToken;
  const symbolChanged = symbol !== state.symbol;
  state.symbol = symbol;
  localStorage.setItem("ms.symbol", symbol);
  $("qhSymbol").textContent = symbol;
  if (!keepView) showMsg("Loading " + symbol + "…");
  highlightWatchlist();
  if (symbolChanged) {
    state.financials = null;
    state.daily = null;
    state.profile = null;
    state.rsRating = null;
  }

  try {
    const day = isIntraday() ? state.day : null;
    const [chartData, profile, financials] = await Promise.all([
      api.chart(symbol, state.tf, day),
      state.profile && !symbolChanged ? state.profile : api.profile(symbol).catch(() => null),
      state.financials && !symbolChanged
        ? state.financials
        : api.financials(symbol).catch(() => null),
    ]);
    if (token !== state.loadToken) return;
    state.profile = profile;
    state.financials = financials;
    chart.setData(chartData, { keepView, financials });
    chart.setAlertLines((state.alerts[symbol] || []).map((a) => a.price));
    tools.setSymbol(symbol);
    if (state.tf === "d") state.daily = chartData;
    showMsg(null);
    renderCompanyBar();
    renderFloatPanel();
    renderHeaderStats();
    pollQuote(true);
    fetchRsRating(symbol, token);
    if (state.tf !== "d" && !state.daily) {
      api.chart(symbol, "d").then((d) => {
        if (token === state.loadToken) {
          state.daily = d;
          renderFloatPanel();
          renderHeaderStats();
        }
      }).catch(() => {});
    }
  } catch (err) {
    if (token !== state.loadToken) return;
    showMsg(`${symbol}: ${err.message}`);
  }
}

async function fetchRsRating(symbol, token, attempt = 0) {
  try {
    const r = await api.rsrating(symbol);
    if (token !== state.loadToken) return;
    if (r.status === "ok") {
      state.rsRating = r;
      renderFloatPanel();
      chart.setRsRating(r.rating);
    } else if (r.status === "warming" && attempt < 8) {
      setTimeout(() => fetchRsRating(symbol, token, attempt + 1), 15000);
    }
  } catch {}
}

function showMsg(text) {
  const el = $("chartMsg");
  if (text) { el.textContent = text; el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

let toastTimer = 0;
function showToast(msg, ms = 5000) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------------- timeframe / scale / replay controls ----------------

function syncTfControls() {
  for (const b of document.querySelectorAll("#tfButtons button")) {
    b.classList.toggle("active", b.dataset.tf === state.tf);
  }
  $("intradayGroup").classList.toggle("active", isIntraday());
  if (isIntraday()) $("intradaySelect").value = state.tf;
  $("logToggle").classList.toggle("active", state.log);
  updateReplayBanner();
}

function setTimeframe(tf) {
  if (tf === state.tf) return;
  state.tf = tf;
  localStorage.setItem("ms.tf", tf);
  if (tf.startsWith("i")) {
    state.lastIntraday = tf;
    localStorage.setItem("ms.lastIntraday", tf);
  }
  syncTfControls();
  loadSymbol(state.symbol);
}

for (const btn of document.querySelectorAll("#tfButtons button")) {
  btn.addEventListener("click", () => setTimeframe(btn.dataset.tf));
}
$("intradaySelect").addEventListener("change", (e) => setTimeframe(e.target.value));

function setReplayDay(day) {
  state.day = day;
  $("daySelect").value = day || "";
  if (day && !isIntraday()) {
    state.tf = state.lastIntraday;
    localStorage.setItem("ms.tf", state.tf);
  }
  syncTfControls();
  loadSymbol(state.symbol);
}

$("daySelect").addEventListener("change", (e) => setReplayDay(e.target.value || null));

function stepDay(delta) {
  const todayIso = new Date().toISOString().slice(0, 10);
  let d = state.day ? new Date(state.day + "T12:00:00") : new Date();
  do {
    d = new Date(d.getTime() + delta * 86400000);
  } while (d.getDay() === 0 || d.getDay() === 6);
  const iso = d.toISOString().slice(0, 10);
  if (iso >= todayIso) return setReplayDay(null); // walked back to the present
  if (iso < $("daySelect").min) return showToast("Yahoo only keeps ~30 days of intraday history");
  setReplayDay(iso);
}
$("dayPrev").addEventListener("click", () => stepDay(-1));
$("dayNext").addEventListener("click", () => stepDay(1));

function updateReplayBanner() {
  const el = $("replayBanner");
  if (state.day && isIntraday()) {
    const d = new Date(state.day + "T12:00:00");
    el.innerHTML =
      `Replaying <b>${d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</b>` +
      ` — live updates paused <button id="replayClear">Back to live</button>`;
    el.classList.remove("hidden");
    $("replayClear").addEventListener("click", () => setReplayDay(null));
  } else {
    el.classList.add("hidden");
  }
}

$("logToggle").addEventListener("click", () => {
  state.log = !state.log;
  localStorage.setItem("ms.log", state.log ? "1" : "0");
  $("logToggle").classList.toggle("active", state.log);
  chart.setLog(state.log);
});

// ---------------- top-bar utilities: PiP, screenshot, reset ----------------

$("pipBtn").addEventListener("click", () => {
  const url = `${location.origin}/?pip=1#${state.symbol}/${state.tf}${state.day ? "/" + state.day : ""}`;
  window.open(url, "vsPip" + Date.now(), "width=1000,height=640,menubar=no,toolbar=no,location=no");
});

$("shotBtn").addEventListener("click", () => {
  const src = chart.canvas;
  const dpr = window.devicePixelRatio || 1;
  const headH = Math.round(34 * dpr);
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height + headH;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.fillStyle = "#1c2430";
  ctx.font = `bold ${Math.round(15 * dpr)}px Segoe UI, sans-serif`;
  const tfName = { d: "Daily", w: "Weekly", m: "Monthly" }[state.tf] || state.tf.slice(1) + " Min";
  const q = state.quote;
  let title = `${state.symbol}  ${state.profile?.name || ""}  —  ${tfName}`;
  if (q?.last != null) title += `  ·  ${fmtPrice(q.last)}`;
  title += `  ·  ${new Date().toLocaleString()}  ·  VeganSurge`;
  ctx.fillText(title, Math.round(10 * dpr), Math.round(22 * dpr));
  ctx.drawImage(src, 0, headH);
  ctx.drawImage(chart.markupCanvas, 0, headH);
  const a = document.createElement("a");
  a.download = `VS_${state.symbol}_${state.tf}_${new Date().toISOString().slice(0, 10)}.png`;
  a.href = out.toDataURL("image/png");
  a.click();
  showToast("Screenshot downloaded");
});

$("resetBtn").addEventListener("click", () => {
  chart.resetView();
  tools.resetAll?.();
  showToast("View reset");
});

// ---------------- alerts ----------------

function alertsFor(sym) {
  return state.alerts[sym] || [];
}

function renderAlertPop() {
  $("alertSym").textContent = state.symbol;
  const list = alertsFor(state.symbol);
  $("alertList").innerHTML = list.length
    ? list
        .map(
          (a, i) =>
            `<div class="item"><span>${a.dir === "above" ? "▲ above" : "▼ below"} ` +
            `<b>${fmtPrice(a.price)}</b></span><button data-i="${i}" title="Remove">✕</button></div>`
        )
        .join("")
    : `<div class="pop-note">No alerts for ${state.symbol} yet.</div>`;
  for (const b of $("alertList").querySelectorAll("button")) {
    b.addEventListener("click", () => {
      state.alerts[state.symbol].splice(Number(b.dataset.i), 1);
      saveAlerts();
      renderAlertPop();
      chart.setAlertLines(alertsFor(state.symbol).map((a) => a.price));
    });
  }
}

$("alertBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("listAddPop").classList.add("hidden");
  $("alertPop").classList.toggle("hidden");
  if (!$("alertPop").classList.contains("hidden")) {
    renderAlertPop();
    $("alertPrice").value = "";
    $("alertPrice").focus();
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }
});

function addAlert() {
  const price = parseFloat($("alertPrice").value);
  const last = state.quote?.last;
  if (!isFinite(price) || price <= 0) return;
  const dir = last != null && price < last ? "below" : "above";
  (state.alerts[state.symbol] = state.alerts[state.symbol] || []).push({ price, dir });
  saveAlerts();
  $("alertPrice").value = "";
  renderAlertPop();
  chart.setAlertLines(alertsFor(state.symbol).map((a) => a.price));
  showToast(`Alert set: ${state.symbol} ${dir} ${fmtPrice(price)}`);
}
$("alertAdd").addEventListener("click", addAlert);
$("alertPrice").addEventListener("keydown", (e) => e.key === "Enter" && addAlert());

function checkAlerts(sym, last) {
  const list = state.alerts[sym];
  if (!list?.length || last == null) return;
  const fired = [];
  state.alerts[sym] = list.filter((a) => {
    const hit = a.dir === "above" ? last >= a.price : last <= a.price;
    if (hit) fired.push(a);
    return !hit;
  });
  if (fired.length) {
    saveAlerts();
    for (const a of fired) {
      const msg = `${sym} crossed ${a.dir} ${fmtPrice(a.price)} — now ${fmtPrice(last)}`;
      showToast("🔔 " + msg, 9000);
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("VeganSurge alert", { body: msg });
      }
    }
    if (sym === state.symbol) {
      chart.setAlertLines(alertsFor(sym).map((a) => a.price));
      if (!$("alertPop").classList.contains("hidden")) renderAlertPop();
    }
  }
}

// ---------------- add to list dropdown ----------------

$("listAddBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("alertPop").classList.add("hidden");
  const pop = $("listAddPop");
  pop.classList.toggle("hidden");
  if (pop.classList.contains("hidden")) return;
  pop.innerHTML =
    Object.keys(state.lists)
      .map((name) => {
        const inList = state.lists[name].includes(state.symbol);
        return `<div class="choice ${inList ? "inlist" : ""}" data-name="${esc(name)}">` +
          `${inList ? "✓ " : ""}${esc(name)}</div>`;
      })
      .join("") + `<div class="choice" data-new="1">＋ New list…</div>`;
  for (const c of pop.querySelectorAll(".choice")) {
    c.addEventListener("click", () => {
      if (c.dataset.new) {
        const name = prompt("New list name:");
        if (!name || state.lists[name]) return;
        state.lists[name] = [state.symbol];
        state.activeList = name;
      } else {
        const name = c.dataset.name;
        const list = state.lists[name];
        if (list.includes(state.symbol)) {
          state.lists[name] = list.filter((s) => s !== state.symbol);
        } else {
          list.push(state.symbol);
        }
      }
      saveLists();
      renderListSelect();
      renderWatchlist();
      refreshWatchlistQuotes();
      pop.classList.add("hidden");
    });
  }
});

document.addEventListener("click", (e) => {
  if (!$("alertPop").contains(e.target) && e.target !== $("alertBtn")) {
    $("alertPop").classList.add("hidden");
  }
  if (!$("listAddPop").contains(e.target) && e.target !== $("listAddBtn")) {
    $("listAddPop").classList.add("hidden");
  }
});

// ---------------- company bar ----------------

function renderCompanyBar() {
  const p = state.profile;
  $("qhName").textContent = p?.name && p.name !== state.symbol ? p.name : "";
  $("qhIndustry").textContent = [p?.industry, p?.sector].filter(Boolean).join(" · ");
  $("qhSummary").textContent = p?.summary || "";
  const site = p?.website;
  const safeSite = /^https?:\/\//i.test(site || "") ? site : null;
  $("qhWebsite").textContent = safeSite ? safeSite.replace(/^https?:\/\/(www\.)?/, "") : "";
  $("qhWebsite").href = safeSite || "#";
}

function renderHeaderStats() {
  const p = state.profile;
  const d = state.daily?.bars;
  const q = state.quote;
  const pairs = [];
  const pair = (k, v, cls = "") =>
    v != null && pairs.push(`<div class="pair"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`);

  const usDate = (iso) => {
    if (!iso) return null;
    const [y, m, d] = iso.slice(0, 10).split("-");
    return `${m}/${d}/${y}`;
  };
  pair("IPO Date", p?.ipoDate);
  pair("EPS Due Date", usDate(p?.nextEarnings));
  pair("50 Days Avg Vol.", p?.avgVolume ? p.avgVolume.toLocaleString("en-US") : null);
  const px = q?.last ?? (d ? d.c[d.c.length - 1] : null);
  pair("50 Day Avg $ Vol.", p?.avgVolume && px ? "$" + fmtNum(p.avgVolume * px, 2) : null);
  pair("Market Cap.", p?.marketCap ? "$" + fmtNum(p.marketCap, 2) : null);
  if (d) {
    const atr = atr21Pct(d);
    pair("21 Day ATR %", atr != null ? atr.toFixed(2) + "%" : null);
  }
  pair("HQ", p?.hq ? esc(p.hq) : null);
  if (p?.high52 && q?.last) {
    const off = (q.last / p.high52 - 1) * 100;
    pair("Off 52-Wk High", fmtPct(off), clsSign(off));
  }
  $("qhStats").innerHTML = pairs.join("");
}

function atr21Pct(d, period = 21) {
  const n = d.c.length;
  if (n < period + 1) return null;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    const tr = Math.max(
      d.h[i] - d.l[i],
      Math.abs(d.h[i] - d.c[i - 1]),
      Math.abs(d.l[i] - d.c[i - 1])
    );
    sum += tr;
  }
  return (sum / period / d.c[n - 1]) * 100;
}

function renderQuoteHeader(q) {
  if (q.last == null) return;
  $("qhPrice").textContent = "$" + fmtPrice(q.last);
  const chg = q.prevClose ? q.last - q.prevClose : null;
  const pct = q.prevClose ? (chg / q.prevClose) * 100 : null;
  const el = $("qhChange");
  el.textContent =
    chg != null ? `(${chg >= 0 ? "+" : "−"}$${Math.abs(chg).toFixed(2)}) ${fmtPct(pct)}` : "";
  el.className = clsSign(chg);
  let volTxt = q.volume != null ? `Vol. ${q.volume.toLocaleString("en-US")}` : "";
  const avg = state.profile?.avgVolume;
  if (q.volume && avg) volTxt += ` (${fmtPct((q.volume / avg - 1) * 100)})`;
  $("qhVolume").textContent = volTxt;
}

// ---------------- live polling ----------------

function isMarketHours() {
  const now = new Date();
  const et = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    weekday: "short", hour: "numeric", minute: "numeric",
  }).formatToParts(now).reduce((a, p) => ((a[p.type] = p.value), a), {});
  if (et.weekday === "Sat" || et.weekday === "Sun") return false;
  const mins = parseInt(et.hour) * 60 + parseInt(et.minute);
  return mins >= 570 && mins < 960;
}

async function pollQuote(force = false) {
  if (!state.symbol) return;
  try {
    const q = await api.quote(state.symbol);
    if (q.symbol !== state.symbol) return;
    state.quote = q;
    renderQuoteHeader(q);
    renderHeaderStats();
    checkAlerts(state.symbol, q.last);
    if (state.day) return;
    const lastT = chart.bars?.t[chart.n - 1];
    if (lastT == null) return;
    const sameDay =
      new Date(lastT * 1000).toDateString() === new Date(q.ts * 1000).toDateString();
    if (state.tf === "d" && sameDay) chart.updateLastBar(q);
    else if (isIntraday() && sameDay && q.ts < lastT + 2 * intradaySecs()) {
      chart.updateLastBar({ last: q.last, dayHigh: null, dayLow: null, volume: null });
    }
  } catch {}
}

function intradaySecs() {
  return { i1: 60, i5: 300, i10: 600, i15: 900, i60: 3600 }[state.tf] || 600;
}

function updateLiveStatus() {
  const open = isMarketHours();
  $("liveStatus").classList.toggle("on", open && !state.day);
  $("liveText").textContent = state.day ? "Replay" : open ? "Live" : "Closed";
}

setInterval(pollQuote, 4000);
setInterval(updateLiveStatus, 30000);
updateLiveStatus();

let refreshTick = 0;
setInterval(() => {
  refreshTick++;
  if (!isMarketHours() || state.day) return;
  if (isIntraday()) loadSymbol(state.symbol, { keepView: true });
  else if (state.tf === "d" && refreshTick % 5 === 0) loadSymbol(state.symbol, { keepView: true });
}, 60000);

// ---------------- floating stats panel (landscape) ----------------

$("fpToggle").addEventListener("click", () => {
  const fp = $("floatPanel");
  fp.classList.toggle("collapsed");
  const collapsed = fp.classList.contains("collapsed");
  $("fpToggle").textContent = collapsed ? "›" : "‹";
  localStorage.setItem("ms.fpCollapsed", collapsed ? "1" : "0");
});
if (localStorage.getItem("ms.fpCollapsed") === "1") {
  $("floatPanel").classList.add("collapsed");
  $("fpToggle").textContent = "›";
}

function renderFloatPanel() {
  const fp = $("floatPanel");
  if (isIntraday() || PIP) {
    fp.classList.add("hidden");
    return;
  }
  const fin = state.financials;
  const p = state.profile;
  const d = state.daily?.bars;
  const parts = [];

  if (fin?.annual?.length) {
    let t = `<table class="annual"><tr><th>Year (${fin.fyMonth})</th><th>EPS ($)</th><th>EPS<br>% Chg</th><th>Sales ($M)</th><th>Sales<br>% Chg</th></tr>`;
    for (const r of fin.annual) {
      const arrow =
        r.trend === "up" ? ` <span class="tr-up">▲</span>` :
        r.trend === "down" ? ` <span class="tr-down">▼</span>` : "";
      t += `<tr${r.est ? ' class="est"' : ""}>` +
        `<td>${r.year}${r.est ? " e" : ""}</td>` +
        `<td>${r.eps != null ? r.eps.toFixed(2) : "—"}</td>` +
        `<td class="${pctCls(r.epsPct)}">${pctCell(r.epsPct)}${arrow}</td>` +
        `<td>${r.sales != null ? fmtSalesM(r.sales) : "—"}</td>` +
        `<td class="${pctCls(r.salesPct)}">${pctCell(r.salesPct)}</td></tr>`;
    }
    t += "</table>";
    parts.push(t);
  }

  const rows = [];
  const add = (k, v, cls = "") =>
    v != null && rows.push(`<div class="stat-row"><span class="k">${k}</span><span class="v ${cls}">${v}</span></div>`);

  const rsr = state.rsRating;
  add("RS Rating ≈", rsr ? `<span class="rs-badge">${rsr.rating}</span>` : "…");
  if (d) {
    const rel = (bars) => {
      const pf = perf(d.c, bars);
      const bench = state.daily.bench;
      if (pf == null || !bench) return null;
      const bvals = bench.filter((x) => x != null);
      const bp = perf(bvals, bars);
      return bp == null ? null : pf - bp;
    };
    const r3 = rel(63), r6 = rel(126);
    add("3 Mo RS vs SPX", r3 != null ? fmtPct(r3) : null, clsSign(r3));
    add("6 Mo RS vs SPX", r6 != null ? fmtPct(r6) : null, clsSign(r6));
    const udv = upDownVolume(d.c, d.v, 50);
    add("U/D Vol (50d)", udv ? udv.toFixed(2) : null, udv ? clsSign(udv - 1) : "");
    const adr = adrPct(d.h, d.l, 20);
    add("ADR (20d)", adr ? adr.toFixed(2) + "%" : null);
  }
  if (fin) {
    add("EPS Gro Rate (3y)", fin.epsGrowth3y != null ? fmtPct(fin.epsGrowth3y) : null, clsSign(fin.epsGrowth3y));
    add("Sales Gro Rate (3y)", fin.salesGrowth3y != null ? fmtPct(fin.salesGrowth3y) : null, clsSign(fin.salesGrowth3y));
    add("Earnings Surprise", fin.lastSurprise != null ? fmtPct(fin.lastSurprise) : null, clsSign(fin.lastSurprise));
  }
  if (p) {
    add("P/E (ttm)", p.trailingPE ? p.trailingPE.toFixed(1) : null);
    add("Float", p.floatShares ? fmtNum(p.floatShares) : null);
    add("Shares Out", p.sharesOutstanding ? fmtNum(p.sharesOutstanding) : null);
    add("52-Wk Range", p.low52 && p.high52 ? `${fmtPrice(p.low52)}–${fmtPrice(p.high52)}` : null);
    add("Avg Vol (50d)", p.avgVolume ? fmtNum(p.avgVolume) : null);
    add("Exchange", p.exchange ? esc(p.exchange) : null);
  }
  if (rows.length) parts.push(`<div class="fp-stats">${rows.join("")}</div>`);

  if (!parts.length) {
    fp.classList.add("hidden");
    return;
  }
  $("fpBody").innerHTML = parts.join("");
  fp.classList.remove("hidden");
}

function pctCell(v) {
  if (v == null) return "—";
  if (Math.abs(v) >= 1000) return v > 0 ? "+999%" : "-999%";
  return (v > 0 ? "+" : "") + Math.round(v) + "%";
}
function pctCls(v) {
  return v == null ? "" : v >= 0 ? "pos" : "neg";
}
function fmtSalesM(v) {
  return v >= 10000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(1);
}

// ---------------- compare window (used by the tools bar) ----------------

function openCompareWindow(symbols) {
  const url = `${location.origin}/compare.html?syms=${encodeURIComponent(symbols.join(","))}&tf=${state.tf.startsWith("i") ? "d" : state.tf}`;
  window.open(url, "vsCompare" + Date.now(), "width=1100,height=700,menubar=no,toolbar=no");
}

// ---------------- search ----------------

const searchInput = $("searchInput");
const searchResults = $("searchResults");
let searchTimer = 0;
let searchSel = -1;
let searchItems = [];

searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { hideSearch(); return; }
  searchTimer = setTimeout(async () => {
    try {
      searchItems = await api.search(q);
      searchSel = -1;
      renderSearch();
    } catch {}
  }, 180);
});

function renderSearch() {
  if (!searchItems.length) { hideSearch(); return; }
  searchResults.innerHTML = searchItems
    .map((it, i) =>
      `<div class="row ${i === searchSel ? "sel" : ""}" data-sym="${esc(it.symbol)}">` +
      `<span class="sym">${esc(it.symbol)}</span><span class="name">${esc(it.name)}</span>` +
      `<span class="exch">${esc(it.exchange)}</span></div>`)
    .join("");
  searchResults.classList.remove("hidden");
  for (const row of searchResults.querySelectorAll(".row")) {
    row.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pickSearch(row.dataset.sym);
    });
  }
}

function pickSearch(sym) {
  hideSearch();
  searchInput.value = "";
  searchInput.blur();
  loadSymbol(sym);
}

function hideSearch() {
  searchResults.classList.add("hidden");
  searchItems = [];
  searchSel = -1;
}

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!searchItems.length) return;
    searchSel = (searchSel + (e.key === "ArrowDown" ? 1 : -1) + searchItems.length) % searchItems.length;
    renderSearch();
  } else if (e.key === "Enter") {
    if (searchSel >= 0 && searchItems[searchSel]) pickSearch(searchItems[searchSel].symbol);
    else if (searchInput.value.trim()) pickSearch(searchInput.value.trim());
  } else if (e.key === "Escape") {
    hideSearch();
    searchInput.blur();
  }
});
searchInput.addEventListener("blur", () => setTimeout(hideSearch, 150));

// ---------------- watchlist (multiple named lists) ----------------

function renderListSelect() {
  $("listSelect").innerHTML = Object.keys(state.lists)
    .map((n) => `<option ${n === state.activeList ? "selected" : ""}>${esc(n)}</option>`)
    .join("");
}

$("listSelect").addEventListener("change", (e) => {
  state.activeList = e.target.value;
  saveLists();
  renderWatchlist();
  refreshWatchlistQuotes();
});

$("listNew").addEventListener("click", () => {
  const name = prompt("New list name:");
  if (!name || state.lists[name]) return;
  state.lists[name] = [];
  state.activeList = name;
  saveLists();
  renderListSelect();
  renderWatchlist();
});

$("listDel").addEventListener("click", () => {
  if (Object.keys(state.lists).length <= 1) return showToast("Can't delete the last list");
  if (!confirm(`Delete list "${state.activeList}"?`)) return;
  delete state.lists[state.activeList];
  state.activeList = Object.keys(state.lists)[0];
  saveLists();
  renderListSelect();
  renderWatchlist();
  refreshWatchlistQuotes();
});

function renderWatchlist() {
  $("watchlist").innerHTML = wl()
    .map((s) =>
      `<div class="wl-row" data-sym="${esc(s)}">` +
      `<span class="sym">${esc(s)}</span><span class="px" id="wlp-${esc(s)}">—</span>` +
      `<span class="chg" id="wlc-${esc(s)}"></span>` +
      `<button class="rm" title="Remove">✕</button></div>`)
    .join("");
  for (const row of $("watchlist").querySelectorAll(".wl-row")) {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("rm")) {
        state.lists[state.activeList] = wl().filter((s) => s !== row.dataset.sym);
        saveLists();
        renderWatchlist();
      } else {
        loadSymbol(row.dataset.sym);
      }
    });
  }
  highlightWatchlist();
}

function highlightWatchlist() {
  for (const row of $("watchlist").querySelectorAll(".wl-row")) {
    row.classList.toggle("active", row.dataset.sym === state.symbol);
  }
}

async function refreshWatchlistQuotes() {
  const alertSyms = Object.keys(state.alerts).filter((s) => state.alerts[s].length);
  const syms = [...new Set([...wl(), ...alertSyms])];
  for (const s of syms) {
    try {
      const q = await api.quote(s);
      checkAlerts(s, q.last);
      const px = $(`wlp-${s}`), ch = $(`wlc-${s}`);
      if (!px || q.last == null) continue;
      px.textContent = fmtPrice(q.last);
      if (q.prevClose) {
        const pct = (q.last / q.prevClose - 1) * 100;
        ch.textContent = fmtPct(pct);
        ch.className = "chg " + clsSign(pct);
      }
    } catch {}
  }
}

$("wlAdd").addEventListener("click", () => {
  if (state.symbol && !wl().includes(state.symbol)) {
    wl().push(state.symbol);
    saveLists();
    renderWatchlist();
    refreshWatchlistQuotes();
  }
});

setInterval(refreshWatchlistQuotes, 15000);

// ---------------- keyboard ----------------

document.addEventListener("keydown", (e) => {
  const t = e.target;
  if (t === searchInput || t.tagName === "SELECT" || t.tagName === "INPUT") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "arrowup" || k === "arrowdown") {
    e.preventDefault();
    const list = wl();
    if (!list.length) return;
    const idx = list.indexOf(state.symbol);
    const next = idx === -1 ? 0 : (idx + (k === "arrowdown" ? 1 : -1) + list.length) % list.length;
    loadSymbol(list[next]);
  } else if (k === "d") setTimeframe("d");
  else if (k === "w") setTimeframe("w");
  else if (k === "m") setTimeframe("m");
  else if (k === "i") setTimeframe(state.lastIntraday);
  else if (k === "l") $("logToggle").click();
  else if (/^[a-z0-9]$/.test(k)) searchInput.focus();
});

// ---------------- boot ----------------

(() => {
  const today = new Date();
  const min = new Date(today.getTime() - 29 * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  $("daySelect").max = iso(today);
  $("daySelect").min = iso(min);
  if (state.day) {
    if (!isIntraday()) state.tf = state.lastIntraday;
    $("daySelect").value = state.day;
  }
})();

syncTfControls();
renderListSelect();
renderWatchlist();
refreshWatchlistQuotes();
loadSymbol(state.symbol);
// PiP/popup windows can report a 0-height chart area on first paint; re-measure
requestAnimationFrame(() => chart.resize());
window.addEventListener("load", () => chart.resize());
