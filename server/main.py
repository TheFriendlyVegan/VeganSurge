"""FastAPI app: JSON API + static frontend.

Run with:  py -m uvicorn server.main:app --port 8520
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import data, rsrating

app = FastAPI(title="VeganSurge")


@app.on_event("startup")
def _warm_rs_universe():
    rsrating.warm()  # background thread; ~1 min to build

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@app.middleware("http")
async def no_stale_assets(request, call_next):
    """Force revalidation of HTML/JS/CSS so the UI can never load a mix of
    old markup and new scripts after an upgrade (304s keep it fast)."""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.endswith((".html", ".js", ".css")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/chart")
def api_chart(symbol: str, tf: str = "d", day: str = None):
    try:
        result = data.get_chart(symbol, tf, day)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        raise HTTPException(502, f"data fetch failed: {e}")
    if "error" in result:
        raise HTTPException(404, result["error"])
    return JSONResponse(result)


@app.get("/api/quote")
def api_quote(symbol: str):
    try:
        return JSONResponse(data.get_quote(symbol))
    except Exception as e:
        raise HTTPException(502, f"quote fetch failed: {e}")


@app.get("/api/profile")
def api_profile(symbol: str):
    try:
        return JSONResponse(data.get_profile(symbol))
    except Exception as e:
        raise HTTPException(502, f"profile fetch failed: {e}")


@app.get("/api/rsrating")
def api_rsrating(symbol: str):
    try:
        return JSONResponse(data.get_rs_rating(symbol))
    except Exception as e:
        raise HTTPException(502, f"rs rating failed: {e}")


@app.get("/api/financials")
def api_financials(symbol: str):
    try:
        return JSONResponse(data.get_financials(symbol))
    except Exception as e:
        raise HTTPException(502, f"financials fetch failed: {e}")


@app.get("/api/search")
def api_search(q: str):
    try:
        return JSONResponse(data.search(q))
    except Exception:
        return JSONResponse([])


app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
