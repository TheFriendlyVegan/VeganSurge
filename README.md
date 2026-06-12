# VeganSurge

A fast, local rebuild of the IBD MarketSurge charting experience. Custom
canvas rendering (no chart library, no framework) keeps pan/zoom/redraw at
60 fps. Price data comes from Yahoo Finance; fundamentals come from SEC
EDGAR filings — no MarketSurge login or scraping involved.

## Quick start

**Easiest (Windows, no setup):** download `VeganSurge.exe` from the
[Releases page](../../releases), double-click it, and your browser opens to
the app. Windows SmartScreen may warn about an unsigned app — click
"More info → Run anyway".

**From source (any OS with Python 3.11+):**

```
git clone <this repo>
cd vegansurge
pip install -r requirements.txt
python -m uvicorn server.main:app --port 8520
```

then open <http://localhost:8520>. On Windows you can just double-click
**`run.bat`**.

Optional: set `VEGANSURGE_CONTACT=you@example.com` in your environment —
the SEC asks automated clients to identify themselves when fetching filings.

## Disclaimers

- Not affiliated with, endorsed by, or connected to Investor's Business
  Daily, MarketSurge, Yahoo, or S&P. "MarketSurge" is a trademark of its
  owner; this is an independent hobby project inspired by its layout.
- Market data is fetched at runtime from Yahoo Finance's unofficial APIs
  and SEC EDGAR, by you, for your own personal use. Nothing is redistributed
  by this project. Data may be delayed, wrong, or unavailable — do not use
  it as the basis for trading decisions. Not investment advice.
- Each user is responsible for their own compliance with data providers'
  terms of service. Don't host this publicly with live data.

## Features

- **Tools bar** (floating, collapsible via the 🔧 wrench): markup drawing
  (trend/horizontal/vertical lines, rectangles, ellipses, freehand — saved
  per symbol, anchored to price/time), search & compare (opens a separate
  comparison window with normalized % change lines), track-price data box,
  pattern recognition (pivot zones, tight areas, RS blue dots), indicator
  toggles (EMA 21, Bollinger Bands, VWAP, MAs, RS, S&P overlay), chart
  types (IBD HLC bar, OHLC bar, candle, hollow candle, line, mountain),
  and chart settings (show/hide each chart element, log volume scale).
- **Price alerts** ("Set Alert"): fire as browser notifications + toasts
  when price crosses your level; alert levels drawn on the chart as green
  dashed lines. Checked for every symbol in your lists, not just the open one.
- **Multiple watchlists** ("Add to List" + list switcher in the left panel).
- **RS Rating (approximate)**: IBD-weighted 12-month performance
  (40% recent quarter), percentile-ranked against live S&P 500 constituents.
- **Day replay navigation**: ‹ › arrows step sessions; calendar picks a date.
- **PiP window** (chart-only popup), **screenshot download**, **reset view**.
- **Dynamic type scale** — fonts grow with the window for legibility.

- **IBD-style HLC bars** — blue up / magenta down vs. prior close, log or
  linear price scale.
- **Timeframes** — Daily, Weekly, Monthly, and intraday 1/5/10/15/30/60-minute.
- **Day replay** — pick a date next to the intraday selector to replay any
  session from the last ~30 days (`#TSLA/i5/2026-06-04` deep links work too).
- **Moving averages** — 21/50/200-day on daily, 10/40-week on weekly.
- **RS line** vs. the S&P 500 on its own log scale, with **blue dots** where
  the RS line makes a 52-week new high and the current RS value printed at
  the line's end (ratio × 1000).
- **S&P 500 overlay** line across the top of the price pane (daily+).
- **Swing labels** — local high/low prices annotated at pivot points with
  density control so the chart never gets busy.
- **Earnings flags** anchored at the bottom of the price pane (arrow up,
  colored by EPS YoY, % printed above).
- **Quarterly footer grid** under the date axis — "Qtr Ended …" columns with
  EPS vs. year-ago and % change, Sales vs. year-ago and % change (rich format
  on daily, compact on weekly, like MarketSurge).
- **Floating stats panel** over the chart (collapsible, like MarketSurge):
  annual table **2019 → next-year estimates** with EPS $, EPS % chg,
  Sales $M, Sales % chg, estimate rows marked "e" with 30-day revision
  arrows; plus RS vs SPX (3/6/12 mo), U/D volume, ADR, growth rates,
  P/E, float, sector/industry.
- **Header strip** — EPS due date, market cap, 50-day avg volume and
  $ volume, % off 52-week high, 21-day ATR%.
- **Live refresh** — quotes poll every 4 s and update the last bar in place;
  intraday charts re-fetch every minute during market hours (paused in replay).
- **Watchlist** (left, saved in browser) with live prices; ↑/↓ to flip
  through symbols. **Symbol search** with autocomplete.
- **Volume pane** with 50-day (10-week) average-volume line.

## Keyboard

| Key | Action |
| --- | --- |
| `↑` / `↓` | previous / next watchlist symbol |
| `D` `W` `M` | Daily / Weekly / Monthly |
| `I` | last-used intraday timeframe |
| `L` | toggle log scale |
| any letter | jump to symbol search |
| scroll / drag / double-click | zoom / pan / reset chart |

## Architecture

```
server/            FastAPI backend
  main.py          routes (/api/chart, /api/quote, /api/profile,
                   /api/financials, /api/search)
  data.py          Yahoo Finance provider + in-memory TTL cache
  financials.py    SEC EDGAR (quarterly/annual revenue + GAAP EPS, fiscal
                   quarter ends) merged with Yahoo street EPS + estimates
web/               dependency-free frontend (ES modules)
  js/chart.js      canvas chart engine (bars, MAs, RS, S&P overlay, pivots,
                   earnings flags, quarterly footer, crosshair)
  js/app.js        state, watchlist, search, live polling, floating panel
```

The price-data layer is isolated in `server/data.py` — to switch to a paid
feed (Polygon, Alpaca, etc.) only that file needs to change.

## Notes

- Yahoo quotes are real-time-ish for US equities but not an official
  exchange feed; volume can lag a minute or two. Yahoo keeps ~30 days of
  1-minute and ~60 days of 5-minute history, which bounds day replay.
- Sales figures are as-reported GAAP from SEC filings; EPS is street
  (analyst-adjusted) from earnings reports where available, GAAP otherwise —
  the same blend IBD displays.
- Proprietary IBD percentile ratings (Composite/EPS/RS Rating 1–99) rank
  against IBD's full database and can't be reproduced exactly; the panel
  shows the computable equivalents instead.
