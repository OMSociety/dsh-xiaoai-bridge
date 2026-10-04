import os
import sys

BANNER = """
▄▖      ▖▖▘    ▄▖▄▖
▌▌▛▌█▌▛▌▚▘▌▀▌▛▌▌▌▐ 
▙▌▙▌▙▖▌▌▌▌▌█▌▙▌▛▌▟▖
  ▌                
                                                                                                                 
"""

print("stdout.encoding =", sys.stdout.encoding, flush=True)
print("PYTHONIOENCODING =", os.environ.get("PYTHONIOENCODING"), flush=True)
print("PYTHONUTF8 =", os.environ.get("PYTHONUTF8"), flush=True)

try:
    print(BANNER)
    print("BANNER PRINT OK", flush=True)
except Exception as exc:  # noqa: BLE001
    print(f"BANNER PRINT FAILED: {type(exc).__name__}: {exc}", flush=True)
