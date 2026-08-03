#!/usr/bin/env python3
"""Materialize the current Factory Floor archaeology from a frozen base export and ordered patches."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / ".deciduous" / "exports" / "factory-floor-archaeology.json"
PATCH_ROOT = ROOT / "tools" / "deciduous" / "backfill" / "patches"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_base_edge(edge: dict, nodes_by_numeric_id: dict[int, str]) -> dict:
    source = edge.get("from_change_id") or edge.get("source_change_id")
    target = edge.get("to_change_id") or edge.get("target_change_id")
    if source is None:
        source_id = edge.get("from_node_id", edge.get("source_id"))
        source = nodes_by_numeric_id.get(int(source_id)) if source_id is not None else None
    if target is None:
        target_id = edge.get("to_node_id", edge.get("target_id"))
        target = nodes_by_numeric_id.get(int(target_id)) if target_id is not None else None
    edge_type = edge.get("edge_type", edge.get("relation", edge.get("type")))
    if not source or not target or not edge_type:
        raise ValueError(f"cannot normalize base edge: {edge}")
    return {
        "id": edge.get("id") or f"{source}--{edge_type}--{target}",
        "from_change_id": source,
        "to_change_id": target,
        "edge_type": edge_type,
        "rationale": edge.get("rationale", edge.get("reason", "")),
        "source": "base-export",
    }


def materialize() -> dict:
    base = load_json(BASE)
    base_nodes = base.get("nodes", [])
    base_edges = base.get("edges", [])
    if len(base_nodes) != 52 or len(base_edges) != 52:
        raise ValueError(
            f"frozen base count changed: {len(base_nodes)} nodes, {len(base_edges)} edges"
        )
    nodes_by_numeric_id = {
        int(node["id"]): node["change_id"]
        for node in base_nodes
        if node.get("id") is not None
    }
    nodes = [
        {
            "change_id": node["change_id"],
            "node_type": node["node_type"],
            "title": node["title"],
            "status": node["status"],
            "created_at": node["created_at"],
            "updated_at": node.get("updated_at", node["created_at"]),
            "description": node.get("description", ""),
            "current": node.get("status") == "active",
            "source": "base-export",
        }
        for node in base_nodes
    ]
    edges = [normalize_base_edge(edge, nodes_by_numeric_id) for edge in base_edges]
    patches = []
    for path in sorted(PATCH_ROOT.glob("*.json")):
        patch = load_json(path)
        patches.append(
            {
                "path": path.relative_to(ROOT).as_posix(),
                "repository_head": patch["repository_head"],
            }
        )
        for node in patch.get("nodes", []):
            item = dict(node)
            item["source"] = path.relative_to(ROOT).as_posix()
            nodes.append(item)
        for edge in patch.get("edges", []):
            item = dict(edge)
            item["source"] = path.relative_to(ROOT).as_posix()
            edges.append(item)
    nodes.sort(key=lambda item: item["change_id"])
    edges.sort(key=lambda item: item["id"])
    return {
        "schema": "factory-floor-archaeology-current-v1",
        "repository": "laurajoyhutchins/factory-floor",
        "base_export": BASE.relative_to(ROOT).as_posix(),
        "patches": patches,
        "node_count": len(nodes),
        "edge_count": len(edges),
        "nodes": nodes,
        "edges": edges,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    graph = materialize()
    rendered = json.dumps(graph, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8", newline="\n")
    else:
        print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
