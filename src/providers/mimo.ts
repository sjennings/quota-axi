import { readJsonFileResult, type JsonFileReadResult } from "../lib/fs.js";
import { resolvePiAuthFilePath } from "../lib/pi-agent-dir.js";
import { classifyPiAuthEntry } from "../lib/pi-auth-store.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderQuota,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames } from "./common.js";
import {
  type EnvPiCredentialResolution,
  inspectEnvPiAuth,
  type KeyCredentialFailure,
  keyCredentialFailure,
  preferCredentialFailure,
  pushEnvCredential,
  pushPiReadCredential,
} from "./env-pi-credential.js";
import {
  extractOpencodeAuthKey,
  OPENCODE_AUTH_SOURCE,
  opencodeAuthFilePath,
} from "./opencode-auth-store.js";

export const MIMO_ENV_SOURCE = "env:MIMO_API_KEY";

/**
 * Pi stores Xiaomi MiMo's keys under the vendor's own provider entry names,
 * not under `mimo`: the pay-as-you-go key plus one Token Plan key per cluster.
 * Each entry is its own credential source (`pi:<entry id>`) in this declared
 * order, so a report names the exact entry that answered, a present-but-unusable
 * entry stays visible as present rather than absent, and an absent entry never
 * speaks for a sibling store.
 */
export const MIMO_PI_PROVIDER_IDS = [
  "xiaomi",
  "xiaomi-token-plan-sgp",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
] as const;

/**
 * The opencode auth-store provider id that authenticates this quota family.
 * Xiaomi's OpenCode login stores the SGP Token Plan key under the vendor's own
 * provider id, so the shared `opencode:auth.json` source reads it as one more
 * MiMo credential after the Pi entries.
 */
export const MIMO_OPENCODE_PROVIDER_IDS = ["xiaomi-token-plan-sgp"] as const;

/** Attempt and inspection source name for one Pi entry. */
export function mimoPiSource(piProviderId: string): string {
  return `pi:${piProviderId}`;
}

const LABEL = "MiMo";

type MimoDependencies = {
  credential: () => EnvPiCredentialResolution[];
  now: () => number;
};

export function resolveMimoCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  path = resolvePiAuthFilePath(),
  opencodePath = opencodeAuthFilePath(),
): EnvPiCredentialResolution[] {
  const credentials: EnvPiCredentialResolution[] = [];
  pushEnvCredential(credentials, environment, "MIMO_API_KEY", MIMO_ENV_SOURCE);
  const result: JsonFileReadResult = readJsonFileResult(path);
  for (const piProviderId of MIMO_PI_PROVIDER_IDS) {
    pushPiReadCredential(
      credentials,
      result,
      mimoPiSource(piProviderId),
      path,
      (value) => extractMimoPiEntry(value, piProviderId, path),
    );
  }
  pushPiReadCredential(
    credentials,
    readJsonFileResult(opencodePath),
    OPENCODE_AUTH_SOURCE,
    opencodePath,
    (value) => extractMimoOpencodeEntry(value, opencodePath),
  );
  return credentials;
}

/**
 * The opencode half of MiMo's credential surface: Xiaomi's `xiaomi-token-plan-sgp`
 * provider id in opencode's store is a usable literal key or it is absent, and
 * the shared reader owns the file's read-status classification.
 */
export function extractMimoOpencodeEntry(
  value: unknown,
  path: string,
): EnvPiCredentialResolution {
  const resolution = extractOpencodeAuthKey(
    value,
    MIMO_OPENCODE_PROVIDER_IDS,
    path,
  );
  return resolution.status === "available"
    ? {
        status: "available",
        key: resolution.key,
        source: OPENCODE_AUTH_SOURCE,
        path,
      }
    : { status: resolution.status, source: OPENCODE_AUTH_SOURCE, path };
}

/**
 * Pi's entry boundary: only `classifyPiAuthEntry` decides absent versus
 * present, and only a literal `type: "api_key"` record with a usable `key` is
 * a MiMo credential - Pi never writes an OAuth-shaped Xiaomi entry, so any
 * other shape is a present but unusable credential, not usable model auth.
 */
export function extractMimoPiEntry(
  value: unknown,
  piProviderId: string,
  path: string,
): EnvPiCredentialResolution {
  const source = mimoPiSource(piProviderId);
  const classified = classifyPiAuthEntry(value, piProviderId);
  if (classified.status === "missing")
    return { status: "missing", source, path };
  if (classified.status === "invalid")
    return { status: "invalid", source, path };
  const key =
    classified.entry.type === "api_key"
      ? usableLiteralSecret(classified.entry.key)
      : undefined;
  return key
    ? { status: "available", key, source, path }
    : { status: "invalid", source, path };
}

export function createMimoAdapter(
  overrides: Partial<MimoDependencies> = {},
): ProviderAdapter {
  const dependencies: MimoDependencies = {
    credential: () => resolveMimoCredentials(),
    now: Date.now,
    ...overrides,
  };
  return {
    id: "mimo",
    label: LABEL,
    fetchQuota: () => fetchQuotaWithDependencies(dependencies),
    inspectAuth: () => inspectAuthWithDependencies(dependencies),
  };
}

export const mimoAdapter = createMimoAdapter();

async function fetchQuotaWithDependencies(
  dependencies: MimoDependencies,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];
  let failure: KeyCredentialFailure | undefined;

  for (const resolution of dependencies.credential()) {
    if (resolution.status === "available") {
      attempts.push({ source: resolution.source, status: "success" });

      // MiMo's provider-owned Pi setup establishes API-key authentication,
      // while its quota display is dashboard/cookie based. Do not attach
      // cookies or probe an inference endpoint merely to manufacture a quota
      // reading.
      return {
        provider: "mimo",
        label: LABEL,
        source: "api",
        windows: [],
        state: {
          status: "fresh",
          stale: false,
          authStatus: "usable",
          refreshedAt: new Date(dependencies.now()).toISOString(),
          sourcesTried: sourceNames(attempts),
        },
        attempts,
      };
    }

    const local = keyCredentialFailure("mimo", resolution);
    attempts.push({
      source: resolution.source,
      status: resolution.status === "missing" ? "skipped" : "failed",
      error: local.error,
      // Not genuinely absent: a present-but-unusable entry, and an auth store
      // that exists but could not be read (README source-attempt contract).
      ...(resolution.status === "invalid" || resolution.status === "error"
        ? { credentialPresent: true }
        : {}),
    });
    failure = preferCredentialFailure(failure, local);
  }

  const final = failure ?? {
    status: "auth_required" as const,
    error: "mimo_credential_unavailable",
  };
  return failedProvider({
    provider: "mimo",
    label: LABEL,
    status: final.status,
    error: final.error,
    source: "unavailable",
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

async function inspectAuthWithDependencies(
  dependencies: MimoDependencies,
): Promise<AuthProviderReport> {
  const report = inspectEnvPiAuth("mimo", dependencies.credential());
  // `credentialPresent` marks every source that is not genuinely absent, so
  // `auth` and the quota path agree on a present-but-unusable Pi entry and on
  // an auth store that exists but could not be read.
  return {
    ...report,
    sources: report.sources.map((source) =>
      source.status === "available" ||
      source.status === "invalid" ||
      source.status === "error"
        ? { ...source, credentialPresent: true }
        : source,
    ),
  };
}
