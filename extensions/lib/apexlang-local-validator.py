#!/usr/bin/env python3
"""Run Oracle's DSL validator with per-process parser acceleration.

The vendored Oracle skill stays byte-for-byte unchanged. This launcher imports
its validator, replaces only pure parsing helpers with equivalent cached
implementations, and then calls the original command-line entry point.
"""

from __future__ import annotations

from bisect import bisect_right
from functools import lru_cache, wraps
import importlib.util
import os
from pathlib import Path
import sys
from types import ModuleType
from typing import Any, Callable


class _SparseDepthIndex:
    """Store lexical depth checkpoints only at offsets requested by validators."""

    __slots__ = ("positions", "states")

    def __init__(self) -> None:
        self.positions: list[int] = [0]
        self.states: list[tuple[int, int, bool]] = [(0, 0, False)]


_DEPTH_INDEXES: dict[str, _SparseDepthIndex] = {}


def _sparse_nesting_depth(text: str, idx: int) -> tuple[int, int]:
    """Return Oracle-compatible nesting depth using the closest prior checkpoint."""
    target_idx = min(len(text), idx) if idx >= 0 else max(0, len(text) + idx)
    index = _DEPTH_INDEXES.setdefault(text, _SparseDepthIndex())
    checkpoint_slot = bisect_right(index.positions, target_idx) - 1
    start = index.positions[checkpoint_slot]
    paren_depth, brace_depth, in_string = index.states[checkpoint_slot]

    for pos in range(start, target_idx):
        ch = text[pos]
        if ch == '"' and (pos == 0 or text[pos - 1] != "\\"):
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "(":
            paren_depth += 1
        elif ch == ")":
            paren_depth = max(0, paren_depth - 1)
        elif ch == "{":
            brace_depth += 1
        elif ch == "}":
            brace_depth = max(0, brace_depth - 1)

    if start != target_idx:
        insert_at = checkpoint_slot + 1
        index.positions.insert(insert_at, target_idx)
        index.states.insert(insert_at, (paren_depth, brace_depth, in_string))
    return paren_depth, brace_depth


def _validator_path() -> Path:
    runtime_override = os.environ.get("APEXLANG_RUNTIME_ROOT", "").strip()
    runtime_root = (
        Path(runtime_override).resolve()
        if runtime_override
        else Path(__file__).resolve().parents[2] / "skills" / "apexlang" / "runtime"
    )
    return runtime_root / "internal" / "python" / "validate_apexlang.py"


def _load_oracle_validator(path: Path) -> ModuleType:
    sys.path.insert(0, str(path.parent))
    spec = importlib.util.spec_from_file_location("_pi_apexlang_oracle_validator", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load Oracle APEXlang validator: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _cache_list_function(function: Callable[..., list[Any]]) -> Callable[..., list[Any]]:
    """Cache immutable results while preserving Oracle's fresh-list return type."""
    cached = lru_cache(maxsize=None)(lambda *args: tuple(function(*args)))

    @wraps(function)
    def wrapper(*args: Any) -> list[Any]:
        return list(cached(*args))

    return wrapper


def _accelerate(module: ModuleType) -> None:
    module.nesting_depth = _sparse_nesting_depth
    for name in (
        "find_component_blocks",
        "find_named_brace_blocks",
        "find_immediate_component_blocks",
        "find_immediate_named_brace_blocks",
    ):
        setattr(module, name, _cache_list_function(getattr(module, name)))
    module.block_body = lru_cache(maxsize=None)(module.block_body)


def main(argv: list[str]) -> int:
    validator = _load_oracle_validator(_validator_path())
    _accelerate(validator)
    return int(validator.main(argv))


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
