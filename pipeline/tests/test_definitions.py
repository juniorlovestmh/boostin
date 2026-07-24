import hashlib
import json
import sqlite3
from pathlib import Path

import dagster as dg
import pytest

from boostin_pipeline.definitions import defs
from boostin_pipeline.defs.assets import (
    bronze_graph,
    bronze_graph_valid,
    gold_graph,
    gold_graph_valid,
    resolve_silver,
    silver_graph,
    silver_graph_valid,
)


def write_source_state(home: Path, graph: dict[str, object]) -> Path:
    run_id = "synthetic-run"
    run_root = home / "graphs" / run_id
    corpus = run_root / "corpus"
    output = run_root / "graphify-out"
    corpus.mkdir(parents=True)
    output.mkdir()
    (corpus / "placeholder.md").write_text(
        "Revenue operations systems and enablement.", encoding="utf8"
    )
    graph_path = output / "graph.json"
    graph_path.write_text(json.dumps(graph), encoding="utf8")
    checksum = hashlib.sha256(graph_path.read_bytes()).hexdigest()

    source = sqlite3.connect(home / "boostin.db")
    source.execute(
        """
        CREATE TABLE graph_runs (
          id TEXT PRIMARY KEY,
          corpus TEXT NOT NULL,
          created_at TEXT NOT NULL,
          completed_at TEXT,
          status TEXT NOT NULL,
          backend TEXT NOT NULL,
          model TEXT NOT NULL,
          graphify_version TEXT,
          corpus_path TEXT NOT NULL,
          output_path TEXT NOT NULL,
          graph_checksum TEXT,
          error TEXT
        )
        """
    )
    source.execute(
        """
        INSERT INTO graph_runs
          (id, corpus, created_at, completed_at, status, backend, model,
           graphify_version, corpus_path, output_path, graph_checksum)
        VALUES (?, 'professional', '2026-07-23T12:00:00Z',
                '2026-07-23T12:01:00Z', 'completed', 'ollama',
                'synthetic', 'test', ?, ?, ?)
        """,
        (run_id, str(corpus), str(run_root), checksum),
    )
    source.commit()
    source.close()
    return graph_path


def synthetic_graph() -> dict[str, object]:
    return {
        "nodes": [
            {"id": "access", "label": "Global customer access"},
            {"id": "revops", "label": "Revenue operations"},
            {"id": "revops-copy", "label": " Revenue   Operations "},
            {
                "id": "placeholder",
                "label": "Human Readable Name",
                "source_file": "placeholder.md",
            },
            {"id": "uncertain", "label": "Placeholder Entity"},
        ],
        "links": [
            {"source": "access", "target": "revops", "relation": "evolved_into"},
            {
                "source": "revops-copy",
                "target": "placeholder",
                "relation": "supports",
            },
        ],
    }


@pytest.fixture
def pipeline_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "boostin"
    home.mkdir(mode=0o700)
    write_source_state(home, synthetic_graph())
    monkeypatch.setenv("BOOSTIN_HOME", str(home))

    def fake_embeddings(texts: list[str]) -> list[list[float]]:
        vectors = {
            "global customer access": [1.0, 0.0],
            "revenue operations": [0.0, 1.0],
            "Revenue operations systems and enablement.": [0.0, 0.99],
        }
        return [vectors.get(text, [0.7, 0.7]) for text in texts]

    monkeypatch.setattr(
        "boostin_pipeline.defs.assets.embed_texts", fake_embeddings
    )
    return home


def test_definitions_are_loadable_and_executable() -> None:
    loaded = defs()
    dg.Definitions.validate_loadable(loaded)
    graph = loaded.resolve_asset_graph()

    assert {
        key.to_user_string() for key in graph.executable_asset_keys
    } == {"bronze_graph", "silver_graph", "gold_graph"}
    assert {
        key.to_user_string()
        for key in graph.get(dg.AssetKey("silver_graph")).parent_keys
    } == {"bronze_graph"}
    assert {
        key.to_user_string()
        for key in graph.get(dg.AssetKey("gold_graph")).parent_keys
    } == {"silver_graph"}


def test_materialization_retains_lineage_and_writes_only_derived_state(
    pipeline_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_path = pipeline_home / "boostin.db"
    source_checksum = hashlib.sha256(source_path.read_bytes()).hexdigest()
    dagster_home = tmp_path / "dagster"
    dagster_home.mkdir()
    monkeypatch.setenv("DAGSTER_HOME", str(dagster_home))

    result = dg.materialize(
        assets=[
            bronze_graph,
            silver_graph,
            gold_graph,
            bronze_graph_valid,
            silver_graph_valid,
            gold_graph_valid,
        ]
    )

    assert result.success
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == source_checksum
    derived_path = pipeline_home / "pipeline" / "boostin-pipeline.db"
    assert derived_path.is_file()
    assert derived_path.stat().st_mode & 0o777 == 0o600
    review_path = pipeline_home / "pipeline" / "review-decisions.json"
    review = json.loads(review_path.read_text(encoding="utf8"))
    assert review["sourceChecksum"]
    assert [item["rawId"] for item in review["quarantined"]] == ["uncertain"]
    assert review_path.stat().st_mode & 0o777 == 0o600

    derived = sqlite3.connect(derived_path)
    try:
        silver = derived.execute(
            """
            SELECT raw_id, canonical_id, status, method
            FROM silver_nodes
            ORDER BY raw_id
            """
        ).fetchall()
        assert silver == [
            ("access", "global-customer-access", "resolved", "normalized-label"),
            (
                "placeholder",
                "revenue-operations",
                "merged",
                "local-embedding",
            ),
            ("revops", "revenue-operations", "resolved", "normalized-label"),
            (
                "revops-copy",
                "revenue-operations",
                "merged",
                "duplicate-label",
            ),
            ("uncertain", None, "quarantined", "insufficient-evidence"),
        ]
        assert derived.execute("SELECT count(*) FROM bronze_nodes").fetchone() == (
            5,
        )
        assert derived.execute("SELECT count(*) FROM gold_nodes").fetchone() == (
            2,
        )
        assert derived.execute("SELECT count(*) FROM gold_edges").fetchone() == (
            1,
        )
        checks = dict(
            derived.execute(
                "SELECT check_name, passed FROM quality_results"
            ).fetchall()
        )
        assert checks == {
            "bronze_integrity": 1,
            "silver_retention": 1,
            "gold_connected": 1,
        }
    finally:
        derived.close()

    review["decisions"] = [
        {"rawId": "uncertain", "action": "reject"},
    ]
    review_path.write_text(json.dumps(review), encoding="utf8")
    second = dg.materialize(
        assets=[
            bronze_graph,
            silver_graph,
            gold_graph,
            bronze_graph_valid,
            silver_graph_valid,
            gold_graph_valid,
        ]
    )
    assert second.success
    assert hashlib.sha256(source_path.read_bytes()).hexdigest() == source_checksum
    derived = sqlite3.connect(derived_path)
    try:
        assert derived.execute(
            "SELECT status, method FROM silver_nodes WHERE raw_id = 'uncertain'"
        ).fetchone() == ("rejected", "human-review")
        assert derived.execute("SELECT count(*) FROM silver_nodes").fetchone() == (
            5,
        )
    finally:
        derived.close()


def _materialize_with_review(
    pipeline_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> tuple[Path, dict[str, object]]:
    dagster_home = tmp_path / "dagster"
    dagster_home.mkdir()
    monkeypatch.setenv("DAGSTER_HOME", str(dagster_home))
    result = dg.materialize(assets=[bronze_graph, silver_graph, gold_graph])
    assert result.success
    review_path = pipeline_home / "pipeline" / "review-decisions.json"
    review = json.loads(review_path.read_text(encoding="utf8"))
    return review_path, review


def test_review_checksum_guard_rejects_tampered_file(
    pipeline_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    review_path, review = _materialize_with_review(pipeline_home, tmp_path, monkeypatch)
    review["sourceChecksum"] = "tampered"
    review["decisions"] = [{"rawId": "uncertain", "action": "reject"}]
    review_path.write_text(json.dumps(review), encoding="utf8")

    with pytest.raises(ValueError, match="invalid or stale"):
        dg.materialize(assets=[bronze_graph, silver_graph, gold_graph])


def test_review_merge_decision_reuses_existing_canonical(
    pipeline_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    review_path, review = _materialize_with_review(pipeline_home, tmp_path, monkeypatch)
    review["decisions"] = [
        {"rawId": "uncertain", "action": "merge", "canonicalId": "revenue-operations"},
    ]
    review_path.write_text(json.dumps(review), encoding="utf8")

    result = dg.materialize(assets=[bronze_graph, silver_graph, gold_graph])
    assert result.success

    derived_path = pipeline_home / "pipeline" / "boostin-pipeline.db"
    derived = sqlite3.connect(derived_path)
    try:
        assert derived.execute(
            "SELECT canonical_id, status, method FROM silver_nodes WHERE raw_id = 'uncertain'"
        ).fetchone() == ("revenue-operations", "merged", "human-review")
    finally:
        derived.close()


def test_review_merge_decision_rejects_unknown_canonical(
    pipeline_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    review_path, review = _materialize_with_review(pipeline_home, tmp_path, monkeypatch)
    review["decisions"] = [
        {"rawId": "uncertain", "action": "merge", "canonicalId": "does-not-exist"},
    ]
    review_path.write_text(json.dumps(review), encoding="utf8")

    with pytest.raises(ValueError, match="unknown canonical ID"):
        dg.materialize(assets=[bronze_graph, silver_graph, gold_graph])


def test_review_resolve_decision_creates_new_canonical(
    pipeline_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    review_path, review = _materialize_with_review(pipeline_home, tmp_path, monkeypatch)
    review["decisions"] = [
        {
            "rawId": "uncertain",
            "action": "resolve",
            "canonicalId": "new-entity",
            "label": "New Entity",
        },
    ]
    review_path.write_text(json.dumps(review), encoding="utf8")

    result = dg.materialize(assets=[bronze_graph, silver_graph, gold_graph])
    assert result.success

    derived_path = pipeline_home / "pipeline" / "boostin-pipeline.db"
    derived = sqlite3.connect(derived_path)
    try:
        assert derived.execute(
            "SELECT canonical_id, status, method FROM silver_nodes WHERE raw_id = 'uncertain'"
        ).fetchone() == ("new-entity", "resolved", "human-review")
        assert derived.execute(
            "SELECT canonical_id FROM gold_nodes WHERE canonical_id = 'new-entity'"
        ).fetchone() == ("new-entity",)
    finally:
        derived.close()


def test_review_resolve_decision_rejects_duplicate_canonical(
    pipeline_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    review_path, review = _materialize_with_review(pipeline_home, tmp_path, monkeypatch)
    review["decisions"] = [
        {
            "rawId": "uncertain",
            "action": "resolve",
            "canonicalId": "revenue-operations",
            "label": "Revenue Operations",
        },
    ]
    review_path.write_text(json.dumps(review), encoding="utf8")

    with pytest.raises(ValueError, match="requires a unique ID"):
        dg.materialize(assets=[bronze_graph, silver_graph, gold_graph])


def test_review_resolve_decision_rejects_placeholder_label(
    pipeline_home: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    review_path, review = _materialize_with_review(pipeline_home, tmp_path, monkeypatch)
    review["decisions"] = [
        {
            "rawId": "uncertain",
            "action": "resolve",
            "canonicalId": "new-entity",
            "label": "Placeholder Entity",
        },
    ]
    review_path.write_text(json.dumps(review), encoding="utf8")

    with pytest.raises(ValueError, match="requires a unique ID"):
        dg.materialize(assets=[bronze_graph, silver_graph, gold_graph])


def test_long_labels_get_distinct_deterministic_canonical_ids() -> None:
    prefix = "A" * 110
    bronze = {
        "nodes": [
            {"id": "first", "label": f"{prefix} First"},
            {"id": "second", "label": f"{prefix} Second"},
        ],
        "edges": [],
    }

    first = resolve_silver(bronze)["silver_nodes"]
    second = resolve_silver(bronze)["silver_nodes"]
    first_ids = [node["canonical_id"] for node in first]
    second_ids = [node["canonical_id"] for node in second]

    assert first_ids == second_ids
    assert len(set(first_ids)) == 2
    assert all(len(canonical_id) == 100 for canonical_id in first_ids)


def test_bronze_rejects_dangling_edges(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "boostin"
    home.mkdir()
    write_source_state(
        home,
        {
            "nodes": [{"id": "known", "label": "Known"}],
            "edges": [{"source": "known", "target": "missing"}],
        },
    )
    monkeypatch.setenv("BOOSTIN_HOME", str(home))

    with pytest.raises(ValueError, match="dangling edge"):
        dg.materialize(assets=[bronze_graph])
