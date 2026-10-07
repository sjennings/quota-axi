import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quotaCommand } from "../src/commands.js";
import {
  INFLIGHT_DEFAULT_PERCENT_PER_WORKER_HOUR,
  INFLIGHT_STALE_SECONDS,
  parseInflightInput,
  readInflightInput,
  scopeWorkers,
  type InflightEntry,
} from "../src/inflight.js";
import {
  withQuotaSemantics,
  type LaneInflight,
} from "../src/interpretation.js";
import { renderQuotaToon } from "../src/render.js";
import { SELECTION_SCALAR_KEY } from "../src/types.js";
import type {
  EffectiveAvailability,
  ProviderQuota,
  QuotaAxiResponse,
} from "../src/types.js";

const WEEK_SECONDS = 604_800;
const UPDATED_AT = "2026-10-07T04:55:00.000Z";

/**
 * The 2026-10-07 reading: a Codex `prolite` plan whose only window is weekly,
 * read 51 minutes after that window reset.
 */
const RESETS_AT = "2026-10-14T04:09:00.000Z";
const DISPATCH_AT = "2026-10-07T05:00:00.000Z";

function prolite(percentRemaining: number, accountKey?: string): ProviderQuota {
  return {
    provider: "codex",
    ...(accountKey ? { accountKey, accountKeys: [accountKey] } : {}),
    plan: "prolite",
    windows: [
      {
        id: "weekly",
        label: "week",
        kind: "weekly",
        percentUsed: 100 - percentRemaining,
        percentRemaining,
        windowSeconds: WEEK_SECONDS,
        resetsAt: RESETS_AT,
      },
    ],
    state: { status: "fresh", stale: false },
  };
}

function lane(
  entries: InflightEntry[],
  provider: ProviderQuota,
  observed: Record<string, number> = {},
): LaneInflight {
  return {
    scope: (scope) => scopeWorkers(entries, provider, scope),
    observedPercentPerWorkerHour: (windowId) => observed[windowId],
  };
}

function allModels(
  provider: ProviderQuota,
  generatedAt: string,
  inflight?: LaneInflight,
): EffectiveAvailability {
  const scope = withQuotaSemantics(
    provider,
    generatedAt,
    inflight,
  ).quotaSemantics?.effectiveAvailability.find(
    ({ scope }) => scope === "all_models",
  );
  expect(scope).toBeDefined();
  return scope!;
}

describe("a fresh long window", () => {
  it("is not read as freely spendable early in the prolite week", () => {
    const scope = allModels(prolite(100), DISPATCH_AT);

    expect(scope.effectivePercentRemaining).toBe(100);
    expect(scope.runway).toEqual({
      status: "through_reset",
      projectionConfidence: "early",
    });
    // Before the long-window rule this read 1: the whole untouched week
    // projected as forfeit. It now earns credit only as the week elapses.
    expect(scope.selection?.[SELECTION_SCALAR_KEY]).toBeGreaterThanOrEqual(0);
    expect(scope.selection?.[SELECTION_SCALAR_KEY]).toBeLessThan(0.01);
  });

  it("reads overdrawn at once when the early week burns heavily", () => {
    // Three hours after dispatch: the weekly allowance was gone. An overdrawn
    // term is never scaled, so the scalar is the full -burnMultiple.
    const exhausted = allModels(prolite(0), "2026-10-07T08:00:00.000Z");
    expect(exhausted.runway?.status).toBe("exhausted_now");
    expect(exhausted.selection?.[SELECTION_SCALAR_KEY]).toBeCloseTo(-43.64, 2);

    // An hour in, a fifth of the week already spent is already negative.
    const burning = allModels(prolite(80), "2026-10-07T05:09:00.000Z");
    expect(burning.selection?.[SELECTION_SCALAR_KEY]).toBeLessThan(-30);
    expect(burning.runway?.status).toBe("projected_exhaustion");
  });

  it("credits an unused long window more as its reset approaches", () => {
    const early = allModels(prolite(100), DISPATCH_AT);
    const late = allModels(prolite(100), "2026-10-13T04:09:00.000Z");
    expect(late.selection?.[SELECTION_SCALAR_KEY]).toBeGreaterThan(
      early.selection![SELECTION_SCALAR_KEY]!,
    );
  });
});

describe("in-flight workers", () => {
  const fifteen: InflightEntry[] = [{ provider: "codex", count: 15 }];

  it("projects the prolite week's exhaustion before it is spent", () => {
    const reading = prolite(100);
    const scope = allModels(reading, DISPATCH_AT, lane(fifteen, reading));

    expect(scope.inflight).toEqual({
      workers: 15,
      windows: [
        {
          windowId: "weekly",
          percentPerWorkerHour: INFLIGHT_DEFAULT_PERCENT_PER_WORKER_HOUR,
          basis: "fallback",
        },
      ],
    });
    // 100% at 15 x 2 points an hour lasts 3h20m.
    expect(scope.runway).toMatchObject({
      status: "projected_exhaustion",
      limitingWindowId: "weekly",
      usableRunwaySeconds: 12_000,
      projectedExhaustedAt: "2026-10-07T08:20:00.000Z",
      projectionConfidence: "early",
    });
    expect(scope.selection?.[SELECTION_SCALAR_KEY]).toBeLessThan(-40);
  });

  it("lowers spendPriority as workers pile onto one provider", () => {
    const reading = prolite(100);
    const priorities = [1, 3, 15].map(
      (count) =>
        allModels(
          reading,
          DISPATCH_AT,
          lane([{ provider: "codex", count }], reading),
        ).selection![SELECTION_SCALAR_KEY]!,
    );
    expect(priorities[0]).toBeGreaterThan(priorities[1]!);
    expect(priorities[1]).toBeGreaterThan(priorities[2]!);
  });

  it("prefers the observed per-worker burn over the fallback", () => {
    const reading = prolite(100);
    const scope = allModels(
      reading,
      DISPATCH_AT,
      lane(fifteen, reading, { weekly: 4 }),
    );
    expect(scope.inflight?.windows).toEqual([
      { windowId: "weekly", percentPerWorkerHour: 4, basis: "observed" },
    ]);
    expect(scope.runway?.usableRunwaySeconds).toBe(6_000);
  });

  it("uses an entry's own fallback when quota-axi has observed none", () => {
    const reading = prolite(100);
    const scope = allModels(
      reading,
      DISPATCH_AT,
      lane([{ provider: "codex", count: 2, percentPerWorkerHour: 5 }], reading),
    );
    expect(scope.inflight?.windows[0]).toMatchObject({
      percentPerWorkerHour: 5,
      basis: "fallback",
    });
    expect(scope.runway?.usableRunwaySeconds).toBe(36_000);
  });

  it("never makes a scope read healthier or more certain", () => {
    const readings = [
      prolite(100),
      prolite(60),
      prolite(5),
      { ...prolite(70), state: { status: "stale", stale: true } },
    ] as ProviderQuota[];
    for (const reading of readings) {
      for (const generatedAt of [DISPATCH_AT, "2026-10-11T00:00:00.000Z"]) {
        const without = allModels(reading, generatedAt);
        const loaded = allModels(
          reading,
          generatedAt,
          lane(
            [{ provider: "codex", count: 1, percentPerWorkerHour: 0.01 }],
            reading,
          ),
        );
        expect(loaded.status).toBe(without.status);
        expect(loaded.runway?.status === "unknown").toBe(
          without.runway?.status === "unknown",
        );
        expect(loaded.selection?.status).toBe(without.selection?.status);
        if (without.selection?.status === "known") {
          expect(loaded.selection![SELECTION_SCALAR_KEY]!).toBeLessThanOrEqual(
            without.selection[SELECTION_SCALAR_KEY]!,
          );
        }
        if (without.runway?.usableRunwaySeconds !== undefined) {
          expect(loaded.runway?.usableRunwaySeconds).toBeLessThanOrEqual(
            without.runway.usableRunwaySeconds,
          );
        }
      }
    }
  });

  it("matches entries by provider, account key, and scope", () => {
    const work = prolite(100, "openai-codex-work");
    const entries: InflightEntry[] = [
      { provider: "codex", count: 1 },
      { provider: "codex", accountKey: "openai-codex-work", count: 2 },
      { provider: "codex", accountKey: "codex-home", count: 4 },
      { provider: "codex", scope: "gpt-6.1-sol", count: 8 },
      { provider: "claude", count: 16 },
      { provider: "codex", count: 0, percentPerWorkerHour: 50 },
    ];
    expect(scopeWorkers(entries, work, "all_models")).toEqual({
      workers: 3,
      fallbackPercentPerWorkerHour: INFLIGHT_DEFAULT_PERCENT_PER_WORKER_HOUR,
    });
    expect(scopeWorkers(entries, work, "gpt-6.1-sol")?.workers).toBe(11);
    expect(
      scopeWorkers([{ provider: "codex", count: 0 }], work, "all_models"),
    ).toBeUndefined();
  });
});

describe("in-flight input file", () => {
  const now = Date.parse(DISPATCH_AT);
  const valid = {
    schemaVersion: 1,
    updatedAt: UPDATED_AT,
    workers: [
      { provider: "codex", count: 15 },
      {
        provider: "claude",
        accountKey: "default",
        scope: "all_models",
        count: 1,
        percentPerWorkerHour: 3,
      },
    ],
  };

  it("applies a current file", () => {
    expect(parseInflightInput(valid, now)).toEqual({
      state: { status: "applied", updatedAt: UPDATED_AT },
      entries: valid.workers,
    });
  });

  it("still applies a stale file but says so", () => {
    const later = now + (INFLIGHT_STALE_SECONDS + 600) * 1000;
    expect(parseInflightInput(valid, later)).toMatchObject({
      state: { status: "stale", updatedAt: UPDATED_AT },
      entries: valid.workers,
    });
  });

  it.each([
    ["not_an_object", []],
    ["unsupported_schema_version", { ...valid, schemaVersion: 2 }],
    ["invalid_updated_at", { ...valid, updatedAt: "yesterday" }],
    [
      "updated_at_in_future",
      { ...valid, updatedAt: "2026-10-07T06:00:00.000Z" },
    ],
    ["invalid_workers", { ...valid, workers: {} }],
    [
      "invalid_worker_entry:1",
      {
        ...valid,
        workers: [valid.workers[0], { provider: "openai", count: 1 }],
      },
    ],
    [
      "invalid_worker_entry:0",
      { ...valid, workers: [{ provider: "codex", count: 1.5 }] },
    ],
    [
      "invalid_worker_entry:0",
      { ...valid, workers: [{ provider: "codex", count: -1 }] },
    ],
    [
      "invalid_worker_entry:0",
      {
        ...valid,
        workers: [{ provider: "codex", count: 1, percentPerWorkerHour: 0 }],
      },
    ],
    [
      "invalid_worker_entry:0",
      { ...valid, workers: [{ provider: "codex", count: 1, scope: "" }] },
    ],
  ])("rejects the whole file as malformed: %s", (error, raw) => {
    const input = parseInflightInput(raw, now);
    expect(input.state).toMatchObject({ status: "malformed", error });
    expect(input.entries).toEqual([]);
  });

  it("reports a missing or unparsable file", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-axi-inflight-"));
    try {
      expect(readInflightInput(join(dir, "absent.json"), now).state).toEqual({
        status: "missing",
        error: "file_not_found",
      });
      const broken = join(dir, "broken.json");
      writeFileSync(broken, "{");
      expect(readInflightInput(broken, now).state).toEqual({
        status: "malformed",
        error: "invalid_json",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("in-flight rendering", () => {
  function report(
    inflight: QuotaAxiResponse["inflight"],
    workers?: InflightEntry[],
  ): string {
    const reading = prolite(100);
    return renderQuotaToon(
      {
        generatedAt: DISPATCH_AT,
        schemaVersion: 5,
        providers: [
          withQuotaSemantics(
            { ...reading, accountKeys: ["default"] },
            DISPATCH_AT,
            workers ? lane(workers, reading) : undefined,
          ),
        ],
        ...(inflight ? { inflight } : {}),
      },
      "quota-axi",
      false,
    );
  }

  it("names the load that moved a quota row", () => {
    const toon = report({ status: "applied", updatedAt: UPDATED_AT }, [
      { provider: "codex", count: 15 },
    ]);
    expect(toon).toContain(
      "codex,all_models,100,-49.3949,projected_exhaustion,early,weekly,",
    );
    expect(toon).toContain(
      "codex,all_models,inflight,15 workers · weekly 2 per worker-hour fallback,none",
    );
    expect(toon).not.toContain("inflight_input");
  });

  it("reports an input that did not fold in on every measured provider", () => {
    const toon = report({ status: "malformed", error: "invalid_json" });
    expect(toon).toContain(
      "codex,all,inflight_input,malformed · invalid_json,none",
    );
  });
});

describe("--inflight", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quota-axi-inflight-cli-"));
    vi.useFakeTimers({ now: Date.parse(DISPATCH_AT), toFake: ["Date"] });
    const snapshot = join(root, "snapshot.json");
    writeFileSync(
      snapshot,
      JSON.stringify({
        schemaVersion: 3,
        providers: [
          {
            ...prolite(100),
            label: "Codex",
            source: "oauth",
            state: {
              status: "fresh",
              stale: false,
              refreshedAt: DISPATCH_AT,
              sourcesTried: ["oauth"],
            },
          },
        ],
      }),
    );
    process.env.QUOTA_AXI_SNAPSHOT = snapshot;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.QUOTA_AXI_SNAPSHOT;
    delete process.env.QUOTA_AXI_INFLIGHT;
    process.exitCode = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  function writeInflight(count: number): string {
    const file = join(root, "inflight.json");
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: UPDATED_AT,
        workers: [{ provider: "codex", count }],
      }),
    );
    return file;
  }

  async function codexScope(args: string[]) {
    const output = JSON.parse(
      await quotaCommand(["--provider", "codex", "--json", ...args], undefined),
    ) as QuotaAxiResponse;
    return {
      output,
      scope: output.providers[0]?.quotaSemantics?.effectiveAvailability[0],
    };
  }

  it("is absent by default and leaves the reading unchanged", async () => {
    const { output, scope } = await codexScope([]);
    expect(output.inflight).toBeUndefined();
    expect(scope?.inflight).toBeUndefined();
    expect(scope?.runway?.status).toBe("through_reset");
  });

  it("folds the named file in, and the flag wins over the env var", async () => {
    process.env.QUOTA_AXI_INFLIGHT = join(root, "absent.json");
    const { output, scope } = await codexScope([
      "--inflight",
      writeInflight(15),
    ]);
    expect(output.inflight).toEqual({
      status: "applied",
      updatedAt: UPDATED_AT,
    });
    expect(scope?.inflight?.workers).toBe(15);
    expect(scope?.runway?.status).toBe("projected_exhaustion");
  });

  it("reads QUOTA_AXI_INFLIGHT and reports a missing file", async () => {
    process.env.QUOTA_AXI_INFLIGHT = join(root, "absent.json");
    const { output, scope } = await codexScope([]);
    expect(output.inflight).toEqual({
      status: "missing",
      error: "file_not_found",
    });
    expect(scope?.inflight).toBeUndefined();
    expect(scope?.runway?.status).toBe("through_reset");
  });

  it("is rejected by auth", async () => {
    await expect(
      import("../src/commands.js").then(({ authCommand }) =>
        authCommand(["--inflight", writeInflight(1)], undefined),
      ),
    ).rejects.toThrow("--inflight is only supported");
  });
});
