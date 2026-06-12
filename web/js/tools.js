// Floating chart tools bar, modeled on MarketSurge's:
// wrench (collapse) · markup · compare · track price · pattern recognition ·
// indicators · chart type · settings. Active tools get the green pill style.

import { Markup, TOOL_DEFS } from "./markup.js";

const GREEN = "#027d42";

function el(html) {
  const d = document.createElement("div");
  d.innerHTML = html.trim();
  return d.firstChild;
}

function toggleRow(label, key, on) {
  return (
    `<div class="trow" data-key="${key}"><span>${label}</span>` +
    `<span class="pill ${on ? "on" : ""}"></span></div>`
  );
}

export function initTools(chart, state, { onCompare }) {
  const bar = document.getElementById("toolsBar");
  const markup = new Markup(chart, document.getElementById("markup"));

  // persisted preferences
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem("vs.toolprefs")) || {}; } catch {}
  if (prefs.flags) Object.assign(chart.flags, prefs.flags);
  if (prefs.chartType) chart.chartType = prefs.chartType;
  if (prefs.studies) Object.assign(chart.studies, prefs.studies);

  function savePrefs() {
    localStorage.setItem(
      "vs.toolprefs",
      JSON.stringify({ flags: chart.flags, chartType: chart.chartType, studies: chart.studies })
    );
  }

  const BTNS = [
    { id: "wrench", icon: "🔧", title: "Tools" },
    { id: "markup", icon: "✎", title: "Markup" },
    { id: "compare", icon: "⇄", title: "Search & Compare" },
    { id: "track", icon: "✛", title: "Track Price" },
    { id: "pattern", icon: "✦", title: "Pattern Recognition", caret: true },
    { id: "indicators", icon: "∿", title: "Indicators", caret: true },
    { id: "ctype", icon: "▤", title: "Chart Type", caret: true },
    { id: "settings", icon: "⚙", title: "Chart Settings", caret: true },
  ];

  bar.innerHTML = BTNS.map(
    (b) =>
      `<button class="tool" data-id="${b.id}" title="${b.title}">${b.icon}${b.caret ? `<span class="caret">▾</span>` : ""}</button>`
  ).join("");

  const pop = el(`<div class="tool-pop pop hidden"></div>`);
  bar.appendChild(pop);
  let openPop = null;

  const btn = (id) => bar.querySelector(`[data-id="${id}"]`);
  const setOn = (id, on) => btn(id).classList.toggle("on", !!on);

  function closePop() {
    pop.classList.add("hidden");
    if (openPop && !["track", "markup"].includes(openPop)) setOn(openPop, false);
    openPop = null;
  }
  document.addEventListener("click", (e) => {
    if (!bar.contains(e.target)) closePop();
  });

  function showPop(id, html) {
    if (openPop === id) return closePop();
    closePop();
    openPop = id;
    setOn(id, true);
    pop.innerHTML = html;
    pop.classList.remove("hidden");
  }

  // ---------- wrench: collapse ----------
  let collapsed = !!prefs.collapsed;
  function applyCollapsed() {
    for (const b of bar.querySelectorAll(".tool")) {
      if (b.dataset.id !== "wrench") b.style.display = collapsed ? "none" : "";
    }
    setOn("wrench", !collapsed);
    if (collapsed) closePop();
  }
  btn("wrench").addEventListener("click", () => {
    collapsed = !collapsed;
    prefs.collapsed = collapsed;
    localStorage.setItem("vs.toolprefs", JSON.stringify({ ...JSON.parse(localStorage.getItem("vs.toolprefs") || "{}"), collapsed }));
    applyCollapsed();
  });

  // ---------- markup palette ----------
  const palette = el(`<div id="mkPalette" class="hidden">
    <div class="mk-row">
      <button data-act="undo" title="Undo">↶</button>
      <button data-act="redo" title="Redo">↷</button>
    </div>
    <div class="mk-grid">
      ${TOOL_DEFS.map((t) => `<button data-tool="${t.id}" title="${t.title}">${t.icon}</button>`).join("")}
    </div>
    <div class="mk-row">
      <input type="color" value="#e8590c" title="Color" id="mkColor">
    </div>
    <div class="mk-row mk-foot">
      <button data-act="eye" title="Show/hide markups">👁</button>
      <button data-act="trash" title="Delete all drawings">🗑</button>
    </div>
  </div>`);
  document.getElementById("chartWrap").appendChild(palette);

  let markupMode = false;
  btn("markup").addEventListener("click", () => {
    markupMode = !markupMode;
    setOn("markup", markupMode);
    palette.classList.toggle("hidden", !markupMode);
    if (!markupMode) markup.setTool(null);
    else if (!markup.tool) selectMkTool("trend");
  });

  function selectMkTool(id) {
    markup.setTool(id);
    for (const b of palette.querySelectorAll("[data-tool]")) {
      b.classList.toggle("on", b.dataset.tool === id);
    }
  }
  palette.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.tool) selectMkTool(t.dataset.tool);
    else if (t.dataset.act === "undo") markup.undo();
    else if (t.dataset.act === "redo") markup.redoOne();
    else if (t.dataset.act === "trash") { if (confirm("Delete all drawings for this symbol?")) markup.clear(); }
    else if (t.dataset.act === "eye") {
      markup.setVisible(!markup.visible);
      t.style.opacity = markup.visible ? 1 : 0.4;
    }
  });
  palette.querySelector("#mkColor").addEventListener("input", (e) => (markup.color = e.target.value));

  // ---------- compare ----------
  btn("compare").addEventListener("click", () => {
    const recent = JSON.parse(localStorage.getItem("vs.recentSyms") || "[]");
    showPop(
      "compare",
      `<div class="pop-title">Search and Compare</div>
       <div class="pop-row"><input id="cmpInput" placeholder="Symbol to compare with ${state.symbol}…"></div>
       ${recent.length ? `<div class="pop-note">Recent</div>` + recent.map((s) => `<div class="choice" data-s="${s}">${s}</div>`).join("") : ""}
       <div class="pop-note">Popular</div>
       ${["SPY", "QQQ", "^GSPC", "^IXIC"].map((s) => `<div class="choice" data-s="${s}">${s}</div>`).join("")}`
    );
    const go = (sym) => {
      if (!sym) return;
      const rec = [sym, ...recent.filter((x) => x !== sym)].slice(0, 6);
      localStorage.setItem("vs.recentSyms", JSON.stringify(rec));
      closePop();
      onCompare([state.symbol, sym]);
    };
    pop.querySelector("#cmpInput").focus();
    pop.querySelector("#cmpInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") go(e.target.value.trim().toUpperCase());
    });
    for (const c of pop.querySelectorAll(".choice")) {
      c.addEventListener("click", () => go(c.dataset.s));
    }
  });

  // ---------- track price ----------
  btn("track").addEventListener("click", () => {
    chart.flags.dataBox = !chart.flags.dataBox;
    setOn("track", chart.flags.dataBox);
    savePrefs();
    chart.requestRender();
  });
  setOn("track", chart.flags.dataBox);

  // ---------- pattern recognition ----------
  btn("pattern").addEventListener("click", () => {
    const f = chart.flags;
    showPop(
      "pattern",
      `<div class="pop-title">Pattern Recognition</div>` +
        toggleRow("All Patterns", "patterns", f.patterns) +
        toggleRow("Tight Areas", "tightAreas", f.tightAreas) +
        toggleRow("Pivot Zones", "pivotZones", f.pivotZones) +
        toggleRow("RS Blue Dot", "rsDots", f.rsDots)
    );
    wireToggles(() => chart.requestRender());
  });

  // ---------- indicators ----------
  btn("indicators").addEventListener("click", () => {
    const s = chart.studies;
    showPop(
      "indicators",
      `<div class="pop-title">Indicators</div>` +
        toggleRow("Moving Averages", "mas", chart.flags.mas) +
        toggleRow("EMA 21", "ema21", s.ema21) +
        toggleRow("Bollinger Bands (20,2)", "bb", s.bb) +
        toggleRow("VWAP (intraday)", "vwap", s.vwap) +
        toggleRow("RS Line", "rs", chart.flags.rs) +
        toggleRow("S&P 500 Overlay", "spx", chart.flags.spx) +
        toggleRow("Avg Volume Line", "volAvg", chart.flags.volAvg)
    );
    wireToggles((key, on) => {
      if (key in chart.studies) chart.studies[key] = on;
      else chart.flags[key] = on;
      chart.computeStudies?.();
      chart.requestRender();
    });
  });

  // ---------- chart type ----------
  const TYPES = [
    ["hlc", "IBD HLC Bar"],
    ["cbar", "Colored OHLC Bar"],
    ["bar", "Bar"],
    ["candle", "Candle"],
    ["hollow", "Hollow Candle"],
    ["line", "Line"],
    ["mountain", "Mountain"],
  ];
  btn("ctype").addEventListener("click", () => {
    showPop(
      "ctype",
      `<div class="pop-title">Chart Types</div>` +
        TYPES.map(
          ([id, label]) =>
            `<div class="rrow" data-type="${id}"><span>${label}</span>` +
            `<span class="radio ${chart.chartType === id ? "sel" : ""}"></span></div>`
        ).join("")
    );
    for (const r of pop.querySelectorAll(".rrow")) {
      r.addEventListener("click", () => {
        chart.chartType = r.dataset.type;
        savePrefs();
        chart.requestRender();
        for (const x of pop.querySelectorAll(".radio")) x.classList.remove("sel");
        r.querySelector(".radio").classList.add("sel");
      });
    }
  });

  // ---------- settings ----------
  btn("settings").addEventListener("click", () => {
    const f = chart.flags;
    showPop(
      "settings",
      `<div class="pop-title">Chart Display Elements</div>` +
        toggleRow("Alerts", "alerts", f.alerts) +
        toggleRow("Markups", "markupsVisible", markup.visible) +
        toggleRow("Data Boxes", "dataBox", f.dataBox) +
        toggleRow("EPS & Sales Table", "footer", f.footer) +
        toggleRow("Earnings", "earnings", f.earnings) +
        toggleRow("Marked Highs & Lows", "pivots", f.pivots) +
        toggleRow("Volume Peaks", "volPeaks", f.volPeaks) +
        `<div class="pop-title" style="margin-top:0.6rem">Volume Scale</div>` +
        toggleRow("Logarithmic Volume", "volLog", f.volLog)
    );
    wireToggles((key, on) => {
      if (key === "markupsVisible") markup.setVisible(on);
      else {
        chart.flags[key] = on;
        if (key === "dataBox") setOn("track", on);
        if (key === "footer") chart.resize();
      }
      chart.requestRender();
    });
  });

  function wireToggles(apply) {
    for (const row of pop.querySelectorAll(".trow")) {
      row.addEventListener("click", () => {
        const key = row.dataset.key;
        const pill = row.querySelector(".pill");
        const on = !pill.classList.contains("on");
        pill.classList.toggle("on", on);
        if (key in chart.flags) chart.flags[key] = on;
        apply(key, on);
        savePrefs();
      });
    }
  }

  applyCollapsed();

  return {
    setSymbol: (sym) => markup.setSymbol(sym),
    resetAll: () => {
      chart.flags.dataBox = false;
      setOn("track", false);
      markupMode = false;
      setOn("markup", false);
      palette.classList.add("hidden");
      markup.setTool(null);
      closePop();
    },
  };
}
