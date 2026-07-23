import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { getBoostinHome, openDatabase } from "./database.js";

const DEFAULT_MODEL = "llama3.2:latest";
const CONSTRAINED_MODEL = "boostin-graphify:latest";
const ALLOWED_SOURCE_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

interface GraphNode {
  id: string;
  label?: string;
  confidence?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
}

interface GraphDocument {
  nodes: GraphNode[];
  edges?: GraphEdge[];
  links?: GraphEdge[];
}

interface PublicAllowlist {
  title: string;
  nodes: Array<{
    sourceId: string;
    id: string;
    label: string;
    kind?: string;
  }>;
  edges: Array<{
    source: string;
    target: string;
    label: string;
    approvedInference?: boolean;
  }>;
}

export interface GraphBuildResult {
  id: string;
  status: "completed";
  corpus: string;
  model: string;
  output: string;
  graph: string;
  report: string;
  html: string;
}

export interface CuratedGraphResult {
  graph: string;
  html: string;
  report: string;
  evidence: string;
  nodes: number;
  edges: number;
  components: number;
  isolated: number;
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function chmodTreePrivate(path: string): void {
  const stats = statSync(path);
  if (stats.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) chmodTreePrivate(join(path, name));
  } else {
    chmodSync(path, 0o600);
  }
}

function safeStem(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || "source";
}

function writeCorpus(corpusPath: string, sources: string[]): number {
  mkdirPrivate(corpusPath);
  const { database } = openDatabase();
  let count = 0;
  try {
    const posts = database
      .prepare(`
        SELECT id, published_at, body, source_kind
        FROM posts
        WHERE deleted_at IS NULL AND trim(body) <> ''
        ORDER BY published_at, id
      `)
      .all() as Array<{
      id: string;
      published_at: string;
      body: string;
      source_kind: string;
    }>;
    for (const [index, post] of posts.entries()) {
      const path = join(
        corpusPath,
        `linkedin-${String(index + 1).padStart(3, "0")}-${post.id.slice(0, 12)}.md`,
      );
      writeFileSync(
        path,
        [
          "---",
          "type: linkedin-post",
          `published_at: ${JSON.stringify(post.published_at)}`,
          `provenance: ${JSON.stringify(post.source_kind)}`,
          "---",
          "",
          post.body,
          "",
        ].join("\n"),
        { mode: 0o600, flag: "wx" },
      );
      count += 1;
    }
  } finally {
    database.close();
  }

  for (const [index, source] of sources.entries()) {
    const absolute = resolve(source);
    const stats = statSync(absolute);
    const extension = extname(absolute).toLowerCase();
    if (!stats.isFile() || !ALLOWED_SOURCE_EXTENSIONS.has(extension)) {
      throw new Error(
        `Graph source must be a .md, .mdx, or .txt regular file: ${source}`,
      );
    }
    if (stats.size > 5 * 1024 * 1024) {
      throw new Error(`Graph source exceeds 5 MB: ${source}`);
    }
    const target = join(
      corpusPath,
      `public-source-${String(index + 1).padStart(2, "0")}-${safeStem(basename(absolute))}`,
    );
    copyFileSync(absolute, target);
    chmodSync(target, 0o600);
    count += 1;
  }
  if (count === 0) {
    throw new Error(
      "Professional corpus is empty; import posts or pass at least one --source file",
    );
  }
  return count;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function graphEdges(graph: GraphDocument): GraphEdge[] {
  if (Array.isArray(graph.edges)) return graph.edges;
  if (Array.isArray(graph.links)) return graph.links;
  throw new Error("Graph health check failed: unsupported graph.json shape");
}

function graphShape(graph: GraphDocument): {
  nodes: number;
  edges: number;
  components: number;
  isolated: number;
} {
  if (!Array.isArray(graph.nodes)) {
    throw new Error("Graph health check failed: unsupported graph.json shape");
  }
  const edges = graphEdges(graph);
  const adjacency = new Map(
    graph.nodes.map((node) => [node.id, new Set<string>()]),
  );
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  const visited = new Set<string>();
  let components = 0;
  for (const id of adjacency.keys()) {
    if (visited.has(id)) continue;
    components += 1;
    const pending = [id];
    visited.add(id);
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const neighbor of adjacency.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        pending.push(neighbor);
      }
    }
  }
  return {
    nodes: graph.nodes.length,
    edges: edges.length,
    components,
    isolated: [...adjacency.values()].filter((neighbors) => neighbors.size === 0)
      .length,
  };
}

function assertGraphHealth(path: string): void {
  const graph = JSON.parse(readFileSync(path, "utf8")) as GraphDocument;
  if (!Array.isArray(graph.nodes)) {
    throw new Error("Graph health check failed: unsupported graph.json shape");
  }
  const edges = graphEdges(graph);
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id || nodeIds.has(node.id)) {
      throw new Error(
        `Graph health check failed: missing or duplicate node id ${JSON.stringify(node.id)}`,
      );
    }
    nodeIds.add(node.id);
  }
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error(
        `Graph health check failed: dangling edge ${edge.source} -> ${edge.target}`,
      );
    }
    if (edge.source === edge.target) {
      throw new Error(`Graph health check failed: self-loop at ${edge.source}`);
    }
    const endpoints = [edge.source, edge.target].sort().join("\0");
    const key = `${endpoints}\0${edge.relation ?? ""}`;
    if (edgeKeys.has(key)) {
      throw new Error(
        `Graph health check failed: duplicate collapsed edge ${edge.source} -> ${edge.target}`,
      );
    }
    edgeKeys.add(key);
  }
}

function binaryVersion(binary: string): string {
  try {
    return execFileSync(binary, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    throw new Error(
      `Graphify is unavailable at ${binary}; install graphifyy or set BOOSTIN_GRAPHIFY_BIN`,
    );
  }
}

function requireOllamaTransport(binary: string): void {
  try {
    const resolvedBinary =
      binary.includes("/") || binary.includes("\\")
        ? binary
        : execFileSync("which", [binary], {
            encoding: "utf8",
            timeout: 10_000,
          }).trim();
    const firstLine =
      readFileSync(resolvedBinary, "utf8").split(/\r?\n/, 1)[0] ?? "";
    const interpreter = firstLine.startsWith("#!") ? firstLine.slice(2).trim() : "";
    if (!interpreter.includes("python") || !existsSync(interpreter)) return;
    const check = spawnSync(interpreter, ["-c", "import openai"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    if (check.status !== 0) {
      throw new Error(
        'Graphify lacks its Ollama transport; run `uv tool install "graphifyy[ollama]" --force`',
      );
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Graphify lacks its Ollama transport")
    ) {
      throw error;
    }
  }
}

function requireLoopbackOllamaUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OLLAMA_BASE_URL must be a valid loopback URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)
  ) {
    throw new Error(
      "Boostin graph builds require OLLAMA_BASE_URL to use HTTP loopback",
    );
  }
  return url.toString();
}

function ollamaHasModel(ollama: string, model: string): boolean {
  const result = spawnSync(ollama, ["show", model], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return !result.error && result.status === 0;
}

function prepareGraphModel(ollama: string): string {
  const explicit = process.env.BOOSTIN_GRAPH_MODEL;
  if (explicit) {
    if (!ollamaHasModel(ollama, explicit)) {
      throw new Error(
        `Ollama model ${explicit} is unavailable; run "ollama pull ${explicit}" and retry`,
      );
    }
    return explicit;
  }
  if (!ollamaHasModel(ollama, DEFAULT_MODEL)) {
    throw new Error(
      `Ollama model ${DEFAULT_MODEL} is unavailable; run "ollama pull ${DEFAULT_MODEL}" and retry`,
    );
  }
  if (ollamaHasModel(ollama, CONSTRAINED_MODEL)) return CONSTRAINED_MODEL;

  const home = getBoostinHome();
  mkdirPrivate(home);
  const modelFile = join(home, ".graphify-ollama.Modelfile");
  writeFileSync(
    modelFile,
    [
      `FROM ${DEFAULT_MODEL}`,
      "PARAMETER num_ctx 8192",
      "PARAMETER num_predict 2048",
      "PARAMETER temperature 0",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  try {
    const created = spawnSync(
      ollama,
      ["create", "boostin-graphify", "-f", modelFile],
      { encoding: "utf8", timeout: 5 * 60 * 1000 },
    );
    if (created.error || created.status !== 0) {
      throw new Error(
        `Unable to create the constrained local Graphify model: ${(
          created.stderr ||
          created.error?.message ||
          ""
        )
          .trim()
          .slice(0, 1000)}`,
      );
    }
  } finally {
    unlinkSync(modelFile);
  }
  return CONSTRAINED_MODEL;
}

export function buildProfessionalGraph(input: {
  corpus: string;
  sources: string[];
}): GraphBuildResult {
  if (input.corpus !== "professional") {
    throw new Error("corpus must be professional");
  }
  const graphify = process.env.BOOSTIN_GRAPHIFY_BIN ?? "graphify";
  const ollama = process.env.BOOSTIN_OLLAMA_BIN ?? "ollama";
  const tokenBudget = process.env.BOOSTIN_GRAPH_TOKEN_BUDGET ?? "2000";
  if (!/^[1-9][0-9]*$/.test(tokenBudget)) {
    throw new Error("BOOSTIN_GRAPH_TOKEN_BUDGET must be a positive integer");
  }
  const ollamaBaseUrl = requireLoopbackOllamaUrl(
    process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1",
  );
  const version = binaryVersion(graphify);
  requireOllamaTransport(graphify);
  const model = prepareGraphModel(ollama);

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const runPath = join(getBoostinHome(), "graphs", id);
  const corpusPath = join(runPath, "corpus");
  mkdirPrivate(runPath);
  writeCorpus(corpusPath, input.sources);
  const { database } = openDatabase();
  try {
    const record = database.transaction(() => {
      database
        .prepare(`
          UPDATE graph_runs
          SET status = 'interrupted', completed_at = ?,
              error = 'A newer graph run started before this run completed'
          WHERE status = 'running'
        `)
        .run(createdAt);
      database
        .prepare(`
          INSERT INTO graph_runs
            (id, corpus, created_at, status, backend, model, graphify_version,
             corpus_path, output_path)
          VALUES (?, ?, ?, 'running', 'ollama', ?, ?, ?, ?)
        `)
        .run(
          id,
          input.corpus,
          createdAt,
          model,
          version,
          corpusPath,
          runPath,
        );
    });
    record();
  } finally {
    database.close();
  }

  try {
    const run = spawnSync(
      graphify,
      [
        "extract",
        corpusPath,
        "--backend",
        "ollama",
        "--model",
        model,
        "--mode",
        "deep",
        "--max-concurrency",
        "1",
        "--token-budget",
        tokenBudget,
        "--api-timeout",
        "300",
        "--out",
        runPath,
      ],
      {
        encoding: "utf8",
        timeout: 60 * 60 * 1000,
        env: {
          ...process.env,
          OLLAMA_API_KEY: process.env.OLLAMA_API_KEY ?? "ollama-local",
          OLLAMA_BASE_URL: ollamaBaseUrl,
          GRAPHIFY_MAX_OUTPUT_TOKENS:
            process.env.GRAPHIFY_MAX_OUTPUT_TOKENS ?? "2048",
          GRAPHIFY_OLLAMA_NUM_CTX:
            process.env.GRAPHIFY_OLLAMA_NUM_CTX ?? "8192",
        },
      },
    );
    if (run.error || run.status !== 0) {
      const detail = (run.stderr || run.stdout || run.error?.message || "")
        .trim()
        .slice(0, 2000);
      throw new Error(
        `Graphify extraction failed${detail ? `: ${detail}` : ""}`,
      );
    }
    const output = join(runPath, "graphify-out");
    const graph = join(output, "graph.json");
    const report = join(output, "GRAPH_REPORT.md");
    const html = join(output, "graph.html");
    if (existsSync(graph) && (!existsSync(report) || !existsSync(html))) {
      const cluster = spawnSync(
        graphify,
        [
          "cluster-only",
          runPath,
          "--graph",
          graph,
          "--no-label",
        ],
        {
          encoding: "utf8",
          timeout: 15 * 60 * 1000,
          env: {
            ...process.env,
            OLLAMA_API_KEY: process.env.OLLAMA_API_KEY ?? "ollama-local",
            OLLAMA_BASE_URL: ollamaBaseUrl,
          },
        },
      );
      if (cluster.error || cluster.status !== 0) {
        const detail = (
          cluster.stderr ||
          cluster.stdout ||
          cluster.error?.message ||
          ""
        )
          .trim()
          .slice(0, 2000);
        throw new Error(
          `Graphify report generation failed${detail ? `: ${detail}` : ""}`,
        );
      }
    }
    for (const required of [graph, report, html]) {
      if (!existsSync(required)) {
        throw new Error(`Graphify did not produce ${basename(required)}`);
      }
    }
    assertGraphHealth(graph);
    chmodTreePrivate(runPath);
    const completedAt = new Date().toISOString();
    const complete = openDatabase();
    try {
      complete.database
        .prepare(`
          UPDATE graph_runs
          SET status = 'completed', completed_at = ?, graph_checksum = ?
          WHERE id = ?
        `)
        .run(completedAt, sha256(graph), id);
    } finally {
      complete.database.close();
    }
    return {
      id,
      status: "completed",
      corpus: input.corpus,
      model,
      output: runPath,
      graph,
      report,
      html,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = openDatabase();
    try {
      failed.database
        .prepare(`
          UPDATE graph_runs
          SET status = 'failed', completed_at = ?, error = ?
          WHERE id = ?
        `)
        .run(new Date().toISOString(), message, id);
    } finally {
      failed.database.close();
    }
    throw error;
  }
}

export function graphStatus(): Record<string, unknown> {
  const { database } = openDatabase();
  try {
    const row = database
      .prepare(`
        SELECT id, corpus, created_at, completed_at, status, backend, model,
               graphify_version, corpus_path, output_path, graph_checksum, error
        FROM graph_runs
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `)
      .get() as Record<string, unknown> | undefined;
    if (!row) throw new Error("No graph runs have been recorded");
    return row;
  } finally {
    database.close();
  }
}

export function curateProfessionalGraph(input: {
  run: string;
  review: string;
}): CuratedGraphResult {
  if (input.run !== "latest") {
    throw new Error("run currently supports only latest");
  }
  const status = graphStatus();
  if (status.status !== "completed") {
    throw new Error("Latest graph run is not complete");
  }
  const rawGraphPath = join(
    String(status.output_path),
    "graphify-out",
    "graph.json",
  );
  const rawGraph = JSON.parse(
    readFileSync(rawGraphPath, "utf8"),
  ) as GraphDocument;
  if (!Array.isArray(rawGraph.nodes)) {
    throw new Error("Latest graph.json has an unsupported shape");
  }
  const rawEdges = graphEdges(rawGraph);
  const rawNodeIds = new Set(rawGraph.nodes.map((node) => node.id));
  const review = readAllowlist(input.review);
  if (
    review.title.length > 100 ||
    review.nodes.length > 50 ||
    review.edges.length > 100
  ) {
    throw new Error("Curated graph review exceeds its size limits");
  }

  const publicIds = new Set<string>();
  const sourceIds = new Set<string>();
  const curatedNodes = review.nodes.map((node, index) => {
    if (
      !node.id ||
      !node.label ||
      node.label.length > 80 ||
      /human readable name|stem entity|placeholder/i.test(node.label)
    ) {
      throw new Error(`Curated node has an invalid label: ${node.id}`);
    }
    if (!rawNodeIds.has(node.sourceId)) {
      throw new Error(
        `Curated node source is not present in the private graph: ${node.id}`,
      );
    }
    if (publicIds.has(node.id)) {
      throw new Error(`Duplicate curated node id: ${node.id}`);
    }
    if (sourceIds.has(node.sourceId)) {
      throw new Error(`Duplicate curated source id: ${node.sourceId}`);
    }
    publicIds.add(node.id);
    sourceIds.add(node.sourceId);
    return {
      id: node.id,
      label: node.label,
      norm_label: node.label.toLowerCase(),
      kind: node.kind ?? "concept",
      review_status: "HUMAN_APPROVED",
      file_type: "curated",
      source_file: "CURATION_EVIDENCE.json",
      source_location: `review:nodes[${index}]`,
    };
  });
  const sourceByPublic = new Map(
    review.nodes.map((node) => [node.id, node.sourceId]),
  );
  const edgeKeys = new Set<string>();
  const curatedEdges = review.edges.map((edge, index) => {
    const sourceId = sourceByPublic.get(edge.source);
    const targetId = sourceByPublic.get(edge.target);
    if (
      !sourceId ||
      !targetId ||
      edge.source === edge.target ||
      !edge.label ||
      edge.label.length > 60
    ) {
      throw new Error(
        `Curated edge is invalid: ${edge.source} -> ${edge.target}`,
      );
    }
    const edgeKey = [edge.source, edge.target].sort().join("\0");
    if (edgeKeys.has(edgeKey)) {
      throw new Error(
        `Duplicate curated edge: ${edge.source} -> ${edge.target}`,
      );
    }
    edgeKeys.add(edgeKey);
    const privateEdge = rawEdges.find(
      (candidate) =>
        (candidate.source === sourceId && candidate.target === targetId) ||
        (candidate.source === targetId && candidate.target === sourceId),
    );
    let confidence = "HUMAN_APPROVED";
    if (privateEdge) {
      confidence = (privateEdge.confidence ?? "AMBIGUOUS").toUpperCase();
      if (confidence === "AMBIGUOUS") {
        throw new Error(
          `Ambiguous edge cannot enter the curated graph: ${edge.source} -> ${edge.target}`,
        );
      }
      if (confidence === "INFERRED" && edge.approvedInference !== true) {
        throw new Error(
          `Inferred edge requires approvedInference: ${edge.source} -> ${edge.target}`,
        );
      }
    } else if (edge.approvedInference !== true) {
      throw new Error(
        `Curated edge requires approvedInference: ${edge.source} -> ${edge.target}`,
      );
    }
    const graphifyConfidence =
      confidence === "EXTRACTED" ? "EXTRACTED" : "INFERRED";
    return {
      source: edge.source,
      target: edge.target,
      relation: edge.label,
      confidence: graphifyConfidence,
      confidence_score: graphifyConfidence === "EXTRACTED" ? 1 : 0.9,
      review_status:
        edge.approvedInference === true ? "HUMAN_APPROVED" : "EXTRACTED",
      source_file: "CURATION_EVIDENCE.json",
      source_location: `review:edges[${index}]`,
      weight: 1,
    };
  });

  const curatedGraph: GraphDocument & Record<string, unknown> = {
    directed: false,
    multigraph: false,
    graph: { title: review.title, view: "human-reviewed-curation" },
    nodes: curatedNodes,
    links: curatedEdges,
  };
  const initialShape = graphShape(curatedGraph);
  if (initialShape.components !== 1 || initialShape.isolated !== 0) {
    throw new Error(
      `Curated graph must be connected; components=${initialShape.components} isolated=${initialShape.isolated}`,
    );
  }

  const reviewChecksum = sha256(input.review);
  const output = join(
    String(status.output_path),
    "curated",
    reviewChecksum.slice(0, 12),
  );
  mkdirPrivate(output);
  const graph = join(output, "graph.json");
  const evidence = join(output, "CURATION_EVIDENCE.json");
  writeFileSync(graph, `${JSON.stringify(curatedGraph, null, 2)}\n`, {
    mode: 0o600,
  });
  writeFileSync(
    evidence,
    `${JSON.stringify(
      {
        title: review.title,
        rawGraphChecksum: status.graph_checksum,
        reviewChecksum,
        nodes: review.nodes.map(({ sourceId, id }) => ({ sourceId, id })),
        edges: review.edges,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const graphify = process.env.BOOSTIN_GRAPHIFY_BIN ?? "graphify";
  const cluster = spawnSync(
    graphify,
    ["cluster-only", output, "--graph", graph, "--no-label"],
    {
      encoding: "utf8",
      timeout: 15 * 60 * 1000,
    },
  );
  if (cluster.error || cluster.status !== 0) {
    const detail = (
      cluster.stderr ||
      cluster.stdout ||
      cluster.error?.message ||
      ""
    )
      .trim()
      .slice(0, 2000);
    throw new Error(
      `Graphify curated view generation failed${detail ? `: ${detail}` : ""}`,
    );
  }
  const graphifyOutput = existsSync(join(output, "graphify-out", "graph.json"))
    ? join(output, "graphify-out")
    : output;
  const generatedGraph = join(graphifyOutput, "graph.json");
  const html = join(graphifyOutput, "graph.html");
  const report = join(graphifyOutput, "GRAPH_REPORT.md");
  for (const required of [generatedGraph, html, report]) {
    if (!existsSync(required)) {
      throw new Error(
        `Graphify did not produce curated ${basename(required)}`,
      );
    }
  }
  assertGraphHealth(generatedGraph);
  const shape = graphShape(
    JSON.parse(readFileSync(generatedGraph, "utf8")) as GraphDocument,
  );
  if (shape.components !== 1 || shape.isolated !== 0) {
    throw new Error(
      `Graphify disconnected the curated graph; components=${shape.components} isolated=${shape.isolated}`,
    );
  }
  chmodTreePrivate(output);
  return { graph: generatedGraph, html, report, evidence, ...shape };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function readAllowlist(path: string): PublicAllowlist {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as PublicAllowlist;
  if (
    !parsed ||
    typeof parsed.title !== "string" ||
    !Array.isArray(parsed.nodes) ||
    !Array.isArray(parsed.edges) ||
    parsed.nodes.length < 2
  ) {
    throw new Error("Public graph allowlist is invalid");
  }
  return parsed;
}

function renderSvg(allowlist: PublicAllowlist): string {
  const width = 1400;
  const height = 420;
  const margin = 136;
  const usable = width - margin * 2;
  const step = usable / Math.max(1, allowlist.nodes.length - 1);
  const positions = new Map(
    allowlist.nodes.map((node, index) => [
      node.id,
      { x: margin + step * index, y: 220 },
    ]),
  );
  const edges = allowlist.edges
    .map((edge) => {
      const source = positions.get(edge.source)!;
      const target = positions.get(edge.target)!;
      return `
        <path d="M ${source.x + 112} ${source.y} L ${target.x - 112} ${target.y}" class="edge" marker-end="url(#arrow)" />`;
    })
    .join("");
  const nodes = allowlist.nodes
    .map((node) => {
      const point = positions.get(node.id)!;
      const words = node.label.split(/\s+/);
      const lines: string[] = [];
      for (const word of words) {
        const last = lines.at(-1);
        if (!last || `${last} ${word}`.length > 20) lines.push(word);
        else lines[lines.length - 1] = `${last} ${word}`;
      }
      const visibleLines = lines.slice(0, 3);
      const firstY = 50 - (visibleLines.length - 1) * 12;
      const label = visibleLines
        .map(
          (line, index) =>
            `<text x="112" y="${firstY + index * 24}" class="node-label" text-anchor="middle">${escapeXml(line)}</text>`,
        )
        .join("");
      return `
        <g transform="translate(${point.x - 112} ${point.y - 58})">
          <rect width="224" height="116" rx="24" class="node" />
          ${label}
          ${
            node.kind
              ? `<text x="112" y="89" class="node-kind" text-anchor="middle">${escapeXml(node.kind)}</text>`
              : ""
          }
        </g>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(allowlist.title)}</title>
  <desc id="description">A curated professional career graph with ${allowlist.nodes.length} stages connected from left to right.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#07121f" />
      <stop offset="1" stop-color="#112a3d" />
    </linearGradient>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L0,6 L9,3 z" fill="#73d2de" />
    </marker>
    <style>
      .node { fill: #102f45; stroke: #73d2de; stroke-width: 2; }
      .edge { fill: none; stroke: #73d2de; stroke-width: 3; }
      .node-label { fill: #f7fbff; font: 600 19px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .node-kind { fill: #a8c7d8; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    </style>
  </defs>
  <rect width="${width}" height="${height}" rx="32" fill="url(#background)" />
  <text x="${margin}" y="72" fill="#f7fbff" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="30" font-weight="700">${escapeXml(allowlist.title)}</text>
  <text x="${margin}" y="105" fill="#a8c7d8" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="16">A human-reviewed view of nine years of first-party LinkedIn data</text>
  ${edges}
  ${nodes}
</svg>
`;
}

function tryWebp(svg: string, out: string): string | null {
  const sips = process.env.BOOSTIN_SIPS_BIN ?? "/usr/bin/sips";
  const cwebp = process.env.BOOSTIN_CWEBP_BIN ?? "cwebp";
  const png = join(out, ".career-graph.png");
  const webp = join(out, "career-graph.webp");
  const raster = spawnSync(sips, ["-s", "format", "png", svg, "--out", png], {
    encoding: "utf8",
  });
  if (raster.status !== 0 || !existsSync(png)) return null;
  const converted = spawnSync(cwebp, ["-quiet", "-q", "90", png, "-o", webp], {
    encoding: "utf8",
  });
  unlinkSync(png);
  if (converted.status !== 0 || !existsSync(webp)) return null;
  chmodSync(webp, 0o644);
  return webp;
}

export function exportPublicGraph(input: {
  run: string;
  allowlist: string;
  out: string;
}): { svg: string; webp: string | null; manifest: string } {
  if (input.run !== "latest") {
    throw new Error("run currently supports only latest");
  }
  const status = graphStatus();
  if (status.status !== "completed") throw new Error("Latest graph run is not complete");
  const graphPath = join(String(status.output_path), "graphify-out", "graph.json");
  const graph = JSON.parse(readFileSync(graphPath, "utf8")) as GraphDocument;
  if (!Array.isArray(graph.nodes)) {
    throw new Error("Latest graph.json has an unsupported shape");
  }
  const edges = graphEdges(graph);
  const allowlist = readAllowlist(input.allowlist);
  const sourceByPublic = new Map(
    allowlist.nodes.map((node) => [node.id, node.sourceId]),
  );
  const graphNodeIds = new Set(graph.nodes.map((node) => node.id));
  const publicIds = new Set<string>();
  for (const node of allowlist.nodes) {
    if (!node.id || !node.label || !graphNodeIds.has(node.sourceId)) {
      throw new Error(`Allowlisted node is not present in the private graph: ${node.id}`);
    }
    if (publicIds.has(node.id)) throw new Error(`Duplicate public node id: ${node.id}`);
    publicIds.add(node.id);
  }
  const sanitizedEdges = allowlist.edges.map((edge) => {
    const sourceId = sourceByPublic.get(edge.source);
    const targetId = sourceByPublic.get(edge.target);
    if (!sourceId || !targetId) {
      throw new Error(`Public edge references an unknown node: ${edge.source} -> ${edge.target}`);
    }
    const privateEdge = edges.find(
      (candidate) =>
        (candidate.source === sourceId && candidate.target === targetId) ||
        (candidate.source === targetId && candidate.target === sourceId),
    );
    if (!privateEdge) {
      if (edge.approvedInference !== true) {
        throw new Error(
          `Public edge is not present in the private graph and requires approvedInference: ${edge.source} -> ${edge.target}`,
        );
      }
      return {
        source: edge.source,
        target: edge.target,
        label: edge.label,
        confidence: "HUMAN_APPROVED",
      };
    }
    const confidence = (privateEdge.confidence ?? "AMBIGUOUS").toUpperCase();
    if (confidence === "AMBIGUOUS") {
      throw new Error(`Ambiguous edges cannot be exported: ${edge.source} -> ${edge.target}`);
    }
    if (confidence === "INFERRED" && edge.approvedInference !== true) {
      throw new Error(`Inferred edge requires approvedInference: ${edge.source} -> ${edge.target}`);
    }
    return {
      source: edge.source,
      target: edge.target,
      label: edge.label,
      confidence,
    };
  });
  const sanitized = {
    title: allowlist.title,
    generatedAt: new Date().toISOString(),
    graphRunChecksum: status.graph_checksum,
    nodes: allowlist.nodes.map(({ id, label, kind }) => ({
      id,
      label,
      ...(kind ? { kind } : {}),
    })),
    edges: sanitizedEdges,
    notice:
      "Curated allowlist derived from a private graph. No source text, URLs, account identifiers, or private paths are included.",
  };
  mkdirSync(input.out, { recursive: true, mode: 0o755 });
  const svg = join(input.out, "career-graph.svg");
  const manifest = join(input.out, "career-graph.json");
  writeFileSync(svg, renderSvg(allowlist), { mode: 0o644 });
  writeFileSync(manifest, `${JSON.stringify(sanitized, null, 2)}\n`, {
    mode: 0o644,
  });
  chmodSync(svg, 0o644);
  chmodSync(manifest, 0o644);
  return { svg, webp: tryWebp(svg, input.out), manifest };
}
