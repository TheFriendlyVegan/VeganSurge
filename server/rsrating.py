"""Approximate IBD RS Rating.

IBD's RS Rating is the percentile (1-99) of a stock's weighted 12-month
price performance across their ~7000-stock database. The weighting is
commonly documented as 40% for the most recent quarter and 20% for each of
the three prior quarters:

    score = 0.4*p(63) + 0.2*p(126) + 0.2*p(189) + 0.2*p(252)

where p(N) is the % change over the trailing N trading days.

We can't access IBD's universe, so we rank against the S&P 500
constituents (fetched from Wikipedia, prices bulk-downloaded from Yahoo).
This skews slightly vs IBD's small-cap-inclusive universe, but tracks well
for liquid names. The universe build takes ~1 minute and is refreshed every
12 h in a background thread; until it's ready the endpoint reports
{"status": "warming"}.
"""

import threading
import time
from io import StringIO

import requests

_lock = threading.Lock()
_state = {
    "scores": None,    # sorted list of universe weighted-performance scores
    "built": 0,        # timestamp of last successful build
    "building": False,
    "error": None,
}
REFRESH_SECS = 12 * 3600

WEIGHTS = ((63, 0.4), (126, 0.2), (189, 0.2), (252, 0.2))


def weighted_perf(closes):
    """closes: oldest->newest sequence (may contain None/NaN)."""
    vals = [c for c in closes if c == c and c is not None]
    n = len(vals)
    if n < 70:
        return None
    last = vals[-1]
    score = 0.0
    for lb, w in WEIGHTS:
        base = vals[max(0, n - 1 - lb)]
        if not base:
            return None
        score += w * (last / base - 1.0)
    return score


def _sp500_symbols():
    r = requests.get(
        "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies",
        headers={"User-Agent": "Mozilla/5.0 VeganSurge research"},
        timeout=30,
    )
    r.raise_for_status()
    import pandas as pd

    syms = pd.read_html(StringIO(r.text))[0]["Symbol"].tolist()
    return [s.replace(".", "-") for s in syms if isinstance(s, str)]


def _build_universe():
    import yfinance as yf

    symbols = _sp500_symbols()
    df = yf.download(
        symbols, period="1y", interval="1d", auto_adjust=True,
        progress=False, group_by="column", threads=True,
    )["Close"]
    scores = []
    for sym in df.columns:
        s = weighted_perf(df[sym].tolist())
        if s is not None:
            scores.append(s)
    scores.sort()
    return scores


def _ensure_universe():
    with _lock:
        fresh = _state["scores"] is not None and time.time() - _state["built"] < REFRESH_SECS
        if fresh or _state["building"]:
            return
        _state["building"] = True

    def work():
        try:
            scores = _build_universe()
            with _lock:
                if scores and len(scores) > 100:
                    _state["scores"] = scores
                    _state["built"] = time.time()
                    _state["error"] = None
                else:
                    _state["error"] = "universe too small"
        except Exception as e:
            with _lock:
                _state["error"] = str(e)
        finally:
            with _lock:
                _state["building"] = False

    threading.Thread(target=work, daemon=True).start()


def warm():
    _ensure_universe()


def get_rs_rating(symbol, closes):
    """closes: the stock's trailing ~1y of daily closes (oldest->newest)."""
    _ensure_universe()
    score = weighted_perf(closes)
    with _lock:
        scores = _state["scores"]
        err = _state["error"]
    if score is None:
        return {"status": "na"}
    if scores is None:
        return {"status": "error" if err else "warming", "error": err}
    # percentile -> 1..99
    import bisect

    pct = bisect.bisect_left(scores, score) / len(scores)
    rating = max(1, min(99, round(pct * 98) + 1))
    return {
        "status": "ok",
        "rating": rating,
        "score": round(score * 100, 2),
        "universe": "S&P 500",
        "n": len(scores),
    }
