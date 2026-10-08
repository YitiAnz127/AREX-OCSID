"""Make every workflow skill's ``scripts/`` directory importable in its tests.

The skill tests import their entry points by module name (``from
write_final_report import main``) exactly the way the skill's own documentation
tells an agent to run them (``python scripts/write_final_report.py``).  Without
help, pytest only puts the *test* directory on ``sys.path``, so a bare
``pytest packages/coding-agent/src/ocsid/skills`` fails at collection time with
``ModuleNotFoundError``.  This conftest is the single place that fixes the import
path, so the suite can be gated by ``npm run test:workflow-skills`` from the
package root instead of requiring a manual ``cd`` into each ``scripts/`` folder.
"""

from __future__ import annotations

import sys
from pathlib import Path

SKILLS_ROOT = Path(__file__).resolve().parent


def _script_dirs() -> list[Path]:
    return sorted(path for path in SKILLS_ROOT.glob("*/scripts") if path.is_dir())


def pytest_collection_modifyitems(config, items):  # noqa: ANN001, ARG001
    """No-op hook kept for readability; the path fix happens at import time."""


for _scripts in _script_dirs():
    _entry = str(_scripts)
    if _entry not in sys.path:
        sys.path.insert(0, _entry)
