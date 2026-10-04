"""Isolated probe: does open_xiaoai_server.start_server() actually bind 0.0.0.0:4399?"""
import asyncio
import socket
import sys
import threading
import time

import open_xiaoai_server


def probe():
    time.sleep(2.0)
    s = socket.socket()
    s.settimeout(3)
    try:
        s.connect(("127.0.0.1", 4399))
        print("[probe] 4399 CONNECT OK", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[probe] 4399 connect FAIL: {type(exc).__name__}: {exc}", flush=True)
    finally:
        s.close()
    # also check bind state
    try:
        import subprocess
        out = subprocess.run(["netstat", "-ano"], capture_output=True, text=True, timeout=10)
        hits = [ln for ln in out.stdout.splitlines() if ":4399" in ln]
        print(f"[probe] netstat 4399 lines: {hits}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[probe] netstat failed: {exc}", flush=True)


async def main():
    print("[probe] python", sys.version, flush=True)
    print("[probe] calling start_server()", flush=True)
    threading.Thread(target=probe, daemon=True).start()
    await open_xiaoai_server.start_server()
    print("[probe] start_server() returned (unexpected)", flush=True)


asyncio.run(main())
