/**
 * The account hierarchy of one marketplace: root -> resellers -> customers (terms in GLOSSARY.md). One Accounts per
 * Marketplace, so its caches (root ID, name-search directory) live and die with the marketplace instead of the module.
 *
 * Lookups throw NotFoundError only when the API says the account isn't in this marketplace; timeouts and outages are
 * thrown as they are, so the user sees the real cause.
 */
import type { LcmpPort } from "./client.js";
import { NotFoundError, lookup, optional } from "./errors.js";
import { type Rec, str } from "./reports.js";

export type AccountRole = "root" | "reseller" | "customer";

const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;

export const first = (data: unknown): Rec | undefined =>
  Array.isArray(data) ? (data[0] as Rec | undefined) : data && typeof data === "object" ? (data as Rec) : undefined;

const asList = (data: unknown): Rec[] => (Array.isArray(data) ? (data as Rec[]) : data && typeof data === "object" ? [data as Rec] : []);

/** One compact row per account, for lists (a country's full reseller records are ~200k characters). */
export function accountRow(a: Rec) {
  return {
    accountId: a.AccountId,
    name: a.CompanyName,
    type: a.AccountType ?? null,
    state: a.AccountState ?? null,
    vatId: a.VATID ?? null,
    country: a.Country ?? null,
    currency: a.Currency ?? null,
    billingStartDate: a.BillingStartDate ?? null,
  };
}

/** One account's key details: its row plus where it sits and how to reach it. */
export function accountSummary(a: Rec) {
  return { ...accountRow(a), parentAccountId: a.ParentAccountId ?? null, email: a.Email ?? null };
}

/** Customer rows carry the reseller they were listed under. */
export type DirectoryCustomer = Rec & { _resellerName: unknown; _resellerAccountId: unknown };

export interface Directory {
  at: number;
  resellers: Rec[];
  customers?: DirectoryCustomer[];
  /** Resellers whose customer list could not be loaded, so name search may miss their customers. */
  failedResellers?: number;
}

export interface SearchResult {
  matches: Rec[];
  /** Problems that may have hidden matches (failed VAT lookups, resellers whose customers didn't load). */
  warnings: string[];
}

const norm = (s: unknown) => str(s).toLowerCase().replace(/[\s.\-_/]/g, "");

export class Accounts {
  private rootIdPromise: Promise<number> | undefined;
  private directoryCache: Directory | undefined;
  private resellersLoad: Promise<Directory> | undefined;
  private customersLoad: Promise<void> | undefined;

  constructor(
    private readonly client: LcmpPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** The marketplace's root account ID (the API user's own company). Fetched once. */
  rootId(): Promise<number> {
    this.rootIdPromise ??= (async () => {
      const id = Number(first(await this.client.call("GetCompany", {}))?.AccountId);
      if (!id) throw new Error("Could not determine the marketplace root account.");
      return id;
    })().catch((err) => {
      this.rootIdPromise = undefined; // don't cache a failure
      throw err;
    });
    return this.rootIdPromise;
  }

  /**
   * Gets a customer or reseller account by ID. Throws NotFoundError when it isn't in this marketplace. GetReseller is
   * only tried when GetCompany says "not here": on a timeout the user shouldn't wait twice.
   */
  async get(accountId: number): Promise<Rec> {
    try {
      const company = first(await lookup(this.client.call("GetCompany", { accountId })));
      if (company?.AccountId !== undefined) return company;
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
    }
    const reseller = first(await lookup(this.client.call("GetReseller", { accountId })));
    if (reseller?.AccountId !== undefined) return reseller;
    throw new NotFoundError();
  }

  /** Like get, but undefined when the account isn't in this marketplace. */
  find(accountId: number): Promise<Rec | undefined> {
    return optional(this.get(accountId));
  }

  /** Every customer and reseller with this exact VAT ID. Only "not here" counts as no match; other errors throw. */
  async allByVat(vatId: string): Promise<Rec[]> {
    const [companies, resellers] = await Promise.all(
      ["GetCompanyByVatId", "GetResellerByVatId"].map((op) => optional(lookup(this.client.call(op, { vatId })))),
    );
    const seen = new Map<string, Rec>();
    for (const a of [...asList(companies), ...asList(resellers)]) if (a.AccountId !== undefined) seen.set(str(a.AccountId), a);
    return [...seen.values()];
  }

  /**
   * The one account with this VAT ID. Several accounts can share a VAT ID (a short VAT ID returned 80 on CYMA), so more
   * than one match is an error that lists them, instead of silently picking the first.
   */
  async byVat(vatId: string): Promise<Rec> {
    const list = await this.allByVat(vatId);
    if (list.length === 1) return list[0];
    if (list.length > 1) {
      const shown = list.slice(0, 10).map((a) => `${a.AccountId} ${a.CompanyName}`).join("; ");
      throw new Error(`${list.length} accounts have VAT ID "${vatId}": ${shown}${list.length > 10 ? "; ..." : ""}. Ask which one, then use its accountId.`);
    }
    throw new NotFoundError(`No account with VAT ID "${vatId}".`);
  }

  /** Root, reseller or customer. The platform labels the root a reseller too, so the root is told apart by its ID. */
  async role(account: Rec): Promise<AccountRole> {
    if (Number(account.AccountId) === (await this.rootId())) return "root";
    return str(account.AccountType).toLowerCase() === "reseller" ? "reseller" : "customer";
  }

  /** A customer's reseller (its parent account); undefined for resellers, the root, or when it can't be found. */
  async resellerOf(account: Rec): Promise<Rec | undefined> {
    if ((await this.role(account)) !== "customer" || !account.ParentAccountId) return undefined;
    return this.find(Number(account.ParentAccountId));
  }

  /**
   * Cached list of the marketplace's resellers (and, on demand, all their customers), for name search. Building the
   * customer list makes one GetCompanies call per reseller, so it is slow the first time; it is then kept for 6 hours.
   * Concurrent searches share one build.
   */
  async directory(withCustomers: boolean): Promise<Directory> {
    let dir = this.directoryCache;
    if (!dir || this.now() - dir.at > DIRECTORY_TTL_MS) {
      this.resellersLoad ??= (async () => {
        const resellers = await this.client.call("GetCompanies", { parentAccountId: await this.rootId() }, "heavy");
        const fresh: Directory = { at: this.now(), resellers: Array.isArray(resellers) ? (resellers as Rec[]) : [] };
        this.directoryCache = fresh;
        return fresh;
      })().finally(() => (this.resellersLoad = undefined));
      dir = await this.resellersLoad;
    }
    // A crawl with failed resellers is used once but not kept, so the next search tries those resellers again.
    if (withCustomers && (!dir.customers || dir.failedResellers)) {
      const target = dir;
      this.customersLoad ??= (async () => {
        let failed = 0;
        // One call per reseller: the client's bulk lane caps how many run at once, so quick lookups stay responsive.
        const lists = await Promise.all(
          target.resellers.map(async (r) => {
            try {
              const companies = await this.client.call("GetCompanies", { parentAccountId: r.AccountId }, "bulk");
              return asList(companies).map((c) => ({ ...c, _resellerName: r.CompanyName, _resellerAccountId: r.AccountId }));
            } catch {
              failed++;
              return [];
            }
          }),
        );
        target.customers = lists.flat();
        target.failedResellers = failed;
      })().finally(() => (this.customersLoad = undefined));
      await this.customersLoad;
    }
    return dir;
  }

  /**
   * Finds resellers and customers by account ID, exact VAT ID, or (part of) the company name. An all-digit query can
   * be an account ID or a VAT ID (e.g. Greek VAT numbers), so the ID is tried first. A failed VAT lookup doesn't hide
   * name matches, but it is reported as a warning, and thrown when nothing else matched.
   */
  async search(query: string, includeCustomers: boolean): Promise<SearchResult> {
    const q = query.trim();
    if (/^\d+$/.test(q)) {
      const a = await this.find(Number(q));
      if (a) return { matches: [accountSummary(a)], warnings: [] };
    }
    const matches = new Map<string, Rec>();
    const add = (a: Rec, extra: Rec = {}) => {
      if (a.AccountId !== undefined) matches.set(str(a.AccountId), { ...accountSummary(a), ...extra });
    };
    const warnings: string[] = [];
    let vatError: unknown;
    try {
      for (const a of await this.allByVat(q)) add(a);
    } catch (err) {
      vatError = err;
      warnings.push(`VAT ID lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const dir = await this.directory(includeCustomers);
    const nq = norm(q);
    // Names match on substring; VAT IDs only exactly (short or placeholder VATs are shared by many accounts).
    const hit = (a: Rec) => norm(a.CompanyName).includes(nq) || (!!norm(a.VATID) && norm(a.VATID) === nq);
    for (const r of dir.resellers) if (hit(r)) add(r, { type: r.AccountType ?? "Reseller" });
    for (const c of dir.customers ?? [])
      if (hit(c)) add(c, { type: c.AccountType ?? "Company", resellerName: c._resellerName, resellerAccountId: c._resellerAccountId });
    if (dir.failedResellers) warnings.push(`Customer lists of ${dir.failedResellers} resellers could not be loaded; some customers may be missing.`);
    if (!matches.size && vatError) throw vatError;
    return { matches: [...matches.values()], warnings };
  }
}
