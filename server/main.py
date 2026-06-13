"""FastAPI app: JSON API + static frontend.

Run with:  py -m uvicorn server.main:app --port 8520
"""

import subprocess
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from . import data, rsrating

REPO_DIR = Path(__file__).resolve().parent.parent

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
def api_chart(symbol: str, tf: str = "d", day: str = None, prepost: int = 0):
    try:
        result = data.get_chart(symbol, tf, day, prepost=bool(prepost))
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


def _git(*args, timeout=60):
    """Run a git command inside the repo; raises a clean HTTPException if git
    is missing or hangs."""
    try:
        return subprocess.run(
            ["git", "-C", str(REPO_DIR), *args],
            capture_output=True, text=True, timeout=timeout,
        )
    except FileNotFoundError:
        raise HTTPException(500, "git is not installed — auto-update is unavailable")
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "git timed out")


@app.get("/api/version")
def api_version():
    """Current commit and how many commits origin is ahead (does a fetch)."""
    head = _git("rev-parse", "--short", "HEAD").stdout.strip()
    branch = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
    dirty = bool(_git("status", "--porcelain").stdout.strip())
    if not head:
        raise HTTPException(500, "not a git checkout — auto-update is unavailable")
    _git("fetch", "--quiet", "origin", timeout=30)
    cnt = _git("rev-list", "--count", f"HEAD..origin/{branch}").stdout.strip()
    behind = int(cnt) if cnt.isdigit() else 0
    latest = _git("rev-parse", "--short", f"origin/{branch}").stdout.strip()
    return JSONResponse(
        {"current": head, "branch": branch, "dirty": dirty, "behind": behind, "latest": latest}
    )


@app.post("/api/update")
def api_update():
    """Fast-forward the working copy to the latest commit on origin."""
    if _git("status", "--porcelain").stdout.strip():
        raise HTTPException(409, "You have local changes — commit or stash them before updating.")
    branch = _git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip() or "main"
    before = _git("rev-parse", "HEAD").stdout.strip()
    pull = _git("pull", "--ff-only", "origin", branch, timeout=120)
    if pull.returncode != 0:
        raise HTTPException(502, (pull.stderr or pull.stdout or "git pull failed").strip())
    after = _git("rev-parse", "HEAD").stdout.strip()
    updated = before != after
    files = _git("diff", "--name-only", before, after).stdout.split() if updated else []
    server_changed = any(f.startswith("server/") or f == "requirements.txt" for f in files)
    return JSONResponse(
        {"updated": updated, "current": after[:7], "server_changed": server_changed, "files": files}
    )


app.mount("/", StaticFiles(directory=str(WEB_DIR), html=True), name="web")
