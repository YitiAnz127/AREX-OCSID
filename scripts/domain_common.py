"""Shared, dependency-free helpers for the domain collection scripts."""

from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any


FRONTMATTER = re.compile(r"^---\r?\n(.*?)\r?\n---\r?\n?(.*)$", re.DOTALL)
TOP_LEVEL_FIELD = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$")
BLOCK_STYLES = {">", ">+", ">-", "|", "|+", "|-"}
COMPANION_RESOURCE_DIRS = ("agents", "assets", "models", "references", "scripts")


class FrontmatterError(ValueError):
    """Raised when a SKILL.md frontmatter block is present but malformed."""


def copy_companion_resources(source_dir: str | Path, target_dir: str | Path) -> list[str]:
    """Copy supported resource directories next to a normalized SKILL.md."""
    source = Path(source_dir)
    target = Path(target_dir)
    copied: list[str] = []
    for name in COMPANION_RESOURCE_DIRS:
        resource = source / name
        if not resource.is_dir():
            continue
        shutil.copytree(resource, target / name, dirs_exist_ok=True)
        copied.append(name)
    return copied


def read_utf8(path: str | Path, label: str = "file") -> str:
    """Read a UTF-8 text file and report a concise path-aware error."""
    target = Path(path)
    try:
        return target.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise SystemExit(f"failed to read {label} at {target}: {exc}") from exc


def read_bytes(path: str | Path, label: str = "file") -> bytes:
    """Read raw bytes with the same concise path-aware error contract."""
    target = Path(path)
    try:
        return target.read_bytes()
    except OSError as exc:
        raise SystemExit(f"failed to read {label} at {target}: {exc}") from exc


def load_json_file(path: str | Path, label: str = "JSON file") -> Any:
    """Load UTF-8 JSON with deterministic user-facing failure messages."""
    target = Path(path)
    try:
        return json.loads(read_utf8(target, label))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"invalid JSON in {label} at {target}: {exc}") from exc


def _decode_quoted(value: str, path: Path, key: str) -> str:
    quote = value[0]
    if len(value) < 2 or value[-1] != quote:
        raise FrontmatterError(f"unterminated quoted frontmatter field {key!r} in {path}")
    if quote == "'":
        return value[1:-1].replace("''", "'")
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise FrontmatterError(f"invalid quoted frontmatter field {key!r} in {path}: {exc}") from exc
    if not isinstance(decoded, str):
        raise FrontmatterError(f"frontmatter field {key!r} in {path} must be a string")
    return decoded


def parse_frontmatter(path: str | Path) -> tuple[dict[str, str], str]:
    """Parse the top-level scalar subset used by repository SKILL.md files."""
    target = Path(path)
    text = read_utf8(target, "skill")
    if not text.startswith("---"):
        return {}, text
    match = FRONTMATTER.match(text)
    if not match:
        raise FrontmatterError(f"frontmatter in {target} is missing a closing delimiter")

    fields: dict[str, str] = {}
    lines = match.group(1).splitlines()
    index = 0
    while index < len(lines):
        line = lines[index]
        field = TOP_LEVEL_FIELD.match(line)
        if not field:
            index += 1
            continue
        key, value = field.group(1), field.group(2).strip()
        if key in fields:
            raise FrontmatterError(f"duplicate frontmatter field {key!r} in {target}")
        index += 1

        if value in BLOCK_STYLES:
            literal = value.startswith("|")
            parts: list[str] = []
            while index < len(lines) and (not lines[index].strip() or lines[index][0].isspace()):
                parts.append(lines[index].strip())
                index += 1
            value = "\n".join(parts).strip() if literal else " ".join(part for part in parts if part)
        elif value[:1] in {'"', "'"} and not value.endswith(value[0]):
            quote = value[0]
            parts = [value]
            while index < len(lines) and (not lines[index].strip() or lines[index][0].isspace()):
                parts.append(lines[index].strip())
                index += 1
                if parts[-1].endswith(quote):
                    break
            value = " ".join(part for part in parts if part)

        if value[:1] in {'"', "'"}:
            value = _decode_quoted(value, target, key)
        fields[key] = value

    return fields, match.group(2)
