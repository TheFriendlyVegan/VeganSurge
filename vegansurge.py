"""VeganSurge launcher — used both for `python vegansurge.py` and as the
PyInstaller entry point for the standalone .exe. Starts the server and
opens the browser. Close this window to stop VeganSurge.
"""

import os
import threading
import webbrowser

import uvicorn

from server.main import app


def main():
    port = int(os.environ.get("VEGANSURGE_PORT", "8520"))
    print(f"VeganSurge running at http://localhost:{port}  (close this window to quit)")
    threading.Timer(1.5, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
