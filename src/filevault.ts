import { execFileSync } from "node:child_process";

export type FileVaultStatus = "On" | "Off" | "Unknown";

function isTestModeActive(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.CI === "true"
  );
}

export function getFileVaultStatus(): FileVaultStatus {
  const override = process.env.BOOSTIN_FILEVAULT_STATUS;
  if (
    isTestModeActive() &&
    (override === "On" || override === "Off" || override === "Unknown")
  ) {
    return override;
  }

  if (process.platform !== "darwin") return "Unknown";

  try {
    const output = execFileSync("/usr/bin/fdesetup", ["status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (/FileVault is On/i.test(output)) return "On";
    if (/FileVault is Off/i.test(output)) return "Off";
    return "Unknown";
  } catch {
    return "Unknown";
  }
}

export function requireFileVaultForRealImport(): void {
  if (getFileVaultStatus() !== "On") {
    throw new Error(
      "FileVault must be enabled before importing real data. Run boostin doctor for details.",
    );
  }
}
