from __future__ import annotations

import hashlib
import json
import math
import os
import re
import sqlite3
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

import dagster as dg

SCHEMA_VERSION = 1
SIMILARITY_THRESHOLD = 0.55
MARGIN_THRESHOLD = 0.02
DEFAULT_EMBEDDING_MODEL = "nomic-embed-text:latest"
PLACEHOLDER_PATTERN = re.compile(
    r"^(?:human readable name|placeholder(?: entity)?|unknown|unnamed|entity)$",
    re.IGNORECASE,
)

Graph = dict[str, Any]
Embedder = Callable[[list[str]], list[list[float]]]


def _boostin_home() -> Path:
    configured = os.environ.get("BOOSTIN_HOME")
    if configured:
        return Path(configured).expanduser().resolve()
    return (
        Path.home() / "Library" / "Application Support" / "Boostin"
    ).resolve()


def _pipeline_root() -> Path:
    root = _boostin_home() / "pipeline"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root.chmod(0o700)
    return root


def _derived_database_path() -> Path:
    configured = os.environ.get("BOOSTIN_PIPELINE_DB")
    path = (
        Path(configured).expanduser().resolve()
        if configured
        else _pipeline_root() / "boostin-pipeline.db"
    )
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    if path.is_symlink():
        raise ValueError("refusing symbolic link for derived pipeline database")
    return path


def _source_database() -> sqlite3.Connection:
    path = _boostin_home() / "boostin.db"
    if not path.is_file() or path.is_symlink():
        raise ValueError("Boostin source database is unavailable or unsafe")
    uri = f"file:{urllib.parse.quote(str(path))}?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def _derived_database() -> sqlite3.Connection:
    path = _derived_database_path()
    if not path.exists():
        path.touch(mode=0o600, exist_ok=False)
    connection = sqlite3.connect(path)
    path.chmod(0o600)
    connection.execute("PRAGMA foreign_keys = ON")
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS pipeline_runs (
          run_id TEXT PRIMARY KEY,
          source_checksum TEXT NOT NULL,
          source_graph_ref TEXT NOT NULL,
          transformation_version INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS bronze_nodes (
          run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          raw_id TEXT NOT NULL,
          label TEXT,
          kind TEXT,
          evidence_ref TEXT,
          raw_json TEXT NOT NULL,
          PRIMARY KEY (run_id, raw_id)
        );
        CREATE TABLE IF NOT EXISTS bronze_edges (
          run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          edge_index INTEGER NOT NULL,
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          relation TEXT,
          confidence TEXT,
          raw_json TEXT NOT NULL,
          PRIMARY KEY (run_id, edge_index)
        );
        CREATE TABLE IF NOT EXISTS silver_nodes (
          run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          raw_id TEXT NOT NULL,
          canonical_id TEXT,
          normalized_label TEXT,
          status TEXT NOT NULL,
          method TEXT NOT NULL,
          similarity REAL,
          margin REAL,
          evidence_ref TEXT,
          embedding_model TEXT,
          PRIMARY KEY (run_id, raw_id)
        );
        CREATE TABLE IF NOT EXISTS resolution_candidates (
          run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          raw_id TEXT NOT NULL,
          candidate_id TEXT NOT NULL,
          similarity REAL NOT NULL,
          rank INTEGER NOT NULL,
          PRIMARY KEY (run_id, raw_id, candidate_id)
        );
        CREATE TABLE IF NOT EXISTS gold_nodes (
          run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          canonical_id TEXT NOT NULL,
          label TEXT NOT NULL,
          evidence_count INTEGER NOT NULL,
          PRIMARY KEY (run_id, canonical_id)
        );
        CREATE TABLE IF NOT EXISTS gold_edges (
          run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          relation TEXT NOT NULL,
          evidence_count INTEGER NOT NULL,
          PRIMARY KEY (run_id, source_id, target_id, relation)
        );
        CREATE TABLE IF NOT EXISTS article_insights (
          run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          insight_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY (run_id, insight_key)
        );
        CREATE TABLE IF NOT EXISTS quality_results (
          run_id TEXT NOT NULL REFERENCES pipeline_runs(run_id) ON DELETE CASCADE,
          check_name TEXT NOT NULL,
          passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
          details_json TEXT NOT NULL,
          PRIMARY KEY (run_id, check_name)
        );
        PRAGMA user_version = 1;
        """
    )
    return connection


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _private_ref(path: Path) -> str:
    home = _boostin_home()
    resolved = path.resolve()
    if not _within(resolved, home):
        raise ValueError("private graph path escapes the Boostin home")
    return resolved.relative_to(home).as_posix()


def _latest_graph_run() -> dict[str, str]:
    requested = os.environ.get("BOOSTIN_PIPELINE_RAW_RUN")
    source = _source_database()
    try:
        if requested:
            row = source.execute(
                """
                SELECT id, corpus_path, output_path, graph_checksum
                FROM graph_runs
                WHERE id = ? AND status = 'completed'
                """,
                (requested,),
            ).fetchone()
        else:
            row = source.execute(
                """
                SELECT id, corpus_path, output_path, graph_checksum
                FROM graph_runs
                WHERE status = 'completed'
                ORDER BY completed_at DESC, created_at DESC, id DESC
                LIMIT 1
                """
            ).fetchone()
    finally:
        source.close()
    if row is None:
        raise ValueError("no completed private Graphify run is available")
    return {key: str(row[key]) for key in row.keys()}


def _graph_edges(document: Graph) -> list[Graph]:
    edges = document.get("edges", document.get("links"))
    if not isinstance(edges, list):
        raise ValueError("raw graph must contain an edges or links array")
    return edges


def _evidence_reference(node: Graph, corpus_root: Path) -> str | None:
    source_file = node.get("source_file")
    if not isinstance(source_file, str) or not source_file.strip():
        return None
    candidate = Path(source_file)
    if candidate.is_absolute():
        resolved = candidate.resolve()
    else:
        resolved = (corpus_root / candidate).resolve()
    if not _within(resolved, corpus_root.resolve()):
        return None
    return resolved.relative_to(corpus_root.resolve()).as_posix()


def load_bronze() -> Graph:
    run = _latest_graph_run()
    output_root = Path(run["output_path"]).expanduser().resolve()
    graph_path = output_root / "graphify-out" / "graph.json"
    corpus_root = Path(run["corpus_path"]).expanduser().resolve()
    if (
        not graph_path.is_file()
        or graph_path.is_symlink()
        or not _within(graph_path.resolve(), _boostin_home())
    ):
        raise ValueError("private graph artifact is unavailable or unsafe")
    if graph_path.stat().st_size > 100 * 1024 * 1024:
        raise ValueError("private graph artifact exceeds 100 MB")
    checksum = _sha256(graph_path)
    if not run["graph_checksum"] or checksum != run["graph_checksum"]:
        raise ValueError("private graph checksum does not match its run record")

    document = json.loads(graph_path.read_text(encoding="utf8"))
    nodes = document.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("raw graph must contain a nodes array")
    edges = _graph_edges(document)
    node_ids: set[str] = set()
    bronze_nodes: list[Graph] = []
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("raw graph nodes must be objects")
        raw_id = node.get("id")
        if not isinstance(raw_id, str) or not raw_id or raw_id in node_ids:
            raise ValueError("raw graph node IDs must be present and unique")
        node_ids.add(raw_id)
        bronze_nodes.append(
            {
                **node,
                "evidence_ref": _evidence_reference(node, corpus_root),
            }
        )
    for edge in edges:
        if not isinstance(edge, dict):
            raise ValueError("raw graph edges must be objects")
        source = edge.get("source")
        target = edge.get("target")
        if source not in node_ids or target not in node_ids:
            raise ValueError(f"raw graph contains a dangling edge: {source} -> {target}")
        if source == target:
            raise ValueError(f"raw graph contains a self-loop: {source}")

    return {
        "run_id": run["id"],
        "source_checksum": checksum,
        "source_graph_ref": _private_ref(graph_path),
        "corpus_ref": _private_ref(corpus_root),
        "nodes": bronze_nodes,
        "edges": edges,
    }


def _normalize_label(value: str) -> str:
    return " ".join(value.split()).strip()


def _canonical_id(value: str) -> str:
    normalized = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return normalized[:100] or hashlib.sha256(value.encode()).hexdigest()[:16]


def _is_placeholder(label: str) -> bool:
    return not label or bool(PLACEHOLDER_PATTERN.fullmatch(_normalize_label(label)))


def _cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        raise ValueError("embedding vectors must have equal non-zero dimensions")
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0 or right_norm == 0:
        return 0.0
    return dot / (left_norm * right_norm)


def _read_evidence(corpus_ref: str, evidence_ref: str | None) -> str | None:
    if not evidence_ref:
        return None
    corpus = (_boostin_home() / corpus_ref).resolve()
    evidence = (corpus / evidence_ref).resolve()
    if (
        not _within(evidence, corpus)
        or not evidence.is_file()
        or evidence.is_symlink()
        or evidence.stat().st_size > 5 * 1024 * 1024
    ):
        return None
    return evidence.read_text(encoding="utf8").strip()[:16_000]


def embed_texts(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    base_url = os.environ.get(
        "BOOSTIN_OLLAMA_URL", "http://127.0.0.1:11434"
    )
    parsed = urllib.parse.urlparse(base_url)
    if parsed.scheme != "http" or parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise ValueError("Boostin embeddings require an HTTP loopback Ollama URL")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/embed",
        data=json.dumps(
            {
                "model": os.environ.get(
                    "BOOSTIN_PIPELINE_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL
                ),
                "input": texts,
            }
        ).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            payload = json.load(response)
    except OSError as error:
        raise ValueError(
            "local Ollama embeddings are unavailable; start Ollama and install "
            f"{DEFAULT_EMBEDDING_MODEL}"
        ) from error
    embeddings = payload.get("embeddings")
    if not isinstance(embeddings, list) or len(embeddings) != len(texts):
        raise ValueError("local Ollama returned an invalid embedding response")
    return embeddings


def _review_path() -> Path:
    configured = os.environ.get("BOOSTIN_PIPELINE_REVIEW_FILE")
    path = (
        Path(configured).expanduser().resolve()
        if configured
        else _pipeline_root() / "review-decisions.json"
    )
    if not _within(path, _boostin_home()) or path.is_symlink():
        raise ValueError("review decisions must be a regular file under BOOSTIN_HOME")
    return path


def _apply_review_decisions(
    bronze: Graph,
    silver: list[Graph],
    candidates: list[Graph],
) -> None:
    path = _review_path()
    quarantined = [
        node for node in silver if node["status"] == "quarantined"
    ]
    if not path.exists():
        candidate_by_raw: dict[str, list[Graph]] = {}
        for candidate in candidates:
            candidate_by_raw.setdefault(candidate["raw_id"], []).append(candidate)
        template = {
            "version": 1,
            "sourceChecksum": bronze["source_checksum"],
            "decisions": [],
            "quarantined": [
                {
                    "rawId": node["raw_id"],
                    "evidenceRef": node["evidence_ref"],
                    "candidates": [
                        {
                            "canonicalId": candidate["candidate_id"],
                            "similarity": round(candidate["similarity"], 6),
                            "rank": candidate["rank"],
                        }
                        for candidate in candidate_by_raw.get(node["raw_id"], [])
                    ],
                }
                for node in quarantined
            ],
        }
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf8") as handle:
            json.dump(template, handle, indent=2, sort_keys=True)
            handle.write("\n")
        path.chmod(0o600)
        return

    if not path.is_file():
        raise ValueError("review decisions path must be a regular file")
    payload = json.loads(path.read_text(encoding="utf8"))
    if (
        not isinstance(payload, dict)
        or payload.get("version") != 1
        or payload.get("sourceChecksum") != bronze["source_checksum"]
        or not isinstance(payload.get("decisions"), list)
    ):
        raise ValueError("review decisions are invalid or stale for this graph")

    silver_by_raw = {node["raw_id"]: node for node in silver}
    label_by_canonical = {
        node["canonical_id"]: node["normalized_label"]
        for node in silver
        if node["canonical_id"] and node["normalized_label"]
    }
    decided: set[str] = set()
    for decision in payload["decisions"]:
        if not isinstance(decision, dict):
            raise ValueError("review decisions must be objects")
        raw_id = decision.get("rawId")
        action = decision.get("action")
        if (
            not isinstance(raw_id, str)
            or raw_id not in silver_by_raw
            or raw_id in decided
        ):
            raise ValueError("review decision references an unknown or duplicate raw ID")
        decided.add(raw_id)
        node = silver_by_raw[raw_id]
        if action == "reject":
            node.update(
                canonical_id=None,
                normalized_label=None,
                status="rejected",
                method="human-review",
                embedding_model=None,
            )
            continue
        canonical_id = decision.get("canonicalId")
        if action == "merge":
            if canonical_id not in label_by_canonical:
                raise ValueError("review merge references an unknown canonical ID")
            node.update(
                canonical_id=canonical_id,
                normalized_label=label_by_canonical[canonical_id],
                status="merged",
                method="human-review",
                embedding_model=None,
            )
            continue
        if action == "resolve":
            label = decision.get("label")
            if (
                not isinstance(canonical_id, str)
                or not canonical_id
                or canonical_id in label_by_canonical
                or not isinstance(label, str)
                or _is_placeholder(label)
            ):
                raise ValueError("review resolve requires a unique ID and valid label")
            normalized_label = _normalize_label(label)
            label_by_canonical[canonical_id] = normalized_label
            node.update(
                canonical_id=canonical_id,
                normalized_label=normalized_label,
                status="resolved",
                method="human-review",
                embedding_model=None,
            )
            continue
        raise ValueError("review action must be merge, resolve, or reject")


def resolve_silver(bronze: Graph, embedder: Embedder = embed_texts) -> Graph:
    anchors: list[Graph] = []
    silver: list[Graph] = []
    anchor_by_label: dict[str, Graph] = {}
    placeholders: list[Graph] = []

    for node in bronze["nodes"]:
        raw_label = node.get("label")
        label = _normalize_label(raw_label) if isinstance(raw_label, str) else ""
        if _is_placeholder(label):
            placeholders.append(node)
            continue
        normalized = label.casefold()
        existing = anchor_by_label.get(normalized)
        if existing:
            silver.append(
                {
                    "raw_id": node["id"],
                    "canonical_id": existing["canonical_id"],
                    "normalized_label": label,
                    "status": "merged",
                    "method": "duplicate-label",
                    "similarity": 1.0,
                    "margin": 1.0,
                    "evidence_ref": node.get("evidence_ref"),
                    "embedding_model": None,
                }
            )
            continue
        anchor = {
            "raw_id": node["id"],
            "canonical_id": _canonical_id(label),
            "normalized_label": label,
            "status": "resolved",
            "method": "normalized-label",
            "similarity": None,
            "margin": None,
            "evidence_ref": node.get("evidence_ref"),
            "embedding_model": None,
        }
        anchors.append(anchor)
        anchor_by_label[normalized] = anchor
        silver.append(anchor)

    evidence_texts = [
        _read_evidence(bronze["corpus_ref"], node.get("evidence_ref"))
        for node in placeholders
    ]
    candidates: list[Graph] = []
    resolvable = [
        (node, text)
        for node, text in zip(placeholders, evidence_texts, strict=True)
        if text
    ]
    vectors: list[list[float]] = []
    if anchors and resolvable:
        vectors = embedder(
            [anchor["normalized_label"].casefold() for anchor in anchors]
            + [text for _, text in resolvable]
        )
    anchor_vectors = vectors[: len(anchors)]
    resolved_vectors = vectors[len(anchors) :]
    vector_by_raw_id = {
        node["id"]: vector
        for (node, _), vector in zip(resolvable, resolved_vectors, strict=True)
    }
    model = os.environ.get(
        "BOOSTIN_PIPELINE_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL
    )

    for node in placeholders:
        vector = vector_by_raw_id.get(node["id"])
        if vector is None or not anchors:
            silver.append(
                {
                    "raw_id": node["id"],
                    "canonical_id": None,
                    "normalized_label": None,
                    "status": "quarantined",
                    "method": "insufficient-evidence",
                    "similarity": None,
                    "margin": None,
                    "evidence_ref": node.get("evidence_ref"),
                    "embedding_model": None,
                }
            )
            continue
        ranked = sorted(
            (
                (_cosine(vector, anchor_vector), anchor)
                for anchor, anchor_vector in zip(
                    anchors, anchor_vectors, strict=True
                )
            ),
            key=lambda item: (-item[0], item[1]["canonical_id"]),
        )
        for rank, (score, anchor) in enumerate(ranked, start=1):
            candidates.append(
                {
                    "raw_id": node["id"],
                    "candidate_id": anchor["canonical_id"],
                    "similarity": score,
                    "rank": rank,
                }
            )
        score, winner = ranked[0]
        runner_up = ranked[1][0] if len(ranked) > 1 else 0.0
        margin = score - runner_up
        promoted = score >= SIMILARITY_THRESHOLD and margin >= MARGIN_THRESHOLD
        silver.append(
            {
                "raw_id": node["id"],
                "canonical_id": winner["canonical_id"] if promoted else None,
                "normalized_label": (
                    winner["normalized_label"] if promoted else None
                ),
                "status": "merged" if promoted else "quarantined",
                "method": "local-embedding",
                "similarity": score,
                "margin": margin,
                "evidence_ref": node.get("evidence_ref"),
                "embedding_model": model,
            }
        )

    if len(silver) != len(bronze["nodes"]):
        raise ValueError("Silver retention invariant failed")
    _apply_review_decisions(bronze, silver, candidates)
    return {**bronze, "silver_nodes": silver, "candidates": candidates}


def build_gold(silver: Graph) -> Graph:
    resolution = {
        node["raw_id"]: node["canonical_id"]
        for node in silver["silver_nodes"]
        if node["canonical_id"]
    }
    labels: dict[str, str] = {}
    evidence_counts: dict[str, int] = {}
    for node in silver["silver_nodes"]:
        canonical = node["canonical_id"]
        if not canonical:
            continue
        labels.setdefault(canonical, node["normalized_label"])
        evidence_counts[canonical] = evidence_counts.get(canonical, 0) + 1
    edges: dict[tuple[str, str, str], int] = {}
    for edge in silver["edges"]:
        source = resolution.get(edge["source"])
        target = resolution.get(edge["target"])
        if not source or not target or source == target:
            continue
        source, target = sorted((source, target))
        relation = str(edge.get("relation") or "related_to")
        key = (source, target, relation)
        edges[key] = edges.get(key, 0) + 1

    nodes = [
        {
            "canonical_id": canonical,
            "label": labels[canonical],
            "evidence_count": evidence_counts[canonical],
        }
        for canonical in sorted(labels)
    ]
    gold_edges = [
        {
            "source_id": source,
            "target_id": target,
            "relation": relation,
            "evidence_count": count,
        }
        for (source, target, relation), count in sorted(edges.items())
    ]
    if nodes:
        adjacency = {node["canonical_id"]: set() for node in nodes}
        for edge in gold_edges:
            adjacency[edge["source_id"]].add(edge["target_id"])
            adjacency[edge["target_id"]].add(edge["source_id"])
        pending = [nodes[0]["canonical_id"]]
        visited = set(pending)
        while pending:
            current = pending.pop()
            for neighbor in adjacency[current]:
                if neighbor not in visited:
                    visited.add(neighbor)
                    pending.append(neighbor)
        if len(visited) != len(nodes):
            raise ValueError(
                "Gold promotion failed: resolved graph is disconnected"
            )
    insights = {
        "graph_summary": {
            "nodes": len(nodes),
            "edges": len(gold_edges),
            "quarantined": sum(
                node["status"] == "quarantined"
                for node in silver["silver_nodes"]
            ),
            "confidence": "derived-private",
        }
    }
    return {**silver, "gold_nodes": nodes, "gold_edges": gold_edges, "insights": insights}


def _persist_bronze(bronze: Graph) -> None:
    database = _derived_database()
    try:
        with database:
            database.execute(
                "DELETE FROM pipeline_runs WHERE run_id = ?", (bronze["run_id"],)
            )
            database.execute(
                """
                INSERT INTO pipeline_runs
                  (run_id, source_checksum, source_graph_ref,
                   transformation_version)
                VALUES (?, ?, ?, ?)
                """,
                (
                    bronze["run_id"],
                    bronze["source_checksum"],
                    bronze["source_graph_ref"],
                    SCHEMA_VERSION,
                ),
            )
            database.executemany(
                """
                INSERT INTO bronze_nodes
                  (run_id, raw_id, label, kind, evidence_ref, raw_json)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        bronze["run_id"],
                        node["id"],
                        node.get("label"),
                        node.get("kind"),
                        node.get("evidence_ref"),
                        json.dumps(node, sort_keys=True, separators=(",", ":")),
                    )
                    for node in bronze["nodes"]
                ],
            )
            database.executemany(
                """
                INSERT INTO bronze_edges
                  (run_id, edge_index, source_id, target_id, relation,
                   confidence, raw_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        bronze["run_id"],
                        index,
                        edge["source"],
                        edge["target"],
                        edge.get("relation"),
                        edge.get("confidence"),
                        json.dumps(edge, sort_keys=True, separators=(",", ":")),
                    )
                    for index, edge in enumerate(bronze["edges"])
                ],
            )
            database.execute(
                """
                INSERT INTO quality_results
                  (run_id, check_name, passed, details_json)
                VALUES (?, 'bronze_integrity', 1, ?)
                """,
                (
                    bronze["run_id"],
                    json.dumps(
                        {
                            "nodes": len(bronze["nodes"]),
                            "edges": len(bronze["edges"]),
                            "source_checksum": bronze["source_checksum"],
                        },
                        sort_keys=True,
                    ),
                ),
            )
    finally:
        database.close()


def _persist_silver(silver: Graph) -> None:
    database = _derived_database()
    try:
        with database:
            database.executemany(
                """
                INSERT INTO silver_nodes
                  (run_id, raw_id, canonical_id, normalized_label, status,
                   method, similarity, margin, evidence_ref, embedding_model)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        silver["run_id"],
                        node["raw_id"],
                        node["canonical_id"],
                        node["normalized_label"],
                        node["status"],
                        node["method"],
                        node["similarity"],
                        node["margin"],
                        node["evidence_ref"],
                        node["embedding_model"],
                    )
                    for node in silver["silver_nodes"]
                ],
            )
            database.executemany(
                """
                INSERT INTO resolution_candidates
                  (run_id, raw_id, candidate_id, similarity, rank)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (
                        silver["run_id"],
                        candidate["raw_id"],
                        candidate["candidate_id"],
                        candidate["similarity"],
                        candidate["rank"],
                    )
                    for candidate in silver["candidates"]
                ],
            )
            database.execute(
                """
                INSERT INTO quality_results
                  (run_id, check_name, passed, details_json)
                VALUES (?, 'silver_retention', 1, ?)
                """,
                (
                    silver["run_id"],
                    json.dumps(
                        {
                            "bronze_nodes": len(silver["nodes"]),
                            "silver_nodes": len(silver["silver_nodes"]),
                            "quarantined": sum(
                                node["status"] == "quarantined"
                                for node in silver["silver_nodes"]
                            ),
                        },
                        sort_keys=True,
                    ),
                ),
            )
    finally:
        database.close()


def _persist_gold(gold: Graph) -> None:
    database = _derived_database()
    try:
        with database:
            database.executemany(
                """
                INSERT INTO gold_nodes
                  (run_id, canonical_id, label, evidence_count)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (
                        gold["run_id"],
                        node["canonical_id"],
                        node["label"],
                        node["evidence_count"],
                    )
                    for node in gold["gold_nodes"]
                ],
            )
            database.executemany(
                """
                INSERT INTO gold_edges
                  (run_id, source_id, target_id, relation, evidence_count)
                VALUES (?, ?, ?, ?, ?)
                """,
                [
                    (
                        gold["run_id"],
                        edge["source_id"],
                        edge["target_id"],
                        edge["relation"],
                        edge["evidence_count"],
                    )
                    for edge in gold["gold_edges"]
                ],
            )
            database.executemany(
                """
                INSERT INTO article_insights
                  (run_id, insight_key, value_json)
                VALUES (?, ?, ?)
                """,
                [
                    (
                        gold["run_id"],
                        key,
                        json.dumps(value, sort_keys=True),
                    )
                    for key, value in gold["insights"].items()
                ],
            )
            database.execute(
                """
                INSERT INTO quality_results
                  (run_id, check_name, passed, details_json)
                VALUES (?, 'gold_connected', 1, ?)
                """,
                (
                    gold["run_id"],
                    json.dumps(
                        {
                            "nodes": len(gold["gold_nodes"]),
                            "edges": len(gold["gold_edges"]),
                        },
                        sort_keys=True,
                    ),
                ),
            )
    finally:
        database.close()


@dg.asset(
    group_name="bronze",
    description="Immutable snapshot of the latest completed private Graphify run.",
    metadata={"classification": "private-local", "layer": "bronze"},
)
def bronze_graph(context) -> Graph:
    bronze = load_bronze()
    _persist_bronze(bronze)
    context.add_output_metadata(
        {
            "source_checksum": bronze["source_checksum"],
            "node_count": len(bronze["nodes"]),
            "edge_count": len(bronze["edges"]),
        }
    )
    return bronze


@dg.asset(
    group_name="silver",
    description="Normalized graph with complete lineage and conservative quarantine.",
    metadata={"classification": "private-local", "layer": "silver"},
)
def silver_graph(context, bronze_graph: Graph) -> Graph:
    silver = resolve_silver(bronze_graph, embed_texts)
    _persist_silver(silver)
    context.add_output_metadata(
        {
            "retained_count": len(silver["silver_nodes"]),
            "quarantined_count": sum(
                node["status"] == "quarantined"
                for node in silver["silver_nodes"]
            ),
            "embedding_model": os.environ.get(
                "BOOSTIN_PIPELINE_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL
            ),
        }
    )
    return silver


@dg.asset(
    group_name="gold",
    description="Connected private analytical graph and evidence-backed insights.",
    metadata={"classification": "private-local", "layer": "gold"},
)
def gold_graph(context, silver_graph: Graph) -> Graph:
    gold = build_gold(silver_graph)
    _persist_gold(gold)
    context.add_output_metadata(
        {
            "node_count": len(gold["gold_nodes"]),
            "edge_count": len(gold["gold_edges"]),
        }
    )
    return gold


@dg.asset_check(asset=bronze_graph)
def bronze_graph_valid(bronze_graph: Graph) -> dg.AssetCheckResult:
    return dg.AssetCheckResult(
        passed=bool(bronze_graph["nodes"]),
        metadata={"node_count": len(bronze_graph["nodes"])},
    )


@dg.asset_check(asset=silver_graph)
def silver_graph_valid(silver_graph: Graph) -> dg.AssetCheckResult:
    return dg.AssetCheckResult(
        passed=len(silver_graph["nodes"]) == len(silver_graph["silver_nodes"]),
        metadata={
            "bronze_count": len(silver_graph["nodes"]),
            "silver_count": len(silver_graph["silver_nodes"]),
        },
    )


@dg.asset_check(asset=gold_graph, blocking=True)
def gold_graph_valid(gold_graph: Graph) -> dg.AssetCheckResult:
    return dg.AssetCheckResult(
        passed=bool(gold_graph["gold_nodes"]),
        metadata={
            "node_count": len(gold_graph["gold_nodes"]),
            "edge_count": len(gold_graph["gold_edges"]),
        },
    )
