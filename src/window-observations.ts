import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { withLockSync } from "./lib/fetch-lock.js";
import {
  ensurePrivateParent,
  readUntracedJsonFile,
  windowObservationLedgerPath,
} from "./lib/fs.js";
import { LONG_WINDOW_MIN_CYCLE_SECONDS } from "./pace.js";
import type { ProviderQuota, QuotaWindow } from "./types.js";

/**
 * quota-axi's memory of its own earlier readings, per provider lane and
 * window: the last remaining percentage and scheduled reset it saw, any
 * vendor reset it observed ahead of that schedule, and the per-worker burn it
 * measured while in-flight workers were live. Holds only non-secret figures
 * and timestamps keyed by provider, account key, and window id.
 */
export type WindowObservation = {
  observedAt: number;
  percentRemaining: number;
  percentUsed: number;
  /** The vendor's scheduled reset at `observedAt`. */
  resetsAt: number;
  /** An observed vendor reset ahead of `resetsAt`, on this same schedule. */
  restartedAt?: number;
  /** Start of the interval the next per-worker burn is measured over. */
  anchor?: { at: number; percentUsed: number; workers: number };
  /** Last measured burn of one live worker, in points of the window per hour. */
  percentPerWorkerHour?: number;
};

export type WindowObservationLedger = Map<string, WindowObservation>;

const LEDGER_SCHEMA_VERSION = 1;

/** A long window reading at least this much left after a jump is a reset. */
export const VENDOR_RESET_MIN_REMAINING_PERCENT = 99;

/** The smallest jump in remaining that reads as a vendor reset. */
export const VENDOR_RESET_MIN_JUMP_PERCENT_POINTS = 10;

/**
 * Two readings whose resets are this close share a schedule. Vendors that
 * compute a reset from a relative countdown at response time jitter by
 * seconds, never by minutes.
 */
export const RESET_SCHEDULE_TOLERANCE_SECONDS = 300;

/**
 * A per-worker burn is measured only over an interval at least this long, so
 * whole-percent vendor rounding does not dominate it, and at most the maximum
 * below, so it describes recent burn rather than the cycle average.
 */
export const OBSERVED_BURN_MIN_INTERVAL_SECONDS = 1_800;
export const OBSERVED_BURN_MAX_INTERVAL_SECONDS = 12 * 3_600;

/** Observations older than this are pruned; it covers a monthly cycle. */
const RETENTION_MS = 35 * 86_400_000;

/**
 * Compare each fresh lane's windows with the last observation, stamp
 * `observedResetAt` on a long window the vendor reset ahead of its schedule,
 * and return the updated ledger. Stale and reused readings are not new
 * observations: they only keep a restart already on record for their
 * schedule. No reset is ever predicted; one is recognized only after the
 * vendor reports it.
 *
 * @param workersFor live in-flight workers the input names for a lane
 */
export function observeWindows(
  previous: WindowObservationLedger,
  readings: ProviderQuota[],
  generatedAt: string,
  workersFor: (reading: ProviderQuota) => number,
): { readings: ProviderQuota[]; ledger: WindowObservationLedger } {
  const nowMs = Date.parse(generatedAt);
  const ledger: WindowObservationLedger = new Map(
    [...previous].filter(
      ([, entry]) => nowMs - entry.observedAt < RETENTION_MS,
    ),
  );
  if (!Number.isFinite(nowMs)) return { readings, ledger };
  const observed = readings.map((reading) => {
    const newObservation =
      !reading.state.stale &&
      reading.state.status === "fresh" &&
      !reading.state.reused;
    const workers = workersFor(reading);
    return {
      ...reading,
      windows: reading.windows.map((window) => {
        const key = observationKey(reading, window.id);
        const sample = windowSample(window);
        if (!sample) return window;
        const prior = ledger.get(key);
        const next = newObservation
          ? observeWindow(prior, sample, nowMs, workers)
          : prior;
        if (newObservation && next) ledger.set(key, next);
        const restartedAt =
          next && sameSchedule(next.resetsAt, sample.resetsAt)
            ? next.restartedAt
            : undefined;
        return restartedAt === undefined
          ? window
          : { ...window, observedResetAt: new Date(restartedAt).toISOString() };
      }),
    };
  });
  return { readings: observed, ledger };
}

/** The per-worker burn measured for each window of a lane, when one exists. */
export function observedBurnRates(
  ledger: WindowObservationLedger,
  reading: ProviderQuota,
): Map<string, number> {
  const rates = new Map<string, number>();
  for (const window of reading.windows) {
    const rate = ledger.get(
      observationKey(reading, window.id),
    )?.percentPerWorkerHour;
    if (rate !== undefined && rate > 0) rates.set(window.id, rate);
  }
  return rates;
}

type WindowSample = {
  percentRemaining: number;
  percentUsed: number;
  resetsAt: number;
  cycleSeconds?: number;
};

function windowSample(window: QuotaWindow): WindowSample | undefined {
  if (window.shareOf !== undefined) return undefined;
  const percentRemaining = window.percentRemaining;
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : NaN;
  if (
    typeof percentRemaining !== "number" ||
    !Number.isFinite(percentRemaining) ||
    !Number.isFinite(resetsAt)
  ) {
    return undefined;
  }
  const percentUsed =
    typeof window.percentUsed === "number" &&
    Number.isFinite(window.percentUsed)
      ? window.percentUsed
      : 100 - percentRemaining;
  const startsAt = window.startsAt ? Date.parse(window.startsAt) : NaN;
  const cycleSeconds =
    window.windowSeconds ??
    (Number.isFinite(startsAt) ? (resetsAt - startsAt) / 1000 : undefined);
  return {
    percentRemaining,
    percentUsed,
    resetsAt,
    ...(cycleSeconds !== undefined && Number.isFinite(cycleSeconds)
      ? { cycleSeconds }
      : {}),
  };
}

function observeWindow(
  prior: WindowObservation | undefined,
  sample: WindowSample,
  nowMs: number,
  workers: number,
): WindowObservation {
  const onSchedule =
    prior !== undefined &&
    prior.observedAt < nowMs &&
    sameSchedule(prior.resetsAt, sample.resetsAt);
  let restartedAt = onSchedule ? prior.restartedAt : undefined;
  if (
    restartedAt !== undefined &&
    sample.cycleSeconds !== undefined &&
    restartedAt + sample.cycleSeconds * 1000 <= nowMs
  ) {
    restartedAt = undefined;
  }
  const vendorReset =
    onSchedule &&
    sample.resetsAt > nowMs &&
    sample.cycleSeconds !== undefined &&
    sample.cycleSeconds >= LONG_WINDOW_MIN_CYCLE_SECONDS &&
    sample.percentRemaining >= VENDOR_RESET_MIN_REMAINING_PERCENT &&
    sample.percentRemaining - prior.percentRemaining >=
      VENDOR_RESET_MIN_JUMP_PERCENT_POINTS;
  // The reset happened at some point since the last reading. Taking the
  // moment it was seen gives the least elapsed time, which never reads
  // healthier than any earlier instant would.
  if (vendorReset) restartedAt = nowMs;

  const fresh = { at: nowMs, percentUsed: sample.percentUsed, workers };
  let anchor = fresh;
  let percentPerWorkerHour = prior?.percentPerWorkerHour;
  const priorAnchor = prior?.anchor;
  if (onSchedule && !vendorReset && priorAnchor?.workers === workers) {
    const intervalSeconds = (nowMs - priorAnchor.at) / 1000;
    if (intervalSeconds < OBSERVED_BURN_MIN_INTERVAL_SECONDS) {
      anchor = priorAnchor;
    } else if (
      intervalSeconds <= OBSERVED_BURN_MAX_INTERVAL_SECONDS &&
      workers > 0
    ) {
      const rate =
        (sample.percentUsed - priorAnchor.percentUsed) /
        (intervalSeconds / 3600) /
        workers;
      // A window that did not move in the interval gives no estimate rather
      // than a zero one: whole-percent rounding can hide a real burn.
      if (rate > 0 && Number.isFinite(rate)) percentPerWorkerHour = rate;
    }
  }

  return {
    observedAt: nowMs,
    percentRemaining: sample.percentRemaining,
    percentUsed: sample.percentUsed,
    resetsAt: sample.resetsAt,
    ...(restartedAt !== undefined ? { restartedAt } : {}),
    anchor,
    ...(percentPerWorkerHour !== undefined ? { percentPerWorkerHour } : {}),
  };
}

function sameSchedule(left: number, right: number): boolean {
  return Math.abs(left - right) <= RESET_SCHEDULE_TOLERANCE_SECONDS * 1000;
}

function observationKey(reading: ProviderQuota, windowId: string): string {
  return JSON.stringify([
    reading.provider,
    reading.accountKey ?? "default",
    windowId,
  ]);
}

/**
 * Read, update, and write the ledger file in one locked step. Best effort: a
 * ledger that cannot be read starts empty and one that cannot be written is
 * dropped, which only forgets earlier observations; it never invents one.
 */
export function updateWindowObservationLedger<T>(
  update: (ledger: WindowObservationLedger) => {
    ledger: WindowObservationLedger;
    result: T;
  },
  file: string = windowObservationLedgerPath(),
): T {
  // A report that observes nothing new writes nothing, so a read that reached
  // no vendor never creates the cache directory.
  const current = readLedger(file);
  const unlocked = update(current);
  if (serializeLedger(unlocked.ledger) === serializeLedger(current)) {
    return unlocked.result;
  }
  return withLockSync(`${file}.lock`, () => {
    const { ledger, result } = update(readLedger(file));
    try {
      writeLedger(file, ledger);
    } catch {
      // Forgetting an observation is safe; failing the report is not.
    }
    return result;
  });
}

function readLedger(file: string): WindowObservationLedger {
  const ledger: WindowObservationLedger = new Map();
  const payload = objectValue(readUntracedJsonFile(file));
  if (!payload || payload.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    return ledger;
  }
  const entries = objectValue(payload.windows);
  if (!entries) return ledger;
  for (const [key, raw] of Object.entries(entries)) {
    const entry = parseObservation(raw);
    if (entry) ledger.set(key, entry);
  }
  return ledger;
}

function parseObservation(raw: unknown): WindowObservation | undefined {
  const entry = objectValue(raw);
  if (!entry) return undefined;
  const observedAt = timestamp(entry.observedAt);
  const resetsAt = timestamp(entry.resetsAt);
  const percentRemaining = finite(entry.percentRemaining);
  const percentUsed = finite(entry.percentUsed);
  if (
    observedAt === undefined ||
    resetsAt === undefined ||
    percentRemaining === undefined ||
    percentUsed === undefined
  ) {
    return undefined;
  }
  const restartedAt = timestamp(entry.restartedAt);
  const anchorRaw = objectValue(entry.anchor);
  const anchorAt = timestamp(anchorRaw?.at);
  const anchorUsed = finite(anchorRaw?.percentUsed);
  const anchorWorkers = finite(anchorRaw?.workers);
  const rate = finite(entry.percentPerWorkerHour);
  return {
    observedAt,
    percentRemaining,
    percentUsed,
    resetsAt,
    ...(restartedAt !== undefined ? { restartedAt } : {}),
    ...(anchorAt !== undefined &&
    anchorUsed !== undefined &&
    anchorWorkers !== undefined
      ? {
          anchor: {
            at: anchorAt,
            percentUsed: anchorUsed,
            workers: anchorWorkers,
          },
        }
      : {}),
    ...(rate !== undefined && rate > 0 ? { percentPerWorkerHour: rate } : {}),
  };
}

function writeLedger(file: string, ledger: WindowObservationLedger): void {
  ensurePrivateParent(file);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, serializeLedger(ledger), { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

function serializeLedger(ledger: WindowObservationLedger): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  const windows = Object.fromEntries(
    [...ledger].map(([key, entry]) => [
      key,
      {
        observedAt: iso(entry.observedAt),
        percentRemaining: entry.percentRemaining,
        percentUsed: entry.percentUsed,
        resetsAt: iso(entry.resetsAt),
        ...(entry.restartedAt !== undefined
          ? { restartedAt: iso(entry.restartedAt) }
          : {}),
        ...(entry.anchor
          ? {
              anchor: {
                at: iso(entry.anchor.at),
                percentUsed: entry.anchor.percentUsed,
                workers: entry.anchor.workers,
              },
            }
          : {}),
        ...(entry.percentPerWorkerHour !== undefined
          ? { percentPerWorkerHour: entry.percentPerWorkerHour }
          : {}),
      },
    ]),
  );
  return `${JSON.stringify({ schemaVersion: LEDGER_SCHEMA_VERSION, windows }, null, 2)}\n`;
}

function timestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
