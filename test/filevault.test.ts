import { afterEach, describe, expect, test } from "vitest";

import { getFileVaultStatus } from "../src/filevault.js";

describe("getFileVaultStatus", () => {
  const savedEnv = {
    BOOSTIN_FILEVAULT_STATUS: process.env.BOOSTIN_FILEVAULT_STATUS,
    VITEST: process.env.VITEST,
    NODE_ENV: process.env.NODE_ENV,
    CI: process.env.CI,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("ignores the override outside of test/CI mode", () => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    delete process.env.CI;
    delete process.env.BOOSTIN_FILEVAULT_STATUS;
    const systemStatus = getFileVaultStatus();
    process.env.BOOSTIN_FILEVAULT_STATUS = systemStatus === "On" ? "Off" : "On";

    expect(getFileVaultStatus()).toBe(systemStatus);
  });

  test("honors the override when running under Vitest", () => {
    process.env.VITEST = "true";
    delete process.env.NODE_ENV;
    delete process.env.CI;
    process.env.BOOSTIN_FILEVAULT_STATUS = "Off";

    expect(getFileVaultStatus()).toBe("Off");
  });
});
