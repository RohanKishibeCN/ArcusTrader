#!/usr/bin/env python3
"""Consolidate the Arcus OpenAPI fragments embedded in the docs snapshot.

Mintlify renders every REST endpoint page with the endpoint's OpenAPI
fragment inlined in a fenced ````yaml block. Those fragments are the
authoritative field names. This tool:

  1. globs docs/arcus/*.md
  2. pulls every ````yaml /api-reference/openapi.yml <method> <path> block
  3. merges the fragments into one OpenAPI document
  4. writes docs/arcus/arcus.openapi.merged.json

Downstream codegen (tools/gen-contracts.mjs) reads the merged document, so
TypeScript types and zod schemas are derived from upstream rather than typed
by hand.

Run:  python3 tools/merge-openapi.py
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("PyYAML is required: pip install pyyaml")

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs" / "arcus"
OUT = DOCS / "arcus.openapi.merged.json"

FENCE = re.compile(r"^````yaml(.*?)^````$", re.S | re.M)
HEADER = re.compile(
    r"^/api-reference/openapi\.yml\s+(get|post|put|delete|patch)\s+(\S+)", re.I
)


def parse_blocks() -> tuple[dict, list[str]]:
    """Return ({merged openapi doc}, warnings)."""
    paths: dict[str, dict] = {}
    components: dict[str, dict] = {}
    warnings: list[str] = []
    root_info: dict = {}

    for md in sorted(DOCS.glob("*.md")):
        text = md.read_text(encoding="utf8")
        for body in FENCE.findall(text):
            lines = body.split("\n")
            # Line 0 is the fence label, e.g.
            # " /api-reference/openapi.yml get /v1/positions". It is not YAML,
            # so it must be dropped before parsing.
            header = lines[0].strip()
            m = HEADER.match(header)
            if not m:
                continue
            method, path = m.group(1).lower(), m.group(2)
            body_yaml = "\n".join(lines[1:])
            try:
                doc = yaml.safe_load(body_yaml)
            except yaml.YAMLError as err:  # pragma: no cover
                warnings.append(f"{md.name}: yaml parse failed for {method} {path}: {err}")
                continue

            # Each fragment also carries a trailing top-level `components:`
            # block holding the schemas its `$ref`s point at. Harvest those,
            # otherwise the merged document has dangling references.
            comp_match = re.search(
                r"^components:\s*$.*?(?=^[A-Za-z_][A-Za-z0-9_]*:\s*$|\Z)",
                body_yaml,
                re.S | re.M,
            )
            if comp_match:
                try:
                    comp = yaml.safe_load(comp_match.group(0))
                except yaml.YAMLError as err:  # pragma: no cover
                    warnings.append(f"{md.name}: components parse failed: {err}")
                    comp = None
                if isinstance(comp, dict):
                    for section, entries in (comp.get("components") or {}).items():
                        if not isinstance(entries, dict):
                            continue
                        bucket = components.setdefault(section, {})
                        for key, value in entries.items():
                            if key in bucket and bucket[key] != value:
                                warnings.append(
                                    f"{md.name}: component {section}.{key} redefined"
                                )
                            bucket[key] = value

            op = doc.get("paths", {}).get(path, {}).get(method)
            if not op:
                warnings.append(f"{md.name}: no operation found at paths.{path}.{method}")
                continue

            if not root_info:
                root_info = doc.get("info", {})

            if path in paths and method in paths[path]:
                warnings.append(f"{md.name}: duplicate {method} {path}, overwriting")
            paths.setdefault(path, {})[method] = op

    # server list lives at the fragment root; capture it from any fragment.
    servers = []
    for md in sorted(DOCS.glob("*.md")):
        for body in FENCE.findall(md.read_text(encoding="utf8")):
            if not HEADER.match(body.split("\n", 1)[0].strip()):
                continue
            try:
                doc = yaml.safe_load(body)
            except yaml.YAMLError:
                continue
            if doc.get("servers"):
                servers = doc["servers"]
                break
        if servers:
            break

    merged = {
        "openapi": "3.1.0",
        "info": root_info
        or {"title": "Arcus API (merged from docs snapshot)", "version": "unknown"},
        "servers": servers
        or [
            {"url": "https://api.arcus.xyz", "description": "mainnet"},
            {"url": "https://api.testnet.arcus.xyz", "description": "testnet"},
        ],
        "paths": paths,
        "components": components,
        "_meta": {
            "source": "docs/arcus/*.md embedded OpenAPI fragments",
            "note": (
                "Merged by tools/merge-openapi.py. Upstream "
                "https://docs.arcus.xyz/api-reference/openapi.yml returns 404, so the "
                "per-endpoint fragments in the docs pages are the source of truth."
            ),
        },
    }
    return merged, warnings


def main() -> int:
    if not DOCS.exists():
        return int(bool(sys.stderr.write("run tools/fetch-arcus-docs.mjs first\n"))) or 1
    merged, warnings = parse_blocks()
    n_ops = sum(len(v) for v in merged["paths"].values())
    OUT.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf8")
    print(f"merged {n_ops} operations across {len(merged['paths'])} paths -> {OUT.relative_to(ROOT)}")
    for w in warnings:
        print(f"  warn: {w}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
