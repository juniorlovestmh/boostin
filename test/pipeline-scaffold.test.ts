import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const pipelineEnvKeys = [
  "BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV",
  "BOOSTIN_CODESSD_ROOT",
  "BOOSTIN_DAGSTER_HOME",
  "BOOSTIN_HOME",
  "BOOSTIN_PIPELINE_TEST_RESULT",
  "BOOSTIN_PIPELINE_VENV",
  "BOOSTIN_UV_CACHE_DIR",
] as const;

const cleanPipelineEnv = (
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of pipelineEnvKeys) {
    delete env[key];
  }
  return { ...env, ...overrides };
};

describe("Dagster pipeline", () => {
  it("provisions the pinned Python toolchain in CI and runs its gate", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "verify.yml"),
      "utf8",
    );

    expect(packageJson.scripts["pipeline:validate"]).toBe(
      "pnpm pipeline:check && pnpm pipeline:test",
    );
    expect(packageJson.scripts.validate).toContain("pnpm pipeline:validate");
    expect(workflow).toContain("astral-sh/setup-uv@");
    expect(workflow).toContain('version: "0.11.31"');
    expect(workflow).toContain("uv python install 3.13");
    expect(workflow).toContain('BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV: "1"');
    expect(workflow).toContain('"$GITHUB_ENV"');
    expect(workflow).toContain('"$RUNNER_TEMP"');
    expect(workflow).not.toContain("${{ runner.temp }}");
  });

  it("exposes materialization now that promotion checks exist", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts["pipeline:materialize"]).toBe(
      "sh pipeline/scripts/dagster.sh materialize",
    );
  });

  it("shares the uv cache and isolates the environment by checkout", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "boostin-pipeline-lock-"));
    const binDir = join(testRoot, "bin");
    const codeSsdRoot = join(testRoot, "codessd");
    const resultFile = join(testRoot, "result");

    try {
      mkdirSync(binDir);
      mkdirSync(codeSsdRoot);
      const fakeUv = join(binDir, "uv");
      writeFileSync(
        fakeUv,
        `#!/bin/sh
set -eu
printf '%s\\n%s\\n' "$UV_CACHE_DIR" "$UV_PROJECT_ENVIRONMENT" > "$BOOSTIN_PIPELINE_TEST_RESULT"
`,
      );
      chmodSync(fakeUv, 0o755);

      execFileSync("pnpm", ["pipeline:check"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: cleanPipelineEnv({
          BOOSTIN_CODESSD_ROOT: codeSsdRoot,
          BOOSTIN_PIPELINE_TEST_RESULT: resultFile,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        }),
      });

      const checkoutChecksum = createHash("sha256")
        .update(join(process.cwd(), "pipeline"))
        .digest("hex");
      expect(readFileSync(resultFile, "utf8").trim().split("\n")).toEqual([
        join(codeSsdRoot, "uv-cache"),
        join(codeSsdRoot, "boostin-pipeline-envs", checkoutChecksum),
      ]);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("refuses a main-SSD environment unless the fallback is explicit", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "boostin-pipeline-storage-"));

    try {
      expect(() =>
        execFileSync("pnpm", ["pipeline:check"], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cleanPipelineEnv({
            BOOSTIN_CODESSD_ROOT: join(testRoot, "missing-volume"),
            BOOSTIN_HOME: join(testRoot, "boostin-home"),
          }),
          stdio: "pipe",
        }),
      ).toThrow(/BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV=1/);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("uses explicit fallback state outside the checkout", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "boostin-pipeline-fallback-"));
    const binDir = join(testRoot, "bin");
    const boostinHome = join(testRoot, "boostin-home");
    const resultFile = join(testRoot, "result");

    try {
      mkdirSync(binDir);
      const fakeUv = join(binDir, "uv");
      writeFileSync(
        fakeUv,
        `#!/bin/sh
set -eu
printf '%s\\n%s\\n' "$UV_CACHE_DIR" "$UV_PROJECT_ENVIRONMENT" > "$BOOSTIN_PIPELINE_TEST_RESULT"
`,
      );
      chmodSync(fakeUv, 0o755);

      execFileSync("pnpm", ["pipeline:check"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: cleanPipelineEnv({
          BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV: "1",
          BOOSTIN_CODESSD_ROOT: join(testRoot, "missing-volume"),
          BOOSTIN_HOME: boostinHome,
          BOOSTIN_PIPELINE_TEST_RESULT: resultFile,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        }),
      });

      const checkoutChecksum = createHash("sha256")
        .update(join(process.cwd(), "pipeline"))
        .digest("hex");
      expect(readFileSync(resultFile, "utf8").trim().split("\n")).toEqual([
        join(boostinHome, "pipeline", "runtime", "uv-cache"),
        join(
          boostinHome,
          "pipeline",
          "runtime",
          "environments",
          checkoutChecksum,
        ),
      ]);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("isolates check and test state and restricts child-created state", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "boostin-pipeline-check-"));
    const binDir = join(testRoot, "bin");
    const realBoostinHome = join(testRoot, "real-boostin-home");
    const resultFile = join(testRoot, "result");

    try {
      execFileSync("mkdir", ["-p", binDir]);
      const fakeUv = join(binDir, "uv");
      writeFileSync(
        fakeUv,
        `#!/bin/sh
set -eu
home_mode="$(stat -f '%Lp' "$DAGSTER_HOME" 2>/dev/null || stat -c '%a' "$DAGSTER_HOME")"
config_mode="$(stat -f '%Lp' "$DAGSTER_HOME/dagster.yaml" 2>/dev/null || stat -c '%a' "$DAGSTER_HOME/dagster.yaml")"
: > "$DAGSTER_HOME/child-state"
child_mode="$(stat -f '%Lp' "$DAGSTER_HOME/child-state" 2>/dev/null || stat -c '%a' "$DAGSTER_HOME/child-state")"
printf '%s|%s %s %s\\n' "$DAGSTER_HOME" "$home_mode" "$config_mode" "$child_mode" >> "$BOOSTIN_PIPELINE_TEST_RESULT"
`,
      );
      chmodSync(fakeUv, 0o755);

      for (const script of ["pipeline:check", "pipeline:test"]) {
        execFileSync("pnpm", [script], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cleanPipelineEnv({
            BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV: "1",
            BOOSTIN_HOME: realBoostinHome,
            BOOSTIN_PIPELINE_TEST_RESULT: resultFile,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
          }),
        });
      }

      const results = readFileSync(resultFile, "utf8").trim().split("\n");
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.split("|")[1])).toEqual([
        "700 600 600",
        "700 600 600",
      ]);
      expect(results[0]?.split("|")[0]).not.toBe(results[1]?.split("|")[0]);
      expect(() => readFileSync(join(realBoostinHome, "pipeline", "dagster", "dagster.yaml"))).toThrow();
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("normalizes an existing Dagster home and refuses symlinks", () => {
    const testRoot = mkdtempSync(join(tmpdir(), "boostin-pipeline-home-"));
    const binDir = join(testRoot, "bin");
    const dagsterHome = join(testRoot, "dagster");
    const oldDir = join(dagsterHome, "history");
    const oldFile = join(oldDir, "run.db");

    try {
      mkdirSync(binDir);
      mkdirSync(oldDir, { recursive: true, mode: 0o755 });
      writeFileSync(oldFile, "private state", { mode: 0o644 });
      chmodSync(dagsterHome, 0o755);
      chmodSync(oldDir, 0o755);
      chmodSync(oldFile, 0o644);
      const fakeUv = join(binDir, "uv");
      writeFileSync(fakeUv, "#!/bin/sh\nset -eu\n");
      chmodSync(fakeUv, 0o755);

      execFileSync("pnpm", ["pipeline:dev"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: cleanPipelineEnv({
          BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV: "1",
          BOOSTIN_DAGSTER_HOME: dagsterHome,
          BOOSTIN_HOME: join(testRoot, "boostin-home"),
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
        }),
      });

      const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
      expect(mode(dagsterHome)).toBe("700");
      expect(mode(oldDir)).toBe("700");
      expect(mode(oldFile)).toBe("600");
      expect(mode(join(dagsterHome, "dagster.yaml"))).toBe("600");

      const linkedHome = join(testRoot, "linked-dagster");
      symlinkSync(dagsterHome, linkedHome);
      expect(() =>
        execFileSync("pnpm", ["pipeline:dev"], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cleanPipelineEnv({
            BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV: "1",
            BOOSTIN_DAGSTER_HOME: linkedHome,
            BOOSTIN_HOME: join(testRoot, "boostin-home"),
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
          }),
          stdio: "pipe",
        }),
      ).toThrow(/refusing symbolic link/);
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it(
    "loads the public asset definitions through the package entrypoint",
    () => {
      const testRoot = mkdtempSync(join(tmpdir(), "boostin-pipeline-ci-"));
      try {
        const output = execFileSync("pnpm", ["pipeline:check"], {
          cwd: process.cwd(),
          encoding: "utf8",
          env: cleanPipelineEnv({
            BOOSTIN_ALLOW_MAIN_SSD_PIPELINE_ENV: "1",
            BOOSTIN_CODESSD_ROOT: join(testRoot, "missing-volume"),
            BOOSTIN_PIPELINE_VENV:
              process.env.BOOSTIN_PIPELINE_VENV ?? join(testRoot, "venv"),
            BOOSTIN_UV_CACHE_DIR:
              process.env.BOOSTIN_UV_CACHE_DIR ?? join(testRoot, "cache"),
            NO_COLOR: "1",
          }),
        });

        expect(output).toContain("Boostin pipeline definitions are valid");
      } finally {
        rmSync(testRoot, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
