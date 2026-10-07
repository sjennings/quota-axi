import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withQuotaSemantics } from "../src/interpretation.js";
import { renderQuotaToon } from "../src/render.js";
import { SELECTION_SCALAR_KEY } from "../src/types.js";
import type { ProviderQuota, QuotaWindow } from "../src/types.js";
import {
  observedBurnRates,
  observeWindows,
  updateWindowObservationLedger,
  type WindowObservationLedger,
} from "../src/window-observations.js";

const WEEK_SECONDS = 604_800;
const HOUR_MS = 3_600_000;
/** A Codex weekly window scheduled to reset at this instant. */
const RESETS_AT = "2026-10-14T04:09:00.000Z";

function at(hoursAfterStart: number): string {
  const start = Date.parse(RESETS_AT) - WEEK_SECONDS * 1000;
  return new Date(start + hoursAfterStart * HOUR_MS).toISOString();
}

function reading(
  percentRemaining: number,
  options: {
    resetsAt?: string;
    windowSeconds?: number;
    state?: Partial<ProviderQuota["state"]>;
  } = {},
): ProviderQuota {
  const weekly: QuotaWindow = {
    id: "weekly",
    label: "week",
    kind: "weekly",
    percentUsed: 100 - percentRemaining,
    percentRemaining,
    windowSeconds: options.windowSeconds ?? WEEK_SECONDS,
    resetsAt: options.resetsAt ?? RESETS_AT,
  };
  return {
    provider: "codex",
    accountKeys: ["default"],
    windows: [weekly],
    state: { status: "fresh", stale: false, ...options.state },
  };
}

/** Run readings through the ledger in order, returning the last observation. */
function observeSeries(
  series: Array<[hours: number, reading: ProviderQuota, workers?: number]>,
  ledger: WindowObservationLedger = new Map(),
): { reading: ProviderQuota; ledger: WindowObservationLedger } {
  let last: ProviderQuota | undefined;
  for (const [hours, next, workers] of series) {
    const observed = observeWindows(
      ledger,
      [next],
      at(hours),
      () => workers ?? 0,
    );
    ledger = observed.ledger;
    last = observed.readings[0];
  }
  return { reading: last!, ledger };
}

describe("vendor-triggered reset", () => {
  it("restarts a long window's budget clock where the jump was seen", () => {
    // Five days in, 30% left; at day five plus one hour the vendor hands the
    // whole week back on the same schedule.
    const { reading: restarted } = observeSeries([
      [120, reading(30)],
      [121, reading(100)],
    ]);
    const weekly = restarted.windows[0]!;
    expect(weekly.observedResetAt).toBe(at(121));
    expect(weekly.resetsAt).toBe(RESETS_AT);

    const generatedAt = at(122);
    const restartedScope = withQuotaSemantics(restarted, generatedAt)
      .quotaSemantics!.effectiveAvailability[0]!;
    const naive = withQuotaSemantics(reading(100), generatedAt).quotaSemantics!
      .effectiveAvailability[0]!;

    expect(
      withQuotaSemantics(restarted, generatedAt).windows[0]!.pace,
    ).toMatchObject({
      cycleBasis: "observed_reset",
      cycleSeconds: WEEK_SECONDS,
      elapsedPercent: 0.5952,
      timeRemainingPercent: 99.4048,
    });
    // Day one of a fresh week, not the last two days of the old one.
    expect(naive.selection![SELECTION_SCALAR_KEY]!).toBeGreaterThan(1);
    expect(restartedScope.selection![SELECTION_SCALAR_KEY]!).toBeLessThan(0.01);
  });

  it("holds the allowance to a full cycle from the restart", () => {
    const { reading: restarted } = observeSeries([
      [120, reading(30)],
      [121, reading(100)],
      [131, reading(90)],
    ]);
    const generatedAt = at(131);
    const runway = withQuotaSemantics(restarted, generatedAt).quotaSemantics!
      .effectiveAvailability[0]!.runway;
    const naive = withQuotaSemantics(reading(90), generatedAt).quotaSemantics!
      .effectiveAvailability[0]!.runway;

    // 10 points in 10 hours lasts 90 more hours: past the vendor's reset in
    // 37 hours, but not past a full week from the restart.
    expect(naive?.status).toBe("through_reset");
    expect(runway).toMatchObject({
      status: "projected_exhaustion",
      usableRunwaySeconds: 90 * 3600,
      limitingWindowId: "weekly",
    });
  });

  it("keeps the restart on later readings of the same schedule", () => {
    const { reading: later, ledger } = observeSeries([
      [120, reading(30)],
      [121, reading(100)],
      [125, reading(96)],
    ]);
    expect(later.windows[0]!.observedResetAt).toBe(at(121));

    // A reused reading is not a new observation but keeps the restart.
    const reused = observeWindows(
      ledger,
      [reading(96, { state: { reused: true } })],
      at(126),
      () => 0,
    );
    expect(reused.readings[0]!.windows[0]!.observedResetAt).toBe(at(121));
  });

  it("drops the restart once the vendor's schedule moves on", () => {
    const { reading: next } = observeSeries([
      [120, reading(30)],
      [121, reading(100)],
      [169, reading(100, { resetsAt: at(336) })],
    ]);
    expect(next.windows[0]!.observedResetAt).toBeUndefined();
  });

  it.each([
    [
      "a scheduled reset that moved resetsAt",
      [
        [120, reading(30)],
        [121, reading(100, { resetsAt: at(289) })],
      ],
    ],
    [
      "a jump that leaves the window short of full",
      [
        [120, reading(30)],
        [121, reading(95)],
      ],
    ],
    [
      "a small rise near full",
      [
        [120, reading(92)],
        [121, reading(100)],
      ],
    ],
    [
      "a short window",
      [
        [1, reading(30, { windowSeconds: 18_000 })],
        [2, reading(100, { windowSeconds: 18_000 })],
      ],
    ],
    ["a first reading", [[121, reading(100)]]],
    [
      "a stale reading",
      [
        [120, reading(30)],
        [121, reading(100, { state: { status: "stale", stale: true } })],
      ],
    ],
  ] as Array<[string, Array<[number, ProviderQuota]>]>)(
    "is never inferred from %s",
    (_name, series) => {
      expect(observeSeries(series).reading.windows[0]!.observedResetAt).toBe(
        undefined,
      );
    },
  );
});

describe("observed per-worker burn", () => {
  it("measures recent burn over a long enough interval with constant workers", () => {
    const { ledger, reading: last } = observeSeries([
      [10, reading(80), 4],
      [10.25, reading(79), 4],
      [11, reading(72), 4],
    ]);
    // 8 points in one hour across 4 workers.
    expect(observedBurnRates(ledger, last).get("weekly")).toBe(2);
  });

  it("gives no estimate when workers changed, none ran, or nothing moved", () => {
    for (const series of [
      [
        [10, reading(80), 4],
        [11, reading(72), 6],
      ],
      [
        [10, reading(80), 0],
        [11, reading(72), 0],
      ],
      [
        [10, reading(80), 4],
        [11, reading(80), 4],
      ],
      [
        [10, reading(80), 4],
        [10.25, reading(72), 4],
      ],
    ] as Array<Array<[number, ProviderQuota, number]>>) {
      const { ledger, reading: last } = observeSeries(series);
      expect(observedBurnRates(ledger, last).size).toBe(0);
    }
  });
});

describe("window observation ledger file", () => {
  it("persists observations privately and writes nothing when none are new", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-axi-observations-"));
    const file = join(dir, "nested", "window-observations.json");
    const observe = (next: ProviderQuota, hours: number) =>
      updateWindowObservationLedger((previous) => {
        const observed = observeWindows(previous, [next], at(hours), () => 0);
        return { ledger: observed.ledger, result: observed.readings[0]! };
      }, file);
    try {
      observe(reading(30, { state: { status: "error" } }), 120);
      expect(existsSync(join(dir, "nested"))).toBe(false);

      observe(reading(30), 120);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).not.toMatch(/token|email/i);

      const restarted = observe(reading(100), 121);
      expect(restarted.windows[0]!.observedResetAt).toBe(at(121));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("states the restart as an attention fact", () => {
    const { reading: restarted } = observeSeries([
      [120, reading(30)],
      [121, reading(100)],
    ]);
    const toon = renderQuotaToon(
      {
        generatedAt: at(122),
        schemaVersion: 5,
        providers: [withQuotaSemantics(restarted, at(122))],
      },
      "quota-axi",
      false,
    );
    expect(toon).toContain(
      `codex,all,observed_reset,"weekly reset early at ${at(121)} · scheduled ${RESETS_AT}",none`,
    );
  });
});
