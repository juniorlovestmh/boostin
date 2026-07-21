import { execFileSync } from "node:child_process";

export type FileVaultStatus = "On" | "Off" | "Unknown";

export function getFileVaultStatus(): FileVaultStatus {
  const override = process.env.BOOSTIN_FILEVAULT_STATUS;
  if (override === "On" || override === "Off" || override === "Unknown") {
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
