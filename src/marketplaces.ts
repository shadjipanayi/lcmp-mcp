import { Accounts } from "./accounts.js";
import { LcmpClient, type LcmpPort } from "./client.js";
import { NotFoundError } from "./errors.js";
import { Invoices } from "./invoices.js";

/**
 * Country marketplaces: display name and local time zone (for "today" in date-based reports).
 * Codes match the runbooks' Marketplace-API-*-<CODE> credentials.
 */
export const KNOWN_MARKETPLACES: Record<string, { name: string; timeZone: string }> = {
  CYMA: { name: "Cyprus & Malta", timeZone: "Asia/Nicosia" },
  GR: { name: "Greece", timeZone: "Europe/Athens" },
  ENET: { name: "ENET", timeZone: "Europe/Athens" },
  RO: { name: "Romania", timeZone: "Europe/Bucharest" },
  IT: { name: "Italy", timeZone: "Europe/Rome" },
  SA: { name: "KSA", timeZone: "Asia/Riyadh" },
  JO: { name: "Jordan", timeZone: "Asia/Amman" },
  LB: { name: "Lebanon", timeZone: "Asia/Beirut" },
  AE: { name: "UAE", timeZone: "Asia/Dubai" },
  QA: { name: "Qatar", timeZone: "Asia/Qatar" },
  KW: { name: "Kuwait", timeZone: "Asia/Kuwait" },
  OM: { name: "Oman", timeZone: "Asia/Muscat" },
  BH: { name: "Bahrain", timeZone: "Asia/Bahrain" },
  MA: { name: "Morocco", timeZone: "Africa/Casablanca" },
};

/** One country marketplace: its API connection plus the modules (and caches) that belong to it. */
export interface Marketplace {
  code: string;
  name: string;
  timeZone: string;
  client: LcmpPort;
  accounts: Accounts;
  invoices: Invoices;
}

/** Builds a marketplace around an API connection; a fresh marketplace has fresh caches. */
export function createMarketplace(m: { code: string; name: string; timeZone: string; client: LcmpPort }): Marketplace {
  return { ...m, accounts: new Accounts(m.client), invoices: new Invoices(m.client) };
}

/**
 * Loads the configured marketplaces from the environment:
 *   LCMP_BASE_URL                     shared SimpleAPI URL
 *   LCMP_MARKETPLACES=CYMA,GR,...     codes to enable
 *   LCMP_<CODE>_USERNAME / _PASSWORD  read-only API user for each code
 *   LCMP_MAX_CONCURRENCY              quick API requests in flight per marketplace (default 3)
 * Without LCMP_MARKETPLACES, LCMP_USERNAME / LCMP_PASSWORD configure a single marketplace (LCMP_MARKETPLACE, default "DEFAULT").
 */
export function loadMarketplaces(env: NodeJS.ProcessEnv = process.env): Marketplace[] {
  const baseUrl = env.LCMP_BASE_URL?.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("Missing required environment variable LCMP_BASE_URL (see .env.example).");
  const timeout = Number(env.LCMP_TIMEOUT_MS ?? 30_000);
  const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 30_000;
  const maxConcurrency = Number(env.LCMP_MAX_CONCURRENCY ?? 3) || 3;

  const make = (code: string, username: string | undefined, password: string | undefined): Marketplace =>
    createMarketplace({
      code,
      name: KNOWN_MARKETPLACES[code]?.name ?? code,
      timeZone: KNOWN_MARKETPLACES[code]?.timeZone ?? "UTC",
      client: new LcmpClient({ baseUrl, username: username!.trim(), password: password!, timeoutMs, maxConcurrency }),
    });

  const codes = (env.LCMP_MARKETPLACES ?? "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);

  if (!codes.length) {
    if (!env.LCMP_USERNAME?.trim() || !env.LCMP_PASSWORD) {
      throw new Error("Set LCMP_MARKETPLACES with LCMP_<CODE>_USERNAME/PASSWORD, or LCMP_USERNAME/LCMP_PASSWORD (see .env.example).");
    }
    const code = (env.LCMP_MARKETPLACE ?? "DEFAULT").trim().toUpperCase();
    return [make(code, env.LCMP_USERNAME, env.LCMP_PASSWORD)];
  }

  const missing = codes.flatMap((c) =>
    [`LCMP_${c}_USERNAME`, `LCMP_${c}_PASSWORD`].filter((k) => !env[k]?.trim()),
  );
  if (missing.length) throw new Error(`Missing environment variable(s): ${missing.join(", ")}.`);
  return codes.map((c) => make(c, env[`LCMP_${c}_USERNAME`], env[`LCMP_${c}_PASSWORD`]));
}

/**
 * Holds one API client per country marketplace. Every call targets exactly one marketplace: there is no
 * fan-out across countries, to keep load on the API predictable.
 */
export class MarketplaceRegistry {
  constructor(readonly marketplaces: Marketplace[]) {}

  get single(): Marketplace | undefined {
    return this.marketplaces.length === 1 ? this.marketplaces[0] : undefined;
  }

  get codes(): [string, ...string[]] {
    return this.marketplaces.map((m) => m.code) as [string, ...string[]];
  }

  /** Human-readable list for tool descriptions, e.g. "CYMA (Cyprus & Malta), GR (Greece)". */
  describe(): string {
    return this.marketplaces.map((m) => (m.name === m.code ? m.code : `${m.code} (${m.name})`)).join(", ");
  }

  /** Resolves a code or display name (case-insensitive). Without one, only works when a single marketplace is configured. */
  resolve(selector: string | undefined): Marketplace {
    if (!selector) {
      if (this.single) return this.single;
      throw new Error(`Specify a marketplace: one of ${this.describe()}.`);
    }
    const w = selector.trim().toLowerCase();
    const m = this.marketplaces.find((x) => x.code.toLowerCase() === w || x.name.toLowerCase() === w);
    if (!m) throw new Error(`Unknown marketplace "${selector}". Configured: ${this.describe()}.`);
    return m;
  }
}

export { NotFoundError };

/**
 * Runs `fn` against the selected marketplace and labels the result with its code. A lookup that returns undefined
 * or throws NotFoundError becomes a "not found in <marketplace>" error that includes the API's message.
 */
export async function runInMarketplace<T>(
  registry: MarketplaceRegistry,
  selector: string | undefined,
  fn: (m: Marketplace) => Promise<T>,
): Promise<{ marketplace: string; data: T }> {
  const m = registry.resolve(selector);
  let data: T;
  let apiMessage: string | undefined;
  try {
    data = await fn(m);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    data = undefined as T;
    apiMessage = err.apiMessage;
  }
  if (data === undefined) {
    throw new Error(
      `Not found in marketplace ${m.code} (${m.name}): the account doesn't exist or belongs to another country. ` +
        "Check the ID or the marketplace." +
        (apiMessage ? ` If both are right, this marketplace's MCP user may lack a permission. API said: "${apiMessage}"` : ""),
    );
  }
  return { marketplace: m.code, data };
}
