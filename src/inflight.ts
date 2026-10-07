import { readFileSync } from "node:fs";
import { PROVIDER_IDS } from "./types.js";
import type { InflightInputState, ProviderId, ProviderQuota } from "./types.js";

/**
 * Env var naming the in-flight worker file. `--inflight <file>` wins over it.
 * Absent, nothing is read and every reading is unchanged.
 */
export const INFLIGHT_ENV = "QUOTA_AXI_INFLIGHT";

export const INFLIGHT_SCHEMA_VERSION = 1;

/**
 * A file whose `updatedAt` is older than this is reported `stale`. It is still
 * folded in, because in-flight load can only lower a reading, so a writer that
 * stopped updating can never make a provider look healthier.
 */
export const INFLIGHT_STALE_SECONDS = 3_600;

/** An `updatedAt` further ahead of the clock than this is malformed. */
export const INFLIGHT_MAX_FUTURE_SKEW_SECONDS = 300;

/**
 * Per-worker burn assumed when quota-axi has not yet observed one for a
 * window: percentage points of the bounding window one live worker spends per
 * hour. Two points is the rate that drained a fresh Codex weekly window in
 * about three hours under fifteen concurrent coding workers (2026-10-07). An
 * entry's `percentPerWorkerHour` overrides it for that entry.
 */
export const INFLIGHT_DEFAULT_PERCENT_PER_WORKER_HOUR = 2;

const MAX_PERCENT_PER_WORKER_HOUR = 100;

export type InflightEntry = {
  provider: ProviderId;
  accountKey?: string;
  scope?: string;
  count: number;
  percentPerWorkerHour?: number;
};

export type InflightInput = {
  state: InflightInputState;
  /** Empty unless `state.status` is `applied` or `stale`. */
  entries: InflightEntry[];
};

/** The in-flight load drawing on one scope of one provider lane. */
export type ScopeWorkers = {
  workers: number;
  /** Assumed per-worker burn for a window with no observed one. */
  fallbackPercentPerWorkerHour: number;
};

/**
 * Read the in-flight file. A missing or unreadable file is `missing`, one that
 * does not parse as the documented format is `malformed`, and neither folds
 * anything in.
 */
export function readInflightInput(file: string, nowMs: number): InflightInput {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return rejected(
      "missing",
      code === "ENOENT" ? "file_not_found" : "file_read_error",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return rejected("malformed", "invalid_json");
  }
  return parseInflightInput(raw, nowMs);
}

/**
 * Validate the whole file or reject it: one bad entry rejects every entry, so
 * a writer bug is reported rather than half applied.
 */
export function parseInflightInput(raw: unknown, nowMs: number): InflightInput {
  const payload = objectValue(raw);
  if (!payload) return rejected("malformed", "not_an_object");
  if (payload.schemaVersion !== INFLIGHT_SCHEMA_VERSION) {
    return rejected("malformed", "unsupported_schema_version");
  }
  const updatedAt =
    typeof payload.updatedAt === "string" ? payload.updatedAt : undefined;
  const updatedAtMs = updatedAt === undefined ? NaN : Date.parse(updatedAt);
  if (updatedAt === undefined || !Number.isFinite(updatedAtMs)) {
    return rejected("malformed", "invalid_updated_at");
  }
  if (updatedAtMs - nowMs > INFLIGHT_MAX_FUTURE_SKEW_SECONDS * 1000) {
    return rejected("malformed", "updated_at_in_future", updatedAt);
  }
  if (!Array.isArray(payload.workers)) {
    return rejected("malformed", "invalid_workers", updatedAt);
  }
  const entries: InflightEntry[] = [];
  for (const [index, value] of payload.workers.entries()) {
    const entry = parseEntry(value);
    if (!entry) {
      return rejected("malformed", `invalid_worker_entry:${index}`, updatedAt);
    }
    entries.push(entry);
  }
  const stale = nowMs - updatedAtMs > INFLIGHT_STALE_SECONDS * 1000;
  return {
    state: { status: stale ? "stale" : "applied", updatedAt },
    entries,
  };
}

/**
 * The in-flight load on one scope of one provider lane. An entry without
 * `accountKey` covers every lane of its provider, and one without `scope`
 * covers every scope, so an unqualified count can only lower more readings,
 * never fewer. Undefined when no live worker draws on the scope.
 */
export function scopeWorkers(
  entries: readonly InflightEntry[],
  provider: ProviderQuota,
  scope: string,
): ScopeWorkers | undefined {
  let workers = 0;
  let fallback: number | undefined;
  for (const entry of entries) {
    if (entry.provider !== provider.provider || entry.count === 0) continue;
    if (entry.accountKey !== undefined && !coversAccount(provider, entry)) {
      continue;
    }
    if (entry.scope !== undefined && entry.scope !== scope) continue;
    workers += entry.count;
    // Several entries can name one scope; the heaviest assumption stands.
    const rate =
      entry.percentPerWorkerHour ?? INFLIGHT_DEFAULT_PERCENT_PER_WORKER_HOUR;
    fallback = fallback === undefined ? rate : Math.max(fallback, rate);
  }
  if (workers === 0 || fallback === undefined) return undefined;
  return { workers, fallbackPercentPerWorkerHour: fallback };
}

/** Every live worker the file names for a provider lane, across scopes. */
export function laneWorkerCount(
  entries: readonly InflightEntry[],
  provider: Pick<ProviderQuota, "provider" | "accountKey" | "accountKeys">,
): number {
  return entries
    .filter(
      (entry) =>
        entry.provider === provider.provider &&
        (entry.accountKey === undefined || coversAccount(provider, entry)),
    )
    .reduce((sum, entry) => sum + entry.count, 0);
}

function coversAccount(
  provider: Pick<ProviderQuota, "accountKey" | "accountKeys">,
  entry: InflightEntry,
): boolean {
  return (
    provider.accountKey === entry.accountKey ||
    (provider.accountKeys ?? []).includes(entry.accountKey as string)
  );
}

function parseEntry(value: unknown): InflightEntry | undefined {
  const entry = objectValue(value);
  if (!entry) return undefined;
  const provider = PROVIDER_IDS.find((id) => id === entry.provider);
  const count = entry.count;
  if (
    !provider ||
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    return undefined;
  }
  const parsed: InflightEntry = { provider, count };
  if (entry.accountKey !== undefined) {
    if (!nonBlankString(entry.accountKey)) return undefined;
    parsed.accountKey = entry.accountKey;
  }
  if (entry.scope !== undefined) {
    if (!nonBlankString(entry.scope)) return undefined;
    parsed.scope = entry.scope;
  }
  if (entry.percentPerWorkerHour !== undefined) {
    const rate = entry.percentPerWorkerHour;
    if (
      typeof rate !== "number" ||
      !Number.isFinite(rate) ||
      rate <= 0 ||
      rate > MAX_PERCENT_PER_WORKER_HOUR
    ) {
      return undefined;
    }
    parsed.percentPerWorkerHour = rate;
  }
  return parsed;
}

function rejected(
  status: "missing" | "malformed",
  error: string,
  updatedAt?: string,
): InflightInput {
  return {
    state: { status, error, ...(updatedAt ? { updatedAt } : {}) },
    entries: [],
  };
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
