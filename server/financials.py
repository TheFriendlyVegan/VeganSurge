"""Annual + quarterly EPS / sales history with YoY % changes.

Sources:
- SEC EDGAR companyfacts (free, official): quarterly + annual revenue and
  GAAP diluted EPS, with exact fiscal quarter-end dates, back a decade+.
- Yahoo (yfinance): street (adjusted) quarterly EPS from earnings reports,
  and forward-year analyst estimates for EPS and revenue.

Street EPS is preferred where available (matches what IBD displays);
GAAP fills gaps. Returns plain dicts; caching is handled by data._cached.
"""

import calendar
import math
import os
from datetime import date, datetime, timedelta, timezone

import requests
import yfinance as yf

# SEC asks automated clients to identify themselves with a contact address.
# Each user should set their own: VEGANSURGE_CONTACT=you@example.com
UA = {
    "User-Agent": "VeganSurge/1.0 personal research ("
    + os.environ.get("VEGANSURGE_CONTACT", "contact-not-set@example.com")
    + ")"
}

REV_TAGS = [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "RevenuesNetOfInterestExpense",
]
EPS_TAGS = [
    "EarningsPerShareDiluted",
    "EarningsPerShareBasicAndDiluted",
    "EarningsPerShareBasic",
]

_cik_map = None


def _cik_for(symbol):
    global _cik_map
    if _cik_map is None:
        r = requests.get(
            "https://www.sec.gov/files/company_tickers.json", headers=UA, timeout=30
        )
        r.raise_for_status()
        _cik_map = {v["ticker"].upper(): int(v["cik_str"]) for v in r.json().values()}
    return _cik_map.get(symbol.upper())


def _facts(cik):
    r = requests.get(
        f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json",
        headers=UA,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def _collect(facts, tags, unit_filter):
    """Merge fact items across tags (priority order), dedup by (start, end)."""
    gaap = facts.get("facts", {}).get("us-gaap", {})
    out = {}
    for tag in reversed(tags):  # later overwrites: highest-priority tag wins
        node = gaap.get(tag)
        if not node:
            continue
        for unit, items in node.get("units", {}).items():
            if unit_filter not in unit:
                continue
            for it in items:
                if it.get("val") is None or not it.get("start") or not it.get("end"):
                    continue
                try:
                    s = date.fromisoformat(it["start"])
                    e = date.fromisoformat(it["end"])
                except ValueError:
                    continue
                out[(s, e)] = float(it["val"])
    return [{"start": s, "end": e, "val": v} for (s, e), v in sorted(out.items(), key=lambda kv: kv[0][1])]


def _split_durations(items):
    quarters, annuals = {}, {}
    for it in items:
        dur = (it["end"] - it["start"]).days
        if 75 <= dur <= 100:
            quarters[it["end"]] = it["val"]
        elif 340 <= dur <= 380:
            annuals[it["end"]] = {"start": it["start"], "val": it["val"]}
    return quarters, annuals


def _derive_q4(quarters, annuals):
    """Fiscal Q4 is usually reported only inside the 10-K annual figure."""
    for end, a in annuals.items():
        if end in quarters:
            continue
        inside = [v for e, v in quarters.items() if a["start"] < e < end]
        if len(inside) == 3:
            quarters[end] = a["val"] - sum(inside)


def _year_ago(d, mapping, window=25):
    target = d - timedelta(days=365)
    for delta in range(window):
        for sign in (1, -1):
            cand = target + timedelta(days=delta * sign)
            if cand in mapping:
                return mapping[cand]
    return None


def _pct(cur, prior):
    if cur is None or prior in (None, 0):
        return None
    return round((cur - prior) / abs(prior) * 100, 1)


def _clean(v):
    if v is None or (isinstance(v, float) and (math.isnan(v) or math.isinf(v))):
        return None
    return v


def _street_eps(symbol):
    """Past report dates with street EPS, sorted ascending. [(datetime, eps, surprise)]"""
    try:
        df = yf.Ticker(symbol).get_earnings_dates(limit=40)
    except Exception:
        return []
    if df is None or df.empty:
        return []
    out = []
    now = datetime.now(timezone.utc)
    for ts, row in df.sort_index().iterrows():
        eps = row.get("Reported EPS")
        if eps is None or eps != eps:
            continue
        if ts.to_pydatetime() > now:
            continue
        sur = row.get("Surprise(%)")
        out.append((ts.to_pydatetime(), float(eps), _clean(float(sur)) if sur == sur else None))
    return out


def get_financials(symbol):
    symbol = symbol.upper().strip()
    rev_q, rev_a, eps_q_gaap, eps_a_gaap = {}, {}, {}, {}
    try:
        cik = _cik_for(symbol)
        if cik:
            facts = _facts(cik)
            rq, ra = _split_durations(_collect(facts, REV_TAGS, "USD"))
            eq, ea = _split_durations(_collect(facts, EPS_TAGS, "USD/shares"))
            _derive_q4(rq, ra)
            _derive_q4(eq, ea)
            rev_q, rev_a = rq, {e: a["val"] for e, a in ra.items()}
            eps_q_gaap = eq
            eps_a_gaap = {e: a["val"] for e, a in ea.items()}
            fy_spans = {e: a["start"] for e, a in ra.items()}
        else:
            fy_spans = {}
    except Exception:
        fy_spans = {}

    street = _street_eps(symbol)

    # Map street EPS reports to fiscal quarter-ends from SEC (report follows
    # quarter end by ~2-8 weeks). Without SEC data, approximate end = report-45d.
    q_ends = sorted(rev_q.keys() | eps_q_gaap.keys())
    eps_q_street = {}
    report_for_q = {}
    for rd, eps, surprise in street:
        rdate = rd.date()
        cand = [e for e in q_ends if e < rdate <= e + timedelta(days=130)]
        qend = max(cand) if cand else (rdate - timedelta(days=45)).replace(day=28)
        eps_q_street[qend] = eps
        report_for_q[qend] = int(rd.timestamp())

    # ---------- quarterly table ----------
    all_q = sorted(set(q_ends) | set(eps_q_street.keys()))
    quarterly = []
    for e in all_q:
        eps = eps_q_street.get(e, eps_q_gaap.get(e))
        eps_prior = _year_ago(e, eps_q_street) or _year_ago(e, eps_q_gaap)
        sales = rev_q.get(e)
        sales_prior = _year_ago(e, rev_q)
        quarterly.append(
            {
                "end": e.isoformat(),
                "t": int(datetime(e.year, e.month, e.day, tzinfo=timezone.utc).timestamp()),
                "label": e.strftime("%b %y"),
                "full": "Qtr Ended " + e.strftime("%B %Y"),
                "eps": _clean(round(eps, 2)) if eps is not None else None,
                "epsPrior": _clean(round(eps_prior, 2)) if eps_prior is not None else None,
                "epsPct": _pct(eps, eps_prior),
                "sales": _clean(round(sales / 1e6, 1)) if sales is not None else None,
                "salesPrior": _clean(round(sales_prior / 1e6, 1)) if sales_prior is not None else None,
                "salesPct": _pct(sales, sales_prior),
                "report": report_for_q.get(e),
            }
        )
    quarterly = quarterly[-40:]

    # ---------- forward quarterly estimates (next two quarters) ----------
    if quarterly:
        try:
            t = yf.Ticker(symbol)
            ee = t.earnings_estimate
            re_ = t.revenue_estimate
            last_end = date.fromisoformat(quarterly[-1]["end"])
            for i, key in enumerate(["0q", "+1q"]):
                eps_est = sales_est = None
                if ee is not None and key in ee.index:
                    eps_est = _clean(float(ee.loc[key, "avg"]))
                if re_ is not None and key in re_.index:
                    sales_est = _clean(float(re_.loc[key, "avg"]))
                if eps_est is None and sales_est is None:
                    continue
                # estimate quarter ends ~3 months after the prior quarter
                m = last_end.month + 3 * (i + 1)
                y = last_end.year + (m - 1) // 12
                m = (m - 1) % 12 + 1
                e = date(y, m, min(last_end.day, calendar.monthrange(y, m)[1]))
                eps_prior = _year_ago(e, eps_q_street) or _year_ago(e, eps_q_gaap)
                sales_prior = _year_ago(e, rev_q)
                sp = _clean(round(sales_prior / 1e6, 1)) if sales_prior is not None else None
                se = _clean(round(sales_est / 1e6, 1)) if sales_est is not None else None
                quarterly.append(
                    {
                        "end": e.isoformat(),
                        "t": int(datetime(e.year, e.month, e.day, tzinfo=timezone.utc).timestamp()),
                        "label": e.strftime("%b %y") + "e",
                        "full": "Qtr Ends " + e.strftime("%B %Y"),
                        "eps": _clean(round(eps_est, 2)) if eps_est is not None else None,
                        "epsPrior": _clean(round(eps_prior, 2)) if eps_prior is not None else None,
                        "epsPct": _pct(eps_est, eps_prior),
                        "sales": se,
                        "salesPrior": sp,
                        "salesPct": _pct(sales_est, sales_prior),
                        "report": None,
                        "est": True,
                    }
                )
        except Exception:
            pass

    # ---------- annual table ----------
    annual = []
    fy_ends = sorted(set(rev_a.keys()) | set(eps_a_gaap.keys()))
    fy_month = fy_ends[-1].strftime("%b") if fy_ends else "Dec"
    for e in fy_ends:
        if e.year < 2015:
            continue
        # street annual EPS: sum the 4 street quarters inside this fiscal year
        span_start = fy_spans.get(e, e - timedelta(days=365))
        sq = [v for qe, v in eps_q_street.items() if span_start < qe <= e]
        eps = round(sum(sq), 2) if len(sq) == 4 else eps_a_gaap.get(e)
        sales = rev_a.get(e)
        annual.append({"year": e.year, "end": e, "eps": eps, "sales": sales})
    for i, a in enumerate(annual):
        prior = next((p for p in annual if p["year"] == a["year"] - 1), None)
        a["epsPct"] = _pct(a["eps"], prior["eps"]) if prior else None
        a["salesPct"] = _pct(a["sales"], prior["sales"]) if prior else None

    # ---------- analyst estimates for current + next fiscal year ----------
    est_rows = []
    try:
        t = yf.Ticker(symbol)
        ee = t.earnings_estimate
        re_ = t.revenue_estimate
        trend = None
        try:
            trend = t.eps_trend
        except Exception:
            pass
        last_actual_year = annual[-1]["year"] if annual else date.today().year - 1
        for i, key in enumerate(["0y", "+1y"]):
            eps_est = sales_est = arrow = None
            if ee is not None and key in ee.index:
                eps_est = _clean(float(ee.loc[key, "avg"]))
            if re_ is not None and key in re_.index:
                sales_est = _clean(float(re_.loc[key, "avg"]))
            if trend is not None and key in trend.index:
                cur, m30 = trend.loc[key, "current"], trend.loc[key, "30daysAgo"]
                if cur == cur and m30 == m30:
                    arrow = "up" if cur > m30 else "down" if cur < m30 else None
            if eps_est is None and sales_est is None:
                continue
            est_rows.append(
                {
                    "year": last_actual_year + 1 + i,
                    "eps": round(eps_est, 2) if eps_est is not None else None,
                    "sales": sales_est,
                    "est": True,
                    "trend": arrow,
                }
            )
    except Exception:
        pass

    rows = [
        {
            "year": a["year"],
            "eps": a["eps"],
            "epsPct": a["epsPct"],
            "sales": _clean(round(a["sales"] / 1e6, 1)) if a["sales"] is not None else None,
            "salesPct": a["salesPct"],
            "est": False,
            "trend": None,
        }
        for a in annual
        if a["year"] >= 2019
    ]
    for er in est_rows:
        prior = rows[-1] if rows else None
        er["epsPct"] = _pct(er["eps"], prior["eps"]) if prior else None
        er["sales"] = _clean(round(er["sales"] / 1e6, 1)) if er["sales"] is not None else None
        er["salesPct"] = _pct(er["sales"], prior["sales"]) if prior else None
        rows.append(er)

    # growth rates for the stats block (3-year averages of actual YoY)
    actual_eps_pcts = [r["epsPct"] for r in rows if not r["est"] and r["epsPct"] is not None][-3:]
    actual_sales_pcts = [r["salesPct"] for r in rows if not r["est"] and r["salesPct"] is not None][-3:]
    last_surprise = street[-1][2] if street else None

    return {
        "symbol": symbol,
        "fyMonth": fy_month,
        "annual": rows,
        "quarterly": quarterly,
        "epsGrowth3y": round(sum(actual_eps_pcts) / len(actual_eps_pcts), 1) if actual_eps_pcts else None,
        "salesGrowth3y": round(sum(actual_sales_pcts) / len(actual_sales_pcts), 1) if actual_sales_pcts else None,
        "lastSurprise": last_surprise,
    }
