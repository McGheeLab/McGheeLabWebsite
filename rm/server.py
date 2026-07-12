#!/usr/bin/env python3
"""Local-dev launcher for RM, inside McGheeLabWebsite.

The real RM dev server lives at ../../ResearchManagement/server.py and is
~5000 lines (Outlook ICS, Crossref/PubMed/arXiv, receipt parsing, gmail,
paper-PDF proxy, etc.). Rather than duplicate that here, this launcher just
execs the sibling-repo server with this repo's /rm/ tree mounted in.

The sibling server's translate_path() routes /rm/* to McGheeLabWebsite/rm/*,
so editing in place at McGheeLabWebsite/rm/ Just Works under
http://localhost:8000/rm/. /api/data/* still reads/writes
ResearchManagement/data/ (the legacy seed JSON stays in that repo).

Usage:
    RM_WRITE_ALLOWLIST=mcgheealex@gmail.com python3 rm/server.py
    # then open http://localhost:8000/rm/
"""

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent                       # .../McGheeLabWebsite/rm
SIBLING_SERVER = HERE.parent.parent / "ResearchManagement" / "server.py"

if not SIBLING_SERVER.exists():
    sys.stderr.write(
        f"error: ResearchManagement/server.py not found at {SIBLING_SERVER}\n"
        "RM's local dev server lives in the sibling repo. Clone it next to\n"
        "McGheeLabWebsite or adjust the path in this launcher.\n"
    )
    sys.exit(1)

# Hand off entirely. The sibling server is the one with all the API handlers
# and already mounts /rm/ -> McGheeLabWebsite/rm/ via its translate_path.
os.execvp(sys.executable, [sys.executable, str(SIBLING_SERVER), *sys.argv[1:]])
