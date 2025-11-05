#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import os
import re
import shutil
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, List, Optional, Pattern, Sequence, Tuple


DEFAULT_TIMESTAMP_PATTERNS: Sequence[str] = (
    # Numeric timestamp format: e.g., 2218,3257761 (two integer groups separated by a comma)
    # Word-boundary-like guards to avoid partial matches inside larger numbers
    r"(?<!\d)\d+,\d+(?!\d)",
)


@dataclass
class HeuristicConfig:
    timestamp_regexes: List[Pattern[str]]
    max_splits_per_line: int = 8  # safety guard to avoid explosion


def compile_timestamp_regexes(patterns: Sequence[str]) -> List[Pattern[str]]:
    return [re.compile(p) for p in patterns]


def find_timestamp_spans(text: str, regexes: Sequence[Pattern[str]]) -> List[Tuple[int, int]]:
    spans: List[Tuple[int, int]] = []
    for rx in regexes:
        for m in rx.finditer(text):
            spans.append((m.start(), m.end()))
    spans.sort(key=lambda s: s[0])
    # Merge overlapping/adjacent spans coming from different regexes
    merged: List[Tuple[int, int]] = []
    for s in spans:
        if not merged or s[0] > merged[-1][1]:
            merged.append(list(s))  # type: ignore[list-item]
        else:
            prev_start, prev_end = merged[-1]
            merged[-1] = (prev_start, max(prev_end, s[1]))
    return [(int(a), int(b)) for a, b in merged]


def _is_inside_quotes(line: str, idx: int) -> bool:
    """Return True if the character position idx is inside a CSV quoted field.

    CSV quoting uses double quotes (") and doubles them ("") to escape.
    We scan from start to idx (exclusive) and toggle quote-state, skipping escaped quotes.
    """
    in_quotes = False
    i = 0
    # We only need quote state up to the index where a match begins
    while i < idx and i < len(line):
        ch = line[i]
        if ch == '"':
            # Escaped quote inside a quoted field: ""
            if in_quotes and i + 1 < idx and line[i + 1] == '"':
                i += 2
                continue
            in_quotes = not in_quotes
        i += 1
    return in_quotes


def find_row_start_indices(line: str, cfg: HeuristicConfig) -> List[int]:
    """Find indices where a new CSV row likely starts within a (possibly merged) line.

    Heuristic:
    - A row start looks like digits,digits (first two numeric columns)
    - It must be OUTSIDE quoted fields
    - It must be either at the start of the line, or NOT immediately preceded by a comma
      (to avoid matching numeric pairs that are simply subsequent columns like 0,0)
    - It should be immediately followed by a comma (end of second numeric column)
    """
    indices: List[int] = []
    for rx in cfg.timestamp_regexes:
        for m in rx.finditer(line):
            s, e = m.start(), m.end()
            if _is_inside_quotes(line, s):
                continue
            prev = s - 1
            # Must be start-of-line or not immediately after a comma
            if prev >= 0 and line[prev] == ',':
                continue
            # Should be followed by a comma (after the second number ends)
            if e < len(line) and line[e] != ',':
                continue
            indices.append(s)

    # Sort and unique
    indices = sorted(set(indices))
    return indices


def needs_split(line: str, cfg: HeuristicConfig) -> bool:
    starts = find_row_start_indices(line, cfg)
    if len(starts) >= 2:
        return True
    if len(starts) == 1:
        # Split when a header-like prefix precedes the first timestamp
        prefix = line[: starts[0]]
        if prefix.strip(" ,;|\t\r\n") != "":
            return True
    return False


def split_line_on_timestamps(line: str, cfg: HeuristicConfig) -> List[str]:
    """
    Split a line into multiple lines when multiple timestamp tokens are present.

    Strategy:
    - Detect all timestamp spans (merged across patterns).
    - If multiple spans exist, start a new CSV row at each timestamp except the first.
    - Keep delimiters and content from each start to right before the next timestamp.
    - Trim leading whitespace/separators between chunks.
    """
    starts = find_row_start_indices(line, cfg)
    if len(starts) == 0:
        return [line]

    # Build chunks: [0:first_start) is kept with first chunk if it's not just separators
    chunks: List[str] = []
    # Pre-chunk content
    prefix = line[: starts[0]]
    # If prefix has non-separator characters, keep it attached to the first chunk.
    # Otherwise, drop it.
    def is_only_separators(s: str) -> bool:
        return s.strip(" ,;|\t\r\n") == ""

    effective_start = 0 if not is_only_separators(prefix) else starts[0]

    indices: List[int] = [effective_start] + starts
    # Ensure uniqueness and ascending
    indices = sorted(set(indices))

    for i, idx in enumerate(indices):
        next_idx = indices[i + 1] if i + 1 < len(indices) else len(line)
        segment = line[idx:next_idx]
        # Clean up leading separators carried over when we started mid-line
        segment = segment.lstrip(" \t,;|\r")
        # Also strip trailing newline characters; we'll re-add newline at write time
        segment = segment.rstrip("\r\n")
        if segment:
            chunks.append(segment)

        if len(chunks) >= cfg.max_splits_per_line:
            break

    return chunks if chunks else [line]


def iter_csv_files(root: Path) -> Iterator[Path]:
    for base, _dirs, files in os.walk(root):
        for name in files:
            if name.lower().endswith(".csv"):
                yield Path(base) / name


def atomic_write_text(target: Path, content: str, make_backup: bool = False) -> None:
    tmp_dir = target.parent
    with tempfile.NamedTemporaryFile("w", delete=False, dir=tmp_dir) as tf:
        tmp_path = Path(tf.name)
        tf.write(content)
    try:
        if make_backup and target.exists():
            backup_path = target.with_suffix(target.suffix + ".bak")
            shutil.copy2(target, backup_path)
        os.replace(tmp_path, target)
    except Exception:
        # Try to remove temp file if replace failed
        try:
            tmp_path.unlink(missing_ok=True)  # type: ignore[call-arg]
        except Exception:
            pass
        raise


def process_file(path: Path, cfg: HeuristicConfig, dry_run: bool = False, backup: bool = False) -> Tuple[bool, int]:
    changed = False
    changes_count = 0
    with path.open("r", encoding="utf-8", errors="replace", newline="") as f:
        original_lines = f.readlines()

    output_lines: List[str] = []
    for line in original_lines:
        if needs_split(line, cfg):
            parts = split_line_on_timestamps(line, cfg)
            if len(parts) > 1:
                changed = True
                changes_count += len(parts) - 1
            for p in parts:
                output_lines.append(p + "\n")
        else:
            output_lines.append(line)

    if changed and not dry_run:
        atomic_write_text(path, "".join(output_lines), make_backup=backup)

    return changed, changes_count


def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Insert missing CSV newlines based on timestamp heuristics.")
    p.add_argument("root", type=str, help="Root directory to scan recursively for .csv files")
    p.add_argument("--pattern", "-p", action="append", default=list(DEFAULT_TIMESTAMP_PATTERNS),
                   help="Regex for timestamps (can be repeated). Default: numeric 'digits,digits'.")
    p.add_argument("--dry-run", action="store_true", help="Do not modify files, just report changes")
    p.add_argument("--backup", action="store_true", help="Write .bak alongside modified files")
    p.add_argument("--max-splits", type=int, default=8, help="Safety: maximum chunks per merged line")
    p.add_argument("--include", action="append", default=None,
                   help="Only process CSVs whose path contains this substring (can repeat)")
    p.add_argument("--exclude", action="append", default=None,
                   help="Skip CSVs whose path contains this substring (can repeat)")
    return p.parse_args(argv)


def should_process(path: Path, includes: Optional[Sequence[str]], excludes: Optional[Sequence[str]]) -> bool:
    s = str(path)
    if includes:
        if not any(k in s for k in includes):
            return False
    if excludes:
        if any(k in s for k in excludes):
            return False
    return True


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    root = Path(args.root)
    if not root.exists() or not root.is_dir():
        print(f"Root directory not found: {root}", file=sys.stderr)
        return 2

    timestamp_regexes = compile_timestamp_regexes(args.pattern)
    cfg = HeuristicConfig(timestamp_regexes=timestamp_regexes, max_splits_per_line=int(args.max_splits))

    total_files = 0
    modified_files = 0
    total_inserts = 0

    for csv_path in iter_csv_files(root):
        if not should_process(csv_path, args.include, args.exclude):
            continue
        total_files += 1
        changed, count = process_file(csv_path, cfg, dry_run=bool(args.dry_run), backup=bool(args.backup))
        if changed:
            modified_files += 1
            total_inserts += count
            action = "WOULD FIX" if args.dry_run else "FIXED"
            print(f"{action}: {csv_path} (+{count} newline(s))")

    print(f"Scanned {total_files} CSV file(s). Modified {modified_files}. Inserted {total_inserts} newline(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


