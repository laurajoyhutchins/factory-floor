#!/usr/bin/env python3
"""Validate Factory Floor's current base-plus-patch archaeology source."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import deque
from pathlib import Path

from materialize_current import PATCH_ROOT, ROOT, materialize

NODE_TYPES = {"goal", "option", "decision", "action", "outcome", "observation", "revisit"}
STATUSES = {"pending", "active", "completed", "rejected", "superseded", "abandoned"}
EDGE_TYPES = {"leads_to", "chosen", "rejected", "requires", "blocks", "enables", "supersedes"}
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
FORBIDDEN = (
    re.compile(r"[A-Za-z]:\\(?:Users|Documents)\\", re.I),
    re.compile(r"/Users/[^/\s]+/"),
    re.compile(r"/home/[^/\s]+/"),
    re.compile(r"(api[_-]?key|secret|password)\s*[:=]\s*\S+", re.I),
)


def fail(message: str) -> None:
    raise AssertionError(message)


def git_ok(*args: str) -> bool:
    return subprocess.run(
        ["git", *args],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    ).returncode == 0


def validate_patches() -> None:
    paths = sorted(PATCH_ROOT.glob("*.json"))
    if not paths:
        fail("no archaeology patches found")
    for path in paths:
        text = path.read_text(encoding="utf-8")
        if "\r" in text or not text.endswith("\n"):
            fail(f"patch must use LF and end with a newline: {path.relative_to(ROOT)}")
        for pattern in FORBIDDEN:
            if pattern.search(text):
                fail(f"private path or credential pattern in {path.relative_to(ROOT)}")
        patch = json.loads(text)
        if patch.get("schema") != "factory-floor-archaeology-patch-v1":
            fail(f"unsupported patch schema: {path.relative_to(ROOT)}")
        if patch.get("base_node_count") != 52 or patch.get("base_edge_count") != 52:
            fail(f"patch base-count contract changed: {path.relative_to(ROOT)}")
        repository_head = patch.get("repository_head", "")
        if not FULL_SHA.fullmatch(repository_head):
            fail(f"invalid repository head: {path.relative_to(ROOT)}")
        if not git_ok("cat-file", "-e", f"{repository_head}^{{commit}}"):
            fail(f"missing repository head {repository_head}")
        if not git_ok("merge-base", "--is-ancestor", repository_head, "HEAD"):
            fail(f"repository head is not an ancestor of candidate: {repository_head}")
        for node in patch.get("nodes", []):
            if node.get("node_type") not in NODE_TYPES:
                fail(f"unsupported node type: {node.get('semantic_id')}")
            if node.get("status") not in STATUSES:
                fail(f"unsupported native status: {node.get('semantic_id')}")
            if not node.get("lifecycle_status"):
                fail(f"missing lifecycle status: {node.get('semantic_id')}")
            evidence = node.get("evidence")
            if not isinstance(evidence, list) or not evidence:
                fail(f"missing evidence: {node.get('semantic_id')}")
            for item in evidence:
                revision = item.get("revision", "")
                evidence_path = item.get("path", "")
                if not FULL_SHA.fullmatch(revision) or not evidence_path:
                    fail(f"incomplete evidence on {node.get('semantic_id')}")
                if not git_ok("cat-file", "-e", f"{revision}:{evidence_path}"):
                    fail(f"unresolved evidence {revision}:{evidence_path}")
        for edge in patch.get("edges", []):
            if edge.get("edge_type") not in EDGE_TYPES:
                fail(f"unsupported edge type: {edge.get('id')}")
            if not edge.get("rationale"):
                fail(f"edge lacks rationale: {edge.get('id')}")


def validate_graph(graph: dict) -> None:
    if graph.get("node_count") != 56 or graph.get("edge_count") != 56:
        fail(
            f"expected 56 nodes/56 edges after reconciliation, got "
            f"{graph.get('node_count')}/{graph.get('edge_count')}"
        )
    nodes = graph["nodes"]
    edges = graph["edges"]
    change_ids = [node["change_id"] for node in nodes]
    edge_ids = [str(edge["id"]) for edge in edges]
    if len(set(change_ids)) != len(change_ids):
        fail("duplicate change IDs")
    if len(set(edge_ids)) != len(edge_ids):
        fail("duplicate edge IDs")
    known = set(change_ids)
    required = {
        "08e12cfe-7f23-503c-874b-3cd8c48614dc",
        "25d95921-f117-598a-bab8-d868e41b6386",
        "43fa9478-4fb4-5b73-bbb9-c33e61c387cd",
        "2f4d0ee5-a6df-5a25-a545-098299ae6df4",
        "3d9ba0e2-66bd-5979-b2db-8af45881b929",
    }
    if not required <= known:
        fail(f"missing reconciliation nodes: {sorted(required - known)}")
    adjacency = {change_id: [] for change_id in known}
    indegree = {change_id: 0 for change_id in known}
    for edge in edges:
        source = edge["from_change_id"]
        target = edge["to_change_id"]
        if source not in known or target not in known:
            fail(f"unresolved edge endpoint: {edge['id']}")
        if edge["edge_type"] not in EDGE_TYPES:
            fail(f"unsupported materialized edge type: {edge['id']}")
        if edge["edge_type"] != "supersedes":
            adjacency[source].append(target)
            indegree[target] += 1
    queue = deque(sorted(change_id for change_id, degree in indegree.items() if degree == 0))
    visited = 0
    while queue:
        source = queue.popleft()
        visited += 1
        for target in sorted(adjacency[source]):
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    if visited != len(known):
        fail("materialized current graph contains a forward causal cycle")
    by_semantic = {node.get("semantic_id"): node for node in nodes if node.get("semantic_id")}
    outcome = by_semantic.get("outcome.operator.portfolio-view-preserves-authority")
    if not outcome or "not a universal portfolio-to-execution integration" not in outcome["description"]:
        fail("portfolio integration qualification is missing")


def main() -> int:
    validate_patches()
    first = materialize()
    second = materialize()
    if json.dumps(first, sort_keys=True) != json.dumps(second, sort_keys=True):
        fail("current archaeology materialization is nondeterministic")
    validate_graph(first)
    print(
        f"Factory Floor current archaeology valid: {first['node_count']} nodes, "
        f"{first['edge_count']} edges, {len(first['patches'])} patch"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, ValueError, KeyError, TypeError) as error:
        print(f"archaeology validation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
