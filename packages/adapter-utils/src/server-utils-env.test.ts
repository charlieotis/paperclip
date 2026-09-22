import { afterEach, describe, expect, it, vi } from "vitest";
import { runChildProcess, sanitizeInheritedPaperclipEnv } from "./server-utils.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });
});

describe("deployed agent secret filtering", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not pass server database or auth secrets to a CLI child", async () => {
    vi.stubEnv("DATABASE_URL", "synthetic-server-database-secret");
    vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-server-auth-secret");
    const result = await runChildProcess(
      "maintenance-secret-filter-test", process.execPath,
      ["-e", "process.stdout.write(JSON.stringify({db: process.env.DATABASE_URL ?? null, auth: process.env.BETTER_AUTH_SECRET ?? null, marker: process.env.TEST_AGENT_MARKER}))"],
      { cwd: process.cwd(), env: { TEST_AGENT_MARKER: "explicit-agent-value" },
        timeoutSec: 5, graceSec: 1, onLog: async () => {} },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ db: null, auth: null, marker: "explicit-agent-value" });
  });
});
