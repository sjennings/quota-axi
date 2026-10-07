import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIMO_OPENCODE_PROVIDER_IDS } from "../../src/providers/mimo.js";
import { MINIMAX_OPENCODE_PROVIDER_IDS } from "../../src/providers/minimax.js";
import {
  createOpencodeAuthCredentialSource,
  extractOpencodeAuthKey,
  extractOpencodeEntryKey,
  OPENCODE_AUTH_SOURCE,
  opencodeAuthFilePath,
} from "../../src/providers/opencode-auth-store.js";

const PATH = "/home/user/.local/share/opencode/auth.json";

/**
 * The two provider-id to quota-family mappings added on top of the opencode
 * auth-store reader, checked in the same table shape the Z.AI mapping has.
 */
describe("opencode auth store provider-id mappings", () => {
  it.each([
    ["mimo", MIMO_OPENCODE_PROVIDER_IDS, "xiaomi-token-plan-sgp"],
    ["minimax", MINIMAX_OPENCODE_PROVIDER_IDS, "minimax-coding-plan"],
  ])(
    "extracts %s from its opencode provider id",
    (_family, ids, providerId) => {
      const resolution = extractOpencodeAuthKey(
        { [providerId]: { type: "api", key: "literal-key" } },
        ids,
        PATH,
      );
      expect(resolution).toEqual({
        status: "available",
        key: "literal-key",
        path: PATH,
      });
    },
  );

  it("names one shared source regardless of the family that answered", () => {
    expect(OPENCODE_AUTH_SOURCE).toBe("opencode:auth.json");
  });
});

describe("opencode auth store key extraction", () => {
  const IDs = ["xiaomi-token-plan-sgp"];

  it.each([
    ["key", { key: "k" }],
    ["apiKey", { apiKey: "k" }],
    ["api_key", { api_key: "k" }],
    ["token", { token: "k" }],
    ["accessToken", { accessToken: "k" }],
    ["auth_token", { auth_token: "k" }],
  ])("reads a key from the %s property", (_label, entry) => {
    expect(
      extractOpencodeAuthKey({ "xiaomi-token-plan-sgp": entry }, IDs, PATH),
    ).toEqual({
      status: "available",
      key: "k",
      path: PATH,
    });
  });

  it("accepts a bare string entry", () => {
    expect(extractOpencodeEntryKey("literal-key")).toBe("literal-key");
  });

  it("prefers the first declared provider id that answers", () => {
    const resolution = extractOpencodeAuthKey(
      {
        "xiaomi-token-plan-cn": { key: "cn-key" },
        "xiaomi-token-plan-sgp": { key: "sgp-key" },
      },
      ["xiaomi-token-plan-sgp", "xiaomi-token-plan-cn"],
      PATH,
    );
    expect(resolution).toMatchObject({ key: "sgp-key" });
  });

  it("reports missing when no declared provider id is present", () => {
    expect(
      extractOpencodeAuthKey({ "zai-coding-plan": { key: "k" } }, IDs, PATH),
    ).toEqual({ status: "missing", path: PATH });
  });

  it("treats a present entry with no usable key as missing, per the Z.AI precedent", () => {
    expect(
      extractOpencodeAuthKey({ "xiaomi-token-plan-sgp": {} }, IDs, PATH),
    ).toEqual({ status: "missing", path: PATH });
  });

  it.each([
    ["a control byte", "line-one\nline-two"],
    ["an environment reference", "${MIMO_API_KEY}"],
    ["a command reference", "!op read op://mimo/key"],
    ["a blank value", "   "],
  ])("rejects a key holding %s", (_label, value) => {
    expect(
      extractOpencodeAuthKey(
        { "xiaomi-token-plan-sgp": { key: value } },
        IDs,
        PATH,
      ),
    ).toEqual({ status: "missing", path: PATH });
  });

  it("reports invalid for a non-object auth document", () => {
    expect(extractOpencodeAuthKey("not-an-object", IDs, PATH)).toEqual({
      status: "invalid",
      path: PATH,
      error: "json_parse_error",
    });
  });
});

describe("opencode auth store source", () => {
  function withDirectory<T>(run: (directory: string) => T): T {
    const directory = mkdtempSync(join(tmpdir(), "quota-axi-opencode-"));
    try {
      return run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  it("resolves the auth path from XDG_DATA_HOME", () => {
    const original = process.env.XDG_DATA_HOME;
    try {
      process.env.XDG_DATA_HOME = "/custom/xdg";
      expect(opencodeAuthFilePath()).toBe("/custom/xdg/opencode/auth.json");
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
    }
  });

  it("resolves a missing file to a missing source", () => {
    withDirectory((directory) => {
      const source = createOpencodeAuthCredentialSource(
        MIMO_OPENCODE_PROVIDER_IDS,
        () => join(directory, "auth.json"),
      );
      expect(source.resolve()).toEqual({
        status: "missing",
        path: join(directory, "auth.json"),
      });
    });
  });

  it("resolves an unreadable file to an error, not an invalid credential", () => {
    withDirectory((directory) => {
      const authFile = join(directory, "auth.json");
      mkdirSync(authFile);
      const source = createOpencodeAuthCredentialSource(
        MIMO_OPENCODE_PROVIDER_IDS,
        () => authFile,
      );
      expect(source.resolve()).toEqual({
        status: "error",
        path: authFile,
        error: "file_read_error",
      });
      expect(source.inspect()).toEqual({
        status: "error",
        path: authFile,
        error: "file_read_error",
      });
    });
  });

  it("resolves a malformed file to an invalid credential", () => {
    withDirectory((directory) => {
      const authFile = join(directory, "auth.json");
      writeFileSync(authFile, "{broken");
      const source = createOpencodeAuthCredentialSource(
        MINIMAX_OPENCODE_PROVIDER_IDS,
        () => authFile,
      );
      expect(source.resolve()).toEqual({
        status: "invalid",
        path: authFile,
        error: "json_parse_error",
      });
    });
  });

  it("inspects an available entry without exposing its key", () => {
    withDirectory((directory) => {
      const authFile = join(directory, "auth.json");
      writeFileSync(
        authFile,
        JSON.stringify({
          "minimax-coding-plan": { type: "api", key: "synthetic-key" },
        }),
        { mode: 0o600 },
      );
      const source = createOpencodeAuthCredentialSource(
        MINIMAX_OPENCODE_PROVIDER_IDS,
        () => authFile,
      );
      expect(source.inspect()).toEqual({
        status: "available",
        path: authFile,
      });
      expect(JSON.stringify(source.inspect())).not.toContain("synthetic-key");
    });
  });
});
