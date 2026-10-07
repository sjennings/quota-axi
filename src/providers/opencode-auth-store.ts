import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { usableLiteralSecret } from "../lib/secret.js";

/**
 * The credential source name every read of opencode's auth store reports under,
 * regardless of which quota family's provider id answered.
 */
export const OPENCODE_AUTH_SOURCE = "opencode:auth.json";

const CREDENTIAL_KEYS = [
  "key",
  "apiKey",
  "api_key",
  "token",
  "accessToken",
  "auth_token",
];

export type OpencodeAuthCredentialResolution =
  | { status: "available"; key: string; path: string }
  | { status: "missing" | "invalid" | "error"; path: string; error?: string };

export type OpencodeAuthCredentialSource = {
  resolve(): OpencodeAuthCredentialResolution;
  inspect(): OpencodeAuthCredentialInspection;
};

export type OpencodeAuthCredentialInspection =
  | { status: "available"; path: string }
  | { status: "missing" | "invalid" | "error"; path: string; error?: string };

/**
 * opencode's own auth store: `$XDG_DATA_HOME/opencode/auth.json` when set,
 * otherwise `~/.local/share/opencode/auth.json` (`%LOCALAPPDATA%\opencode\auth.json`
 * on Windows). quota-axi only ever reads it.
 */
export function opencodeAuthFilePath(): string {
  const xdg = stringValue(process.env.XDG_DATA_HOME);
  if (xdg) return join(xdg, "opencode", "auth.json");
  if (process.platform === "win32") {
    const localAppData = stringValue(process.env.LOCALAPPDATA);
    if (localAppData) return join(localAppData, "opencode", "auth.json");
  }
  return join(homedir(), ".local", "share", "opencode", "auth.json");
}

/**
 * A per-provider id extraction over the shared store document: the first
 * declared provider id holding a usable literal key wins, and an entry that is
 * present but yields no usable key is treated as an absent credential, exactly
 * as Z.AI's opencode source has always read the same document.
 */
export function extractOpencodeAuthKey(
  value: unknown,
  providerIds: readonly string[],
  path: string,
): OpencodeAuthCredentialResolution {
  const data = objectValue(value);
  if (!data) return { status: "invalid", path, error: "json_parse_error" };
  for (const providerId of providerIds) {
    const entry = data[providerId];
    if (entry === undefined || entry === null) continue;
    const key = extractOpencodeEntryKey(entry);
    if (key) return { status: "available", key, path };
  }
  return { status: "missing", path };
}

/** A key from one entry: the first usable literal among the known keys, or a usable bare string. */
export function extractOpencodeEntryKey(entry: unknown): string | undefined {
  if (typeof entry === "string") return usableLiteralSecret(entry);
  const obj = objectValue(entry);
  if (!obj) return undefined;
  for (const key of CREDENTIAL_KEYS) {
    const value = usableLiteralSecret(obj[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function createOpencodeAuthCredentialSource(
  providerIds: readonly string[],
  filePath: () => string = opencodeAuthFilePath,
): OpencodeAuthCredentialSource {
  function resolve(): OpencodeAuthCredentialResolution {
    const path = filePath();
    const result = readJsonFileResult(path);
    if (result.status === "missing") return { status: "missing", path };
    if (result.status === "invalid")
      return result.error === "file_read_error"
        ? { status: "error", path, error: result.error }
        : { status: "invalid", path, error: result.error };
    return extractOpencodeAuthKey(result.value, providerIds, path);
  }
  return {
    resolve,
    inspect(): OpencodeAuthCredentialInspection {
      const resolution = resolve();
      if (resolution.status === "available")
        return { status: "available", path: resolution.path };
      return resolution;
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
