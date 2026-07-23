import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createZip } from "./helpers/archive.js";

function run(
  home: string,
  args: string[],
  env: Record<string, string> = {},
): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "src/cli.ts", ...args],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BOOSTIN_HOME: home,
        BOOSTIN_FILEVAULT_STATUS: "On",
        ...env,
      },
      encoding: "utf8",
    },
  );
}

describe("professional graph", () => {
  test("builds privately and exports only an explicit public allowlist", async () => {
    const root = mkdtempSync(join(tmpdir(), "boostin-graph-"));
    const home = join(root, "home");
    const archive = join(root, "linkedin.zip");
    const publicSource = join(root, "public-project.md");
    const bin = join(root, "bin");
    const fakeGraphify = join(bin, "graphify");
    const fakeOllama = join(bin, "ollama");
    mkdirSync(bin);
    await createZip(archive, {
      "Profile.csv":
        "First Name,Last Name,Public Profile URL\nSynthetic,User,https://social.example/profiles/synthetic-user\n",
      "Shares.csv":
        "Date,ShareLink,ShareCommentary,Visibility\n2026-07-20 10:00:00,https://social.example/posts/1,Private source sentence about accessible revenue systems.,PUBLIC\n",
    });
    writeFileSync(
      publicSource,
      "# Public project\n\nA public project connects revenue operations to agent systems.\n",
      { mode: 0o600 },
    );
    writeFileSync(
      fakeOllama,
      "#!/bin/sh\nif [ \"$1\" = \"show\" ]; then exit 0; fi\nexit 0\n",
      { mode: 0o700 },
    );
    writeFileSync(
      fakeGraphify,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "graphify 0.8.test"; exit 0; fi
command="$1"
out=""
graph=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--out" ]; then shift; out="$1"; fi
  if [ "$1" = "--graph" ]; then shift; graph="$1"; fi
  shift
done
if [ "$command" = "cluster-only" ]; then
  out="$(dirname "$graph")"
  printf '%s\n' '# Synthetic graph report' > "$out/GRAPH_REPORT.md"
  printf '%s\n' '<!doctype html><title>Synthetic graph</title>' > "$out/graph.html"
  exit 0
fi
mkdir -p "$out/graphify-out"
printf '%s' '{"nodes":[{"id":"access","label":"Accessibility","confidence":"EXTRACTED"},{"id":"revops","label":"Revenue Operations","confidence":"EXTRACTED"},{"id":"enablement","label":"AI Enablement","confidence":"INFERRED"},{"id":"agents","label":"Agent Systems","confidence":"INFERRED"}],"links":[{"source":"access","target":"revops","relation":"enabled","confidence":"EXTRACTED"},{"source":"revops","target":"agents","relation":"evolved_into","confidence":"INFERRED"}]}' > "$out/graphify-out/graph.json"
`,
      { mode: 0o700 },
    );
    chmodSync(fakeGraphify, 0o700);
    chmodSync(fakeOllama, 0o700);
    run(home, ["import", "posts", archive, "--json"]);

    expect(() =>
      run(
        home,
        ["graph", "build", "--corpus", "professional", "--json"],
        {
          BOOSTIN_GRAPHIFY_BIN: fakeGraphify,
          BOOSTIN_OLLAMA_BIN: fakeOllama,
          OLLAMA_BASE_URL: "https://remote.example/v1",
        },
      ),
    ).toThrow(/require OLLAMA_BASE_URL to use HTTP loopback/);

    const built = JSON.parse(
      run(
        home,
        [
          "graph",
          "build",
          "--corpus",
          "professional",
          "--source",
          publicSource,
          "--json",
        ],
        {
          BOOSTIN_GRAPHIFY_BIN: fakeGraphify,
          BOOSTIN_OLLAMA_BIN: fakeOllama,
        },
      ),
    ) as { id: string; status: string; output: string };
    expect(built.status).toBe("completed");
    expect(statSync(built.output).mode & 0o777).toBe(0o700);
    expect(statSync(join(built.output, "graphify-out", "graph.json")).mode & 0o777).toBe(
      0o600,
    );

    const status = JSON.parse(
      run(home, ["graph", "status", "--json"]),
    ) as { id: string; status: string; model: string };
    expect(status).toMatchObject({
      id: built.id,
      status: "completed",
      model: "boostin-graphify:latest",
    });

    const allowlist = join(root, "allowlist.json");
    const curatedReview = join(root, "curated-review.json");
    const publicOut = join(root, "public");
    writeFileSync(
      curatedReview,
      JSON.stringify({
        title: "A connected professional graph",
        nodes: [
          { sourceId: "access", id: "accessibility", label: "Accessibility", kind: "practice" },
          { sourceId: "revops", id: "revenue-operations", label: "Revenue operations", kind: "career-stage" },
          { sourceId: "enablement", id: "ai-enablement", label: "AI enablement", kind: "practice" },
          { sourceId: "agents", id: "agent-systems", label: "Agent systems", kind: "practice" },
        ],
        edges: [
          {
            source: "accessibility",
            target: "revenue-operations",
            label: "informed",
          },
          {
            source: "revenue-operations",
            target: "ai-enablement",
            label: "expanded into",
            approvedInference: true,
          },
          {
            source: "ai-enablement",
            target: "agent-systems",
            label: "became infrastructure",
            approvedInference: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const curated = JSON.parse(
      run(
        home,
        [
          "graph",
          "curate",
          "--run",
          "latest",
          "--review",
          curatedReview,
          "--json",
        ],
        { BOOSTIN_GRAPHIFY_BIN: fakeGraphify },
      ),
    ) as {
      graph: string;
      html: string;
      report: string;
      nodes: number;
      edges: number;
      components: number;
      isolated: number;
    };
    expect(curated).toMatchObject({
      nodes: 4,
      edges: 3,
      components: 1,
      isolated: 0,
    });
    expect(readFileSync(curated.graph, "utf8")).not.toContain("Human Readable Name");
    expect(readFileSync(curated.html, "utf8")).toContain("Synthetic graph");
    expect(statSync(join(built.output, "curated")).mode & 0o777).toBe(0o700);
    expect(statSync(curated.graph).mode & 0o777).toBe(0o600);

    const disconnectedReview = join(root, "disconnected-review.json");
    writeFileSync(
      disconnectedReview,
      JSON.stringify({
        title: "Disconnected graph",
        nodes: [
          { sourceId: "access", id: "accessibility", label: "Accessibility" },
          { sourceId: "revops", id: "revenue-operations", label: "Revenue operations" },
          { sourceId: "agents", id: "agent-systems", label: "Agent systems" },
        ],
        edges: [
          {
            source: "accessibility",
            target: "revenue-operations",
            label: "informed",
          },
        ],
      }),
      { mode: 0o600 },
    );
    expect(() =>
      run(
        home,
        [
          "graph",
          "curate",
          "--run",
          "latest",
          "--review",
          disconnectedReview,
          "--json",
        ],
        { BOOSTIN_GRAPHIFY_BIN: fakeGraphify },
      ),
    ).toThrow(/must be connected/);

    writeFileSync(
      allowlist,
      JSON.stringify({
        title: "A professional through-line",
        nodes: [
          { sourceId: "access", id: "accessibility", label: "Accessibility" },
          { sourceId: "revops", id: "revenue-operations", label: "Revenue operations" },
          { sourceId: "enablement", id: "ai-enablement", label: "AI enablement" },
          { sourceId: "agents", id: "agent-systems", label: "Agent systems" },
        ],
        edges: [
          {
            source: "accessibility",
            target: "revenue-operations",
            label: "informed",
          },
          {
            source: "revenue-operations",
            target: "ai-enablement",
            label: "expanded into",
            approvedInference: true,
          },
          {
            source: "ai-enablement",
            target: "agent-systems",
            label: "evolved into",
            approvedInference: true,
          },
        ],
      }),
      { mode: 0o600 },
    );
    const exported = JSON.parse(
      run(home, [
        "graph",
        "export-public",
        "--run",
        "latest",
        "--allowlist",
        allowlist,
        "--out",
        publicOut,
        "--json",
      ]),
    ) as { svg: string; manifest: string };
    const svg = readFileSync(exported.svg, "utf8");
    const manifest = readFileSync(exported.manifest, "utf8");
    expect(svg).toContain("Revenue operations");
    expect(svg).not.toContain("Private source sentence");
    expect(manifest).not.toContain("social.example");
    expect(statSync(exported.svg).mode & 0o777).toBe(0o644);
  });
});
