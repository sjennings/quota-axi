import { SELECTION_SCALAR_KEY } from "./types.js";
import type {
  EffectivePaceSummary,
  EffectiveRunway,
  EffectiveSelection,
  QuotaPace,
  QuotaPaceReason,
  QuotaWindow,
} from "./types.js";

/** Reserve within this many percentage points of zero is treated as on_pace. */
export const PACE_ON_PACE_DEADBAND_PERCENT_POINTS = 1;

/**
 * Linear exhaustion projections before this much of the cycle has elapsed are
 * labeled `early` rather than `established`.
 */
export const PACE_EARLY_ELAPSED_PERCENT = 10;

/** The selection scalar is reported within this symmetric bound. */
export const SELECTION_CLAMP_PERCENT_POINTS = 100;

/**
 * Maximum snapshot-clock skew accepted beyond one declared window duration
 * when identifying a fully unused future cycle as not yet opened.
 */
export const UNOPENED_WINDOW_MAX_FUTURE_START_SKEW_SECONDS = 5 * 60;

/**
 * Below this much remaining cycle time the selection ratio is dominated by the
 * four-decimal rounding of `timeRemainingPercent` rather than by real signal,
 * so the window is treated as unmeasurable instead of producing a runaway or
 * infinite term.
 */
export const SELECTION_MIN_TIME_REMAINING_PERCENT = 0.01;

/**
 * A window whose cycle is at least this long is a long window: its allowance
 * has to last days, so being early in the cycle with nearly all of it left is
 * not evidence that it will reach reset unused. Six days keeps every weekly
 * cycle in, including one whose trusted start and reset are a little short of
 * exactly seven days apart.
 */
export const LONG_WINDOW_MIN_CYCLE_SECONDS = 6 * 86_400;

/**
 * Projected extra burn from in-flight workers, keyed by bounding window id, in
 * percentage points of that window per hour for the whole in-flight load.
 */
export type InflightLoad = ReadonlyMap<string, number>;

type PaceOptions = {
  stale?: boolean;
};

type ResolvedCycle = {
  cycleSeconds: number;
  startsAtMs: number;
  resetsAtMs: number;
  cycleBasis: NonNullable<QuotaPace["cycleBasis"]>;
};

export function computeWindowPace(
  window: QuotaWindow,
  generatedAt: string,
  options: PaceOptions = {},
): QuotaPace {
  if (options.stale) return unknownPace("stale");

  const generatedAtMs = Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) return unknownPace("invalid_cycle");

  const percentRemaining = finiteNumber(window.percentRemaining);
  const percentUsed = resolvePercentUsed(window, percentRemaining);
  if (percentRemaining === undefined || percentUsed === undefined) {
    return unknownPace("missing_usage");
  }

  const cycle = resolveCycle(window, generatedAtMs);
  if (!cycle.ok) return unknownPace(cycle.reason);

  const { cycleSeconds, startsAtMs, resetsAtMs, cycleBasis } = cycle.value;
  const remainingMs = resetsAtMs - generatedAtMs;
  const elapsedMs = generatedAtMs - startsAtMs;
  const timeRemainingPercent = (100 * remainingMs) / (cycleSeconds * 1000);
  const elapsedPercent = (100 * elapsedMs) / (cycleSeconds * 1000);
  const reservePercentPoints = percentRemaining - timeRemainingPercent;
  const status = classifyPace(reservePercentPoints);

  const pace: QuotaPace = {
    status,
    timeRemainingPercent: roundPace(timeRemainingPercent),
    elapsedPercent: roundPace(elapsedPercent),
    reservePercentPoints: roundPace(reservePercentPoints),
    cycleBasis,
    cycleSeconds,
  };

  if (elapsedPercent > 0) {
    pace.burnMultiple = roundPace(percentUsed / elapsedPercent);
  }

  if (percentUsed > 0 && elapsedMs > 0) {
    const remainingBudget = percentRemaining;
    const burnPerMs = percentUsed / elapsedMs;
    if (burnPerMs > 0 && remainingBudget >= 0) {
      const msToExhaust = remainingBudget / burnPerMs;
      const projectedExhaustedAtMs = generatedAtMs + msToExhaust;
      if (isRepresentableDateMs(projectedExhaustedAtMs)) {
        pace.projectedExhaustedAt = new Date(
          projectedExhaustedAtMs,
        ).toISOString();
        pace.projectionConfidence =
          elapsedPercent < PACE_EARLY_ELAPSED_PERCENT ? "early" : "established";
      }
    }
  }

  return pace;
}

/**
 * @param inflight optional extra burn from in-flight workers. A window it
 * names is projected at the faster of its observed cycle-average burn and that
 * load, as if the load continues, so the load can only bring exhaustion closer.
 */
export function computeEffectiveRunway(
  windows: QuotaWindow[],
  generatedAt: string,
  inflight?: InflightLoad,
): EffectiveRunway {
  const generatedAtMs = Date.parse(generatedAt);

  const exhausted = windows.find(
    (window) => finiteNumber(window.percentRemaining) === 0,
  );

  if (exhausted) {
    return {
      status: "exhausted_now",
      usableRunwaySeconds: 0,
      limitingWindowId: exhausted.id,
      ...(isRepresentableDateMs(generatedAtMs)
        ? { projectedExhaustedAt: new Date(generatedAtMs).toISOString() }
        : {}),
    };
  }

  // No bound reports a reset, so the scope has no current cycle to derive a
  // reset-implying verdict from: fail closed to `unknown` naming every bound
  // rather than publishing `through_reset` or a projection. A vendor-reported
  // zero above still yields `exhausted_now`, which needs no cycle.
  if (
    windows.every(
      (window) => resolveResetsAtOutcome(window.resetsAt).kind === "missing",
    )
  ) {
    return unknownRunway(windows);
  }

  if (!isRepresentableDateMs(generatedAtMs)) {
    return unknownRunway(windows);
  }

  const accountWindows = windows.filter(({ kind }) => kind !== "model");
  const accountBoundsEstablishRunway =
    windows.some(({ kind }) => kind === "model") &&
    accountWindows.length > 0 &&
    computeEffectiveRunway(accountWindows, generatedAt, inflight).status !==
      "unknown";

  const unmeasurableWindowIds: string[] = [];
  const projections: Array<{
    window: QuotaWindow;
    exhaustedAtMs: number;
    confidence: NonNullable<EffectiveRunway["projectionConfidence"]>;
  }> = [];
  let lowestConfidence: EffectiveRunway["projectionConfidence"] = "established";

  for (const window of windows) {
    const remaining = finiteNumber(window.percentRemaining);
    const pace = window.pace;
    const resetsAt = resolveResetsAtOutcome(window.resetsAt);

    if (resetsAt.kind === "missing") {
      // A missing resetsAt is non-bounding only when it also reports no
      // usage (100% remaining, 0% used) - e.g. a Claude five_hour window
      // before its first request this window. That shape's countdown has
      // simply not started yet, so it does not block the aggregate. A
      // missing resetsAt paired with any other usage shape (unknown usage,
      // or nonzero usage without an active clock) is a real data gap, not
      // "not yet triggered", and still fails closed.
      if (remaining !== undefined && isZeroUse(window, remaining)) {
        continue;
      }
      unmeasurableWindowIds.push(window.id);
      continue;
    }

    // A provider can publish a fresh named-model window just before its cycle
    // opens. When both usage fields prove that nothing has been consumed, the
    // reset is valid and no more than one declared cycle plus the bounded
    // snapshot skew ahead, and pace identifies only that skew, the unopened
    // window has no exhaustion projection and does not block one
    // established by the scope's other bounds. Keep every other unknown pace
    // fail-closed.
    if (
      isProvablyUnopenedFutureCycle(
        window,
        remaining,
        pace,
        resetsAt,
        generatedAtMs,
        accountBoundsEstablishRunway,
      )
    ) {
      continue;
    }

    if (
      remaining === undefined ||
      remaining < 0 ||
      remaining > 100 ||
      pace === undefined ||
      pace.status === "unknown" ||
      resetsAt.kind === "malformed" ||
      resetsAt.ms <= generatedAtMs
    ) {
      unmeasurableWindowIds.push(window.id);
      continue;
    }
    const resetsAtMs = budgetResetsAtMs(window, pace, resetsAt.ms);
    const loadExhaustedAtMs = inflightExhaustionMs(
      remaining,
      inflight?.get(window.id),
      generatedAtMs,
    );

    if (isZeroUse(window, remaining)) {
      const confidence = elapsedConfidence(pace);
      if (confidence === "early") lowestConfidence = "early";
      if (loadExhaustedAtMs !== undefined && loadExhaustedAtMs < resetsAtMs) {
        projections.push({
          window,
          exhaustedAtMs: loadExhaustedAtMs,
          confidence,
        });
      }
      continue;
    }

    // A window pace only carries a projection pair when the cycle-average
    // projection succeeded, so the pair itself is the basis check.
    const cycleExhaustedAtMs = parseTimestamp(pace?.projectedExhaustedAt);
    if (
      cycleExhaustedAtMs === undefined ||
      cycleExhaustedAtMs <= generatedAtMs ||
      pace?.projectionConfidence === undefined
    ) {
      unmeasurableWindowIds.push(window.id);
      continue;
    }
    if (pace.projectionConfidence === "early") lowestConfidence = "early";
    const exhaustedAtMs =
      loadExhaustedAtMs === undefined
        ? cycleExhaustedAtMs
        : Math.min(cycleExhaustedAtMs, loadExhaustedAtMs);
    if (exhaustedAtMs < resetsAtMs) {
      projections.push({
        window,
        exhaustedAtMs,
        confidence: pace.projectionConfidence,
      });
    }
  }

  if (unmeasurableWindowIds.length > 0) {
    return { status: "unknown", unmeasurableWindowIds };
  }

  if (projections.length === 0) {
    return {
      status: "through_reset",
      projectionConfidence: lowestConfidence,
    };
  }

  const limiting = projections.reduce((earliest, candidate) =>
    candidate.exhaustedAtMs < earliest.exhaustedAtMs ? candidate : earliest,
  );
  return {
    status: "projected_exhaustion",
    usableRunwaySeconds: Math.max(
      0,
      Math.round((limiting.exhaustedAtMs - generatedAtMs) / 1000),
    ),
    projectedExhaustedAt: new Date(limiting.exhaustedAtMs).toISOString(),
    limitingWindowId: limiting.window.id,
    projectionConfidence: limiting.confidence,
  };
}

/**
 * When the in-flight load alone would spend `percentRemaining`, or undefined
 * when there is no positive load or the instant is not representable.
 */
function inflightExhaustionMs(
  percentRemaining: number,
  percentPerHour: number | undefined,
  generatedAtMs: number,
): number | undefined {
  if (percentPerHour === undefined || !(percentPerHour > 0)) return undefined;
  const exhaustedAtMs =
    generatedAtMs + (percentRemaining / percentPerHour) * 3_600_000;
  return isRepresentableDateMs(exhaustedAtMs) ? exhaustedAtMs : undefined;
}

/**
 * The end of the window's budget clock: its vendor reset, or the end of the
 * full cycle restarted at an observed vendor reset, so a restarted allowance
 * still has to last a whole cycle.
 */
function budgetResetsAtMs(
  window: QuotaWindow,
  pace: QuotaPace,
  vendorResetsAtMs: number,
): number {
  if (pace.cycleBasis !== "observed_reset") return vendorResetsAtMs;
  const startsAtMs = parseTimestamp(window.observedResetAt);
  const cycleSeconds = finiteNumber(pace.cycleSeconds);
  if (startsAtMs === undefined || cycleSeconds === undefined) {
    return vendorResetsAtMs;
  }
  return Math.max(vendorResetsAtMs, startsAtMs + cycleSeconds * 1000);
}

function elapsedConfidence(
  pace: QuotaPace,
): NonNullable<EffectiveRunway["projectionConfidence"]> {
  return (pace.elapsedPercent ?? 0) < PACE_EARLY_ELAPSED_PERCENT
    ? "early"
    : "established";
}

export function summarizeEffectivePace(
  windows: QuotaWindow[],
): EffectivePaceSummary {
  const aheadWindowIds: string[] = [];
  const behindWindowIds: string[] = [];
  const onPaceWindowIds: string[] = [];
  const unknownWindowIds: string[] = [];
  let worstReservePercentPoints: number | undefined;
  let worstReserveWindowId: string | undefined;

  for (const window of windows) {
    const pace = window.pace;
    switch (pace?.status) {
      case "ahead":
        aheadWindowIds.push(window.id);
        break;
      case "behind":
        behindWindowIds.push(window.id);
        break;
      case "on_pace":
        onPaceWindowIds.push(window.id);
        break;
      default:
        unknownWindowIds.push(window.id);
        break;
    }

    const reserve = pace?.reservePercentPoints;
    if (reserve === undefined) continue;
    if (
      worstReservePercentPoints === undefined ||
      reserve < worstReservePercentPoints
    ) {
      worstReservePercentPoints = reserve;
      worstReserveWindowId = window.id;
    }
  }

  const summary: EffectivePaceSummary = {
    status: aggregatePaceStatus({
      ahead: aheadWindowIds.length,
      behind: behindWindowIds.length,
      onPace: onPaceWindowIds.length,
      unknown: unknownWindowIds.length,
    }),
  };
  if (aheadWindowIds.length > 0) summary.aheadWindowIds = aheadWindowIds;
  if (behindWindowIds.length > 0) summary.behindWindowIds = behindWindowIds;
  if (onPaceWindowIds.length > 0) summary.onPaceWindowIds = onPaceWindowIds;
  if (unknownWindowIds.length > 0) summary.unknownWindowIds = unknownWindowIds;
  if (
    worstReservePercentPoints !== undefined &&
    worstReserveWindowId !== undefined
  ) {
    summary.worstReservePercentPoints = worstReservePercentPoints;
    summary.worstReserveWindowId = worstReserveWindowId;
  }
  return summary;
}

/**
 * Cycle-weighted mean, across a scope's bounding windows, of the allowance each
 * window is projected to forfeit at reset if its observed burn continues:
 *
 *   gap_w       = percentRemaining_w / timeRemainingPercent_w - burnMultiple_w
 *   scopeMetric = SUM(gap_w * cycleSeconds_w) / SUM(cycleSeconds_w)
 *
 * `gap_w` is the per-window projected forfeiture `percentRemaining -
 * burnMultiple * timeRemainingPercent` divided by `timeRemainingPercent`, which
 * makes windows on different cycle clocks comparable. Positive means allowance
 * is on track to reach reset unused; `0` is exact utilization; negative means
 * the window is overdrawn against its reset clock.
 *
 * On a long window a positive `gap_w` is scaled by the elapsed share of its
 * cycle, and in-flight load raises `burnMultiple_w` (see `windowSelectionGap`).
 *
 * Any bounding window without usable pace makes the whole scope unmeasurable:
 * an unknown window is never assumed healthy and never defaults to zero. The
 * one exception is a not-yet-triggered window - no `resetsAt` at all plus zero
 * usage - which is fully available rather than unmeasurable, so it is excluded
 * from this weighted mean instead of blocking. When every bound is that shape
 * the scalar is withheld with no blockers named; the runway aggregate withholds
 * its verdict too but names every bound (README "Effective usable runway").
 */
export function summarizeEffectiveSelection(
  windows: QuotaWindow[],
  inflight?: InflightLoad,
): EffectiveSelection {
  if (windows.length === 0) return { status: "unknown" };

  const unmeasurableWindowIds: string[] = [];
  let weightedGapSum = 0;
  let cycleSecondsSum = 0;

  for (const window of windows) {
    const gap = windowSelectionGap(window, inflight?.get(window.id));
    const cycleSeconds = finiteNumber(window.pace?.cycleSeconds);
    if (gap === undefined || cycleSeconds === undefined || cycleSeconds <= 0) {
      if (!isNotYetTriggeredZeroUse(window)) {
        unmeasurableWindowIds.push(window.id);
      }
      continue;
    }
    weightedGapSum += gap * cycleSeconds;
    cycleSecondsSum += cycleSeconds;
  }

  if (unmeasurableWindowIds.length > 0) {
    return { status: "unknown", unmeasurableWindowIds };
  }
  if (cycleSecondsSum <= 0) {
    // Every bound is a not-yet-triggered zero-use window, so there is no
    // measurable cycle to weight; the scope publishes no scalar.
    return { status: "unknown" };
  }
  const scopeMetric = weightedGapSum / cycleSecondsSum;
  if (!Number.isFinite(scopeMetric)) {
    return {
      status: "unknown",
      unmeasurableWindowIds: windows.map(({ id }) => id),
    };
  }
  return {
    status: "known",
    [SELECTION_SCALAR_KEY]: roundPace(
      clamp(scopeMetric, SELECTION_CLAMP_PERCENT_POINTS),
    ),
  };
}

/**
 * The per-window selection term, or undefined when the window is unmeasurable.
 *
 * In-flight load projects the burn at the faster of the observed
 * cycle-average and that load continuing. On a long window a positive term,
 * allowance projected to reach reset unused, is credited only in proportion to
 * the elapsed share of the cycle: the allowance has to last the rest of the
 * window, so an early, barely used week is not freely spendable. A negative
 * term is never scaled, so heavy early burn still reads as overdrawn at once.
 */
function windowSelectionGap(
  window: QuotaWindow,
  inflightPercentPerHour: number | undefined,
): number | undefined {
  const pace = window.pace;
  if (pace === undefined || pace.status === "unknown") return undefined;

  const percentRemaining = finiteNumber(window.percentRemaining);
  const timeRemainingPercent = finiteNumber(pace.timeRemainingPercent);
  if (
    percentRemaining === undefined ||
    timeRemainingPercent === undefined ||
    timeRemainingPercent < SELECTION_MIN_TIME_REMAINING_PERCENT
  ) {
    return undefined;
  }

  const observedBurnMultiple = resolveSelectionBurnMultiple(
    window,
    percentRemaining,
  );
  if (observedBurnMultiple === undefined) return undefined;
  const cycleSeconds = finiteNumber(pace.cycleSeconds);
  const burnMultiple = Math.max(
    observedBurnMultiple,
    inflightBurnMultiple(inflightPercentPerHour, cycleSeconds),
  );

  const gap = percentRemaining / timeRemainingPercent - burnMultiple;
  if (!Number.isFinite(gap)) return undefined;
  if (
    gap > 0 &&
    cycleSeconds !== undefined &&
    cycleSeconds >= LONG_WINDOW_MIN_CYCLE_SECONDS
  ) {
    const elapsedPercent = finiteNumber(pace.elapsedPercent) ?? 0;
    return gap * Math.min(1, Math.max(0, elapsedPercent / 100));
  }
  return gap;
}

/**
 * The in-flight load as a burn multiple: percentage points of the window per
 * percentage point of its cycle, the unit of `burnMultiple`.
 */
function inflightBurnMultiple(
  percentPerHour: number | undefined,
  cycleSeconds: number | undefined,
): number {
  if (
    percentPerHour === undefined ||
    !(percentPerHour > 0) ||
    cycleSeconds === undefined
  ) {
    return 0;
  }
  return (percentPerHour * cycleSeconds) / 3600 / 100;
}

/**
 * `computeWindowPace` omits `burnMultiple` only when no cycle time has elapsed
 * yet. Nothing can have been consumed in zero elapsed time, so that single
 * zero-elapsed, zero-use case has an observed burn rate of 0 and keeps the
 * scope measurable. Any other absent `burnMultiple` is a real data gap.
 */
function resolveSelectionBurnMultiple(
  window: QuotaWindow,
  percentRemaining: number,
): number | undefined {
  const explicit = finiteNumber(window.pace?.burnMultiple);
  if (explicit !== undefined) return explicit;
  const elapsedPercent = finiteNumber(window.pace?.elapsedPercent);
  const percentUsed =
    finiteNumber(window.percentUsed) ?? 100 - percentRemaining;
  if (elapsedPercent === undefined || elapsedPercent > 0 || percentUsed !== 0) {
    return undefined;
  }
  return 0;
}

function clamp(value: number, bound: number): number {
  return Math.min(bound, Math.max(-bound, value));
}

function unknownRunway(windows: QuotaWindow[]): EffectiveRunway {
  return {
    status: "unknown",
    ...(windows.length > 0
      ? { unmeasurableWindowIds: windows.map(({ id }) => id) }
      : {}),
  };
}

function isZeroUse(window: QuotaWindow, percentRemaining: number): boolean {
  const percentUsed = finiteNumber(window.percentUsed);
  return (
    percentRemaining === 100 && (percentUsed === undefined || percentUsed === 0)
  );
}

/**
 * A window whose cycle countdown has not started yet: no `resetsAt` at all
 * plus zero usage (e.g. a `five_hour` window before its first request). It is
 * fully available rather than unmeasurable, so it never blocks an aggregate by
 * itself. A present-but-unparseable `resetsAt` is a data defect, not
 * "not yet triggered", and still fails closed.
 */
function isNotYetTriggeredZeroUse(window: QuotaWindow): boolean {
  if (resolveResetsAtOutcome(window.resetsAt).kind !== "missing") return false;
  // A window whose pace resolved knows its cycle, so it is not untriggered;
  // its own measurability rules still apply.
  if (window.pace !== undefined && window.pace.status !== "unknown") {
    return false;
  }
  const remaining = finiteNumber(window.percentRemaining);
  return remaining !== undefined && isZeroUse(window, remaining);
}

function isProvablyUnopenedFutureCycle(
  window: QuotaWindow,
  percentRemaining: number | undefined,
  pace: QuotaPace | undefined,
  resetsAt: ResetsAtOutcome,
  generatedAtMs: number,
  accountBoundsEstablishRunway: boolean,
): boolean {
  const windowSeconds = finiteNumber(window.windowSeconds);
  if (
    window.kind !== "model" ||
    !accountBoundsEstablishRunway ||
    percentRemaining !== 100 ||
    window.percentUsed !== 0 ||
    pace?.status !== "unknown" ||
    pace.reason !== "future_cycle_start" ||
    resetsAt.kind !== "ok" ||
    windowSeconds === undefined ||
    windowSeconds <= 0
  ) {
    return false;
  }

  const latestPlausibleResetMs =
    generatedAtMs +
    (windowSeconds + UNOPENED_WINDOW_MAX_FUTURE_START_SKEW_SECONDS) * 1000;
  return (
    isRepresentableDateMs(latestPlausibleResetMs) &&
    resetsAt.ms > generatedAtMs &&
    resetsAt.ms <= latestPlausibleResetMs
  );
}

function resolveCycle(
  window: QuotaWindow,
  generatedAtMs: number,
): { ok: true; value: ResolvedCycle } | { ok: false; reason: QuotaPaceReason } {
  const scheduled = resolveScheduledCycle(window, generatedAtMs);
  if (!scheduled.ok) return scheduled;
  const restart = observedRestart(
    window,
    scheduled.value.cycleSeconds,
    generatedAtMs,
  );
  return restart ? { ok: true, value: restart } : scheduled;
}

/**
 * The budget clock of a window quota-axi saw the vendor reset before its
 * schedule: a full cycle starting at the observed reset, so day one of a fresh
 * budget is never measured against the old scheduled reset. Undefined when no
 * restart applies or the restarted cycle is not current.
 */
function observedRestart(
  window: QuotaWindow,
  cycleSeconds: number,
  generatedAtMs: number,
): ResolvedCycle | undefined {
  const startsAtMs = parseTimestamp(window.observedResetAt);
  if (startsAtMs === undefined || startsAtMs > generatedAtMs) return undefined;
  const resetsAtMs = startsAtMs + cycleSeconds * 1000;
  if (!isRepresentableDateMs(resetsAtMs) || resetsAtMs <= generatedAtMs) {
    return undefined;
  }
  return {
    cycleSeconds,
    startsAtMs,
    resetsAtMs,
    cycleBasis: "observed_reset",
  };
}

function resolveScheduledCycle(
  window: QuotaWindow,
  generatedAtMs: number,
): { ok: true; value: ResolvedCycle } | { ok: false; reason: QuotaPaceReason } {
  const resetsAtMs = parseTimestamp(window.resetsAt);
  if (resetsAtMs === undefined) return { ok: false, reason: "missing_cycle" };
  if (resetsAtMs <= generatedAtMs)
    return { ok: false, reason: "expired_reset" };

  const startsAtMs = parseTimestamp(window.startsAt);
  if (startsAtMs !== undefined) {
    if (startsAtMs >= resetsAtMs) return { ok: false, reason: "invalid_cycle" };
    if (startsAtMs > generatedAtMs)
      return { ok: false, reason: "future_cycle_start" };
    const cycleSeconds = (resetsAtMs - startsAtMs) / 1000;
    if (!(cycleSeconds > 0) || !Number.isFinite(cycleSeconds)) {
      return { ok: false, reason: "invalid_cycle" };
    }
    return {
      ok: true,
      value: {
        cycleSeconds,
        startsAtMs,
        resetsAtMs,
        cycleBasis: "starts_at_resets_at",
      },
    };
  }

  const windowSeconds = finiteNumber(window.windowSeconds);
  if (windowSeconds === undefined)
    return { ok: false, reason: "missing_cycle" };
  if (!(windowSeconds > 0)) return { ok: false, reason: "invalid_cycle" };

  const cycleDurationMs = windowSeconds * 1000;
  if (!Number.isFinite(cycleDurationMs)) {
    return { ok: false, reason: "invalid_cycle" };
  }
  const impliedStartsAtMs = resetsAtMs - cycleDurationMs;
  if (!isRepresentableDateMs(impliedStartsAtMs)) {
    return { ok: false, reason: "invalid_cycle" };
  }
  if (impliedStartsAtMs > generatedAtMs) {
    return { ok: false, reason: "future_cycle_start" };
  }
  return {
    ok: true,
    value: {
      cycleSeconds: windowSeconds,
      startsAtMs: impliedStartsAtMs,
      resetsAtMs,
      cycleBasis: "window_seconds",
    },
  };
}

function classifyPace(
  reservePercentPoints: number,
): Exclude<QuotaPace["status"], "unknown"> {
  if (Math.abs(reservePercentPoints) <= PACE_ON_PACE_DEADBAND_PERCENT_POINTS) {
    return "on_pace";
  }
  return reservePercentPoints < 0 ? "ahead" : "behind";
}

function aggregatePaceStatus(counts: {
  ahead: number;
  behind: number;
  onPace: number;
  unknown: number;
}): EffectivePaceSummary["status"] {
  const known = counts.ahead + counts.behind + counts.onPace;
  if (known === 0) return "unknown";
  if (counts.ahead > 0 && counts.behind > 0) return "mixed";
  if (counts.ahead > 0) return "ahead";
  if (counts.behind > 0) return "behind";
  return "on_pace";
}

function resolvePercentUsed(
  window: QuotaWindow,
  percentRemaining: number | undefined,
): number | undefined {
  const explicit = finiteNumber(window.percentUsed);
  if (explicit !== undefined) return explicit;
  if (percentRemaining === undefined) return undefined;
  return 100 - percentRemaining;
}

function unknownPace(reason: QuotaPaceReason): QuotaPace {
  return { status: "unknown", reason };
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

type ResetsAtOutcome =
  | { kind: "missing" }
  | { kind: "malformed" }
  | { kind: "ok"; ms: number };

/**
 * Distinguishes a genuinely absent `resetsAt` (the cycle has not been
 * triggered yet) from a present-but-unparseable one (a real data defect that
 * claims a reset it cannot honor). Effective runway treats only the former
 * as non-bounding.
 */
function resolveResetsAtOutcome(value: string | undefined): ResetsAtOutcome {
  if (!value) return { kind: "missing" };
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { kind: "ok", ms } : { kind: "malformed" };
}

function finiteNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRepresentableDateMs(value: number): boolean {
  return Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
}

function roundPace(value: number): number {
  return Number(value.toFixed(4));
}
