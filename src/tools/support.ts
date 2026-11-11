/**
 * Support lookups, one country marketplace per call: find an account, summarise a customer, explain a subscription,
 * and pull a customer's invoice lines. All read-only.
 *
 * Account hierarchy per country marketplace: distributor root (the API user's own company)
 * -> resellers (GetCompanies(root)) -> customer companies (GetCompanies(reseller)) -> subscriptions / users.
 * Invoices are issued to resellers; each charge line names the end customer and the subscription AccountId.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LcmpClient } from "../client.js";
import { type MarketplaceRegistry, NotFoundError } from "../marketplaces.js";
import { HEAVY_TIMEOUT_MS, type Rec, mapLimit, str } from "../reports.js";
import { type SubscriptionView, describeSubscription, fetchSubscriptions } from "../subscription.js";
import { registerCompositeTool } from "./helpers.js";

const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MATCHES = 25;
/** Active subscriptions fetched one by one for their end dates in get_customer_overview. */
const MAX_DETAILED_SUBSCRIPTIONS = 50;

const first = (data: unknown): Rec | undefined =>
  Array.isArray(data) ? (data[0] as Rec | undefined) : data && typeof data === "object" ? (data as Rec) : undefined;

/** Calls an operation and returns undefined instead of throwing (for optional sections and probing). */
async function tryCall(client: LcmpClient, op: string, body: Rec, timeoutMs?: number): Promise<unknown> {
  try {
    return await client.call(op, body, timeoutMs);
  } catch {
    return undefined;
  }
}

/**
 * API errors that mean "this account isn't in this marketplace", as opposed to timeouts or outages. Observed on the
 * live API: unknown IDs give "Invalid account id"; accounts of another country give "Not enough permissions to get
 * account details"; subscriptions outside the user's tree give "Not enough permissions to execute ... for the AccountId".
 */
const NOT_FOUND =
  /invalid account|not found|does not exist|not enough permissions to get account details|not enough permissions to execute .* for the accountid/i;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs a lookup; turns the API's "not in this marketplace" errors into NotFoundError, rethrows anything else. */
async function lookup<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (NOT_FOUND.test(message(err))) throw new NotFoundError(message(err));
    throw err;
  }
}

/**
 * Gets a company or reseller account by ID. Throws NotFoundError when the account isn't in this marketplace; any
 * other failure (timeout, outage) is thrown as is, so the user sees the real cause.
 */
async function getAccount(client: LcmpClient, accountId: number): Promise<Rec> {
  try {
    const company = first(await lookup(client.call("GetCompany", { accountId })));
    if (company?.AccountId !== undefined) return company;
  } catch (err) {
    // Only try GetReseller when GetCompany says "not here"; on a timeout, don't make the user wait twice.
    if (!(err instanceof NotFoundError)) throw err;
  }
  const reseller = first(await lookup(client.call("GetReseller", { accountId })));
  if (reseller?.AccountId !== undefined) return reseller;
  throw new NotFoundError();
}

/** For optional lookups (a parent reseller, a subscription's customer): undefined instead of NotFoundError. */
async function optional<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof NotFoundError) return undefined;
    throw err;
  }
}

/**
 * Finds one account by VAT ID. Several accounts can share a VAT ID (a short VAT ID returned 80 on CYMA), so more
 * than one match is an error that lists them, instead of silently picking the first.
 */
async function accountByVat(client: LcmpClient, vatId: string): Promise<Rec> {
  for (const op of ["GetCompanyByVatId", "GetResellerByVatId"]) {
    const result = await optional(lookup(client.call(op, { vatId })));
    const list = (Array.isArray(result) ? result : result ? [result] : []) as Rec[];
    if (list.length === 1) return list[0];
    if (list.length > 1) {
      const shown = list.slice(0, 10).map((a) => `${a.AccountId} ${a.CompanyName}`).join("; ");
      throw new Error(`${list.length} accounts have VAT ID "${vatId}": ${shown}${list.length > 10 ? "; ..." : ""}. Ask which one, then use its accountId.`);
    }
  }
  throw new NotFoundError(`No account with VAT ID "${vatId}".`);
}

function accountSummary(a: Rec) {
  return {
    accountId: a.AccountId,
    type: a.AccountType ?? null,
    name: a.CompanyName,
    vatId: a.VATID ?? null,
    country: a.Country ?? null,
    state: a.AccountState ?? null,
    currency: a.Currency ?? null,
    parentAccountId: a.ParentAccountId ?? null,
    email: a.Email ?? null,
    billingStartDate: a.BillingStartDate ?? null,
  };
}

interface Directory {
  at: number;
  rootId: number;
  resellers: Rec[];
  customers?: Rec[];
  /** Resellers whose customer list could not be loaded, so name search may miss their customers. */
  failedResellers?: number;
}
const directories = new Map<string, Directory>();
/** In-flight builds, so concurrent searches in one marketplace share a single build instead of each crawling. */
const resellerLoads = new Map<string, Promise<Directory>>();
const customerLoads = new Map<string, Promise<void>>();

function shared<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = map.get(key);
  if (!p) {
    p = load().finally(() => map.delete(key));
    map.set(key, p);
  }
  return p;
}

/**
 * Cached list of a marketplace's resellers (and, on demand, all their customers). Building the customer list
 * makes one GetCompanies call per reseller, so it is slow the first time; it is then cached for 6 hours.
 */
async function getDirectory(code: string, client: LcmpClient, withCustomers: boolean): Promise<Directory> {
  let dir = directories.get(code);
  if (!dir || Date.now() - dir.at > DIRECTORY_TTL_MS) {
    dir = await shared(resellerLoads, code, async () => {
      const root = first(await client.call("GetCompany", {}));
      const rootId = Number(root?.AccountId);
      if (!rootId) throw new Error("Could not determine the marketplace root account.");
      const resellers = (await client.call("GetCompanies", { parentAccountId: rootId }, HEAVY_TIMEOUT_MS)) as Rec[] | null;
      const fresh: Directory = { at: Date.now(), rootId, resellers: Array.isArray(resellers) ? resellers : [] };
      directories.set(code, fresh);
      return fresh;
    });
  }
  // A crawl with failed resellers is used once but not kept, so the next search tries those resellers again.
  if (withCustomers && (!dir.customers || dir.failedResellers)) {
    const target = dir;
    await shared(customerLoads, code, async () => {
      let failed = 0;
      const lists = await mapLimit(target.resellers, 4, async (r) => {
        const companies = (await tryCall(client, "GetCompanies", { parentAccountId: r.AccountId })) as Rec[] | undefined;
        if (companies === undefined) failed++;
        return (Array.isArray(companies) ? companies : []).map((c) => ({
          ...c,
          _resellerName: r.CompanyName,
          _resellerAccountId: r.AccountId,
        }));
      });
      target.customers = lists.flat();
      target.failedResellers = failed;
    });
  }
  return dir;
}

/**
 * Invoice downloads cover the whole marketplace and take minutes (~3 min for CYMA's last closed month), so they are
 * cached: a closed month doesn't change (6 h), the preview month does (15 min). Concurrent requests share a download.
 */
const invoiceCache = new Map<string, { at: number; ttl: number; data: Rec[] }>();
const invoiceLoads = new Map<string, Promise<Rec[]>>();

async function getInvoices(code: string, client: LcmpClient, op: string, body: Rec): Promise<{ data: Rec[]; cachedAt: number }> {
  const key = `${code}|${op}|${JSON.stringify(body)}`;
  const hit = invoiceCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return { data: hit.data, cachedAt: hit.at };
  const data = await shared(invoiceLoads, key, async () => {
    const result = (await client.call(op, body, HEAVY_TIMEOUT_MS)) as Rec[] | null;
    const list = Array.isArray(result) ? result : [];
    // Each entry is a whole country's month of invoices: drop expired ones so memory doesn't keep growing.
    for (const [k, v] of invoiceCache) if (Date.now() - v.at >= v.ttl) invoiceCache.delete(k);
    invoiceCache.set(key, { at: Date.now(), ttl: op === "GetPreviewInvoices" ? 15 * 60_000 : DIRECTORY_TTL_MS, data: list });
    return list;
  });
  return { data, cachedAt: invoiceCache.get(key)?.at ?? Date.now() };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Sums sales price and cost per (key, currency), largest first. */
function totalsBy(lines: Rec[], key: (l: Rec) => string, limit: number) {
  const groups = new Map<string, { name: string; currency: string; lines: number; salesPrice: number; cost: number }>();
  for (const l of lines) {
    const name = key(l) || "(none)";
    const currency = str(l.currency) || "?";
    const g = groups.get(name + "|" + currency) ?? { name, currency, lines: 0, salesPrice: 0, cost: 0 };
    g.lines++;
    g.salesPrice += Number(l.salesPrice) || 0;
    g.cost += Number(l.cost) || 0;
    groups.set(name + "|" + currency, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, salesPrice: round2(g.salesPrice), cost: round2(g.cost) }))
    .sort((a, b) => b.salesPrice - a.salesPrice)
    .slice(0, limit);
}

const norm = (s: unknown) => str(s).toLowerCase().replace(/[\s.\-_/]/g, "");

/** A subscription row in get_customer_overview: the shared view without the per-subscription notes. */
function subscriptionRow({ notes: _notes, ...view }: SubscriptionView) {
  return view;
}

export function registerSupportTools(server: McpServer, registry: MarketplaceRegistry): void {
  registerCompositeTool(server, registry, {
    name: "find_account",
    title: "Find a reseller or customer",
    description:
      "Find resellers and customer companies in one marketplace by account ID, VAT ID or (part of) the company name. " +
      "Returns each match with its reseller. Name search over customers lists every reseller's customers the first time " +
      "per marketplace (can take a minute or two; cached for 6 hours). If the country is unknown, ask the user.",
    input: {
      query: z.string().min(2).describe("Account ID, VAT ID, or part of the company name."),
      includeCustomers: z
        .boolean()
        .optional()
        .describe("Also search customer companies by name, not just resellers (default true)."),
    },
    run: async ({ query, includeCustomers = true }, client, m) => {
      const q = query.trim();
      // All digits can be an account ID or a VAT ID (e.g. Greek VAT numbers): try the ID first, then search on.
      if (/^\d+$/.test(q)) {
        const a = await optional(getAccount(client, Number(q)));
        if (a) return { matches: [accountSummary(a)] };
      }
      const matches = new Map<string, Rec>();
      const add = (a: Rec | undefined, extra: Rec = {}) => {
        if (a?.AccountId !== undefined) matches.set(str(a.AccountId), { ...accountSummary(a), ...extra });
      };
      // Exact VAT lookups are cheap, so always try them.
      add(first(await tryCall(client, "GetResellerByVatId", { vatId: q })));
      add(first(await tryCall(client, "GetCompanyByVatId", { vatId: q })));

      const dir = await getDirectory(m.code, client, includeCustomers);
      const nq = norm(q);
      // Names match on substring; VAT IDs only exactly (short or placeholder VATs are shared by many accounts).
      const hit = (a: Rec) => norm(a.CompanyName).includes(nq) || (!!norm(a.VATID) && norm(a.VATID) === nq);
      for (const r of dir.resellers) if (hit(r)) add(r, { type: r.AccountType ?? "Reseller" });
      for (const c of dir.customers ?? [])
        if (hit(c))
          add(c, { type: c.AccountType ?? "Company", resellerName: c._resellerName, resellerAccountId: c._resellerAccountId });
      const list = [...matches.values()];
      if (!list.length) return undefined;
      return {
        matches: list.slice(0, MAX_MATCHES),
        ...(list.length > MAX_MATCHES ? { note: `${list.length} matches; showing the first ${MAX_MATCHES}. Refine the query.` } : {}),
        ...(dir.failedResellers
          ? { warning: `Customer lists of ${dir.failedResellers} resellers could not be loaded; some customers may be missing.` }
          : {}),
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "get_customer_overview",
    title: "Customer overview",
    description:
      "One-call summary of a customer company or reseller: account details, its reseller, credit limit, users and " +
      "subscriptions (service, CSP model NCE/Legacy, state, provisioning status/errors, end date, days left, urgency and " +
      "end-date action). For a reseller, lists its customers instead of subscriptions. " +
      "Urgency: 'past_end_date' (<0 days left), 'urgent' (0-31), 'soon' (32-60), 'later'.",
    input: {
      accountId: z.number().int().optional().describe("Company or reseller Account ID."),
      vatId: z.string().optional().describe("VAT ID, if the Account ID is not known."),
    },
    run: async ({ accountId, vatId }, client, m) => {
      if (accountId === undefined && !vatId) throw new Error("Give accountId or vatId (use find_account to search by name).");
      const account = accountId !== undefined ? await getAccount(client, accountId) : await accountByVat(client, vatId!);
      const id = Number(account.AccountId);
      const isReseller = str(account.AccountType).toLowerCase() === "reseller";
      const errors: string[] = [];
      const section = async <T>(label: string, p: Promise<T>): Promise<T | undefined> => {
        try {
          return await p;
        } catch (err) {
          errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
          return undefined;
        }
      };

      const [parent, credit, users, subs, customers] = await Promise.all([
        !isReseller && account.ParentAccountId ? optional(getAccount(client, Number(account.ParentAccountId))) : undefined,
        section("credit limit", client.call("GetCreditLimit", { accountId: id })),
        section("users", client.call("GetUsers", { companyAccountId: id })),
        isReseller ? undefined : section("subscriptions", client.call("GetSubscriptions", { parentAccountId: id }, HEAVY_TIMEOUT_MS)),
        isReseller ? section("customers", client.call("GetCompanies", { parentAccountId: id }, HEAVY_TIMEOUT_MS)) : undefined,
      ]);

      const userList = (Array.isArray(users) ? (users as Rec[]) : []).map((u) => ({
        accountId: u.AccountId,
        name: [u.FirstName, u.LastName].filter(Boolean).join(" "),
        username: u.Username,
        email: u.Email,
        state: u.AccountState,
        lastLogon: u.LastLogon ?? null,
      }));
      // The list call has no end dates, so fetch each active subscription (capped) for its term.
      const listed = Array.isArray(subs) ? (subs as Rec[]) : [];
      const active = listed.filter((s) => s.AccountState !== "Terminated").slice(0, MAX_DETAILED_SUBSCRIPTIONS);
      const fetched = await fetchSubscriptions(client, active.map((s) => Number(s.AccountId)));
      const detailed = new Map<string, Rec>();
      fetched.forEach((full, i) => {
        if (full instanceof Error) errors.push(`subscription ${str(active[i].AccountId)} details: ${full.message}`);
        else if (full) detailed.set(str(active[i].AccountId), full);
      });
      const subList = listed.map((s) => subscriptionRow(describeSubscription(detailed.get(str(s.AccountId)) ?? s, m.timeZone)));
      subList.sort((a, b) => (a.state === b.state ? (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) : a.state === "Active" ? -1 : 1));
      const customerList = (Array.isArray(customers) ? (customers as Rec[]) : []).map((c) => ({
        accountId: c.AccountId,
        name: c.CompanyName,
        vatId: c.VATID ?? null,
        state: c.AccountState ?? null,
      }));

      return {
        account: accountSummary(account),
        ...(parent ? { reseller: { accountId: parent.AccountId, name: parent.CompanyName, vatId: parent.VATID ?? null } } : {}),
        creditLimit: credit ?? null,
        ...(isReseller
          ? { customerCount: customerList.length, customers: customerList.slice(0, 200) }
          : {
              subscriptionSummary: {
                total: subList.length,
                active: subList.filter((s) => s.state === "Active").length,
                withErrors: subList.filter((s) => s.errorDetails).length,
                activeUrgent: subList.filter((s) => s.state === "Active" && s.urgency === "urgent").length,
                activePastEndDate: subList.filter((s) => s.state === "Active" && s.urgency === "past_end_date").length,
                scheduledForTermination: subList.filter((s) => s.scheduledTerminationDate).length,
              },
              subscriptions: subList,
            }),
        userCount: userList.length,
        users: userList.slice(0, 100),
        ...(errors.length ? { errors } : {}),
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "get_subscription_status",
    title: "Subscription status",
    description:
      "Explain one subscription: service, CSP model (NCE/Legacy), state and provisioning status (with vendor error " +
      "details), end date (price-protection end, else advance-period end, else the Subscriptionenddate field, else the " +
      "contract end date), days left, urgency, the stored end-date action and the effective one (Legacy monthly " +
      "subscriptions always renew), scheduled termination, vendor references, product fields and add-ons, plus the " +
      "customer and reseller it belongs to.",
    input: { accountId: z.number().int().describe("The subscription Account ID.") },
    run: async ({ accountId }, client, m) => {
      const sub = first(
        (await tryCall(client, "GetSubscriptionWithAddons", { accountId })) ?? (await lookup(client.call("GetSubscription", { accountId }))),
      );
      if (!sub?.AccountId) return undefined;
      const company = sub.CompanyAccountId ? await optional(getAccount(client, Number(sub.CompanyAccountId))) : undefined;
      const reseller = company?.ParentAccountId ? await optional(getAccount(client, Number(company.ParentAccountId))) : undefined;
      const fields = Array.isArray(sub.Fields) ? Object.fromEntries((sub.Fields as Rec[]).map((f) => [str(f.Name), f.Value])) : {};
      const { notes: viewNotes, ...view } = describeSubscription(sub, m.timeZone);

      const notes: string[] = [];
      if (view.errorDetails) notes.push("Provisioning failed: see errorDetails. Retrying is done in the Marketplace UI (RetryLastFailedProvisioning).");
      if (view.scheduledTerminationDate) notes.push(`Termination is scheduled for ${view.scheduledTerminationDate}.`);
      notes.push(...viewNotes);

      return {
        ...view,
        hasRenewActionValuesConfigured: sub.HasRenewActionValuesConfigured ?? null,
        priceProtectionEndDate: sub.PriceProtectionEndDate ?? null,
        advancePeriodEndDate: sub.AdvancePeriodEndDate ?? null,
        contractEndDate: sub.ContractEndDate ?? null,
        billingStartDate: sub.BillingStartDate ?? null,
        vendorReferenceId: sub.VendorReferenceId ?? null,
        secondVendorReferenceId: sub.SecondVendorReferenceId ?? null,
        purchaseOrderNumber: sub.PurchaseOrderNumber ?? null,
        parentAccountId: sub.ParentAccountId,
        parentType: sub.ParentType ?? null,
        dependency: sub.DependencyAccountId ? { accountId: sub.DependencyAccountId, service: sub.DependencyServiceName } : null,
        customer: company ? { accountId: company.AccountId, name: company.CompanyName, vatId: company.VATID ?? null } : null,
        reseller: reseller ? { accountId: reseller.AccountId, name: reseller.CompanyName } : null,
        fields,
        addons: sub.Addons ?? null,
        notes,
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "get_customer_invoices",
    title: "Invoices for a customer or reseller",
    description:
      "Invoice lines for one account. Invoices are issued to resellers: for a reseller this returns its invoices; for a " +
      "customer company it returns the lines of its subscriptions (matched by subscription ID, else by end-customer name) " +
      "across its reseller's invoices. Period: last closed month (default), a given year/month, or the current preview. " +
      "Returns totals per currency, per service and (for a reseller) per end customer, then the individual lines up to " +
      "maxLines. The first request per period downloads the whole marketplace's invoices (can take ~3 minutes); it is " +
      "then cached (closed months 6 h, preview 15 min).",
    input: {
      accountId: z.number().int().describe("Customer company or reseller Account ID."),
      year: z.number().int().min(2000).max(2100).optional().describe("Billing year (with month)."),
      month: z.number().int().min(1).max(12).optional().describe("Billing month 1-12 (with year)."),
      preview: z.boolean().optional().describe("Use the current, not yet closed month instead."),
      endCustomer: z.string().optional().describe("For a reseller: only lines whose end customer name contains this text."),
      maxLines: z.number().int().min(0).max(1000).optional().describe("Individual lines to include (default 100; totals always cover all lines)."),
    },
    run: async ({ accountId, year, month, preview, endCustomer, maxLines = 100 }, client, m) => {
      const account = await getAccount(client, accountId);
      if ((year === undefined) !== (month === undefined)) throw new Error("Give both year and month, or neither.");
      const isReseller = str(account.AccountType).toLowerCase() === "reseller";
      const [op, body] = preview
        ? ["GetPreviewInvoices", {}]
        : year !== undefined
          ? ["GetLatestInvoicesForPeriod", { year, month }]
          : ["GetLatestInvoices", {}];
      const { data: all, cachedAt } = await getInvoices(m.code, client, op, body);

      let subscriptionIds = new Set<string>();
      if (!isReseller) {
        const subs = (await tryCall(client, "GetSubscriptions", { parentAccountId: accountId }, HEAVY_TIMEOUT_MS)) as Rec[] | undefined;
        subscriptionIds = new Set((Array.isArray(subs) ? subs : []).map((s) => str(s.AccountId)));
      }
      const customerName = norm(account.CompanyName);
      const endCustomerFilter = endCustomer ? norm(endCustomer) : undefined;

      const lines: Rec[] = [];
      for (const inv of all) {
        const ownInvoice = isReseller && str(inv.CompanyAccountId) === str(accountId);
        const charges = Array.isArray(inv.Charges) ? (inv.Charges as Rec[]) : [];
        for (const c of charges) {
          const match =
            ownInvoice ||
            (!isReseller && (subscriptionIds.has(str(c.AccountId)) || (!!customerName && norm(c.EndCustomerName) === customerName)));
          if (!match) continue;
          if (endCustomerFilter && !norm(c.EndCustomerName).includes(endCustomerFilter)) continue;
          lines.push({
            invoiceNumber: inv.InvoiceNumber,
            billingInterval: inv.BillingInterval,
            invoicedTo: inv.CompanyName,
            endCustomer: c.EndCustomerName ?? null,
            subscriptionAccountId: c.AccountId,
            service: c.ServiceName,
            item: c.PriceableItemDescription,
            billableParameter: c.BillableParameter ?? null,
            chargeInterval: c.ActualChargeInterval ?? null,
            salesPrice: c.SalesPrice ?? null,
            cost: c.Costs ?? null,
            currency: c.Currency ?? null,
          });
        }
      }
      lines.sort((a, b) => (Number(b.salesPrice) || 0) - (Number(a.salesPrice) || 0));
      return {
        account: { accountId, name: account.CompanyName, type: account.AccountType ?? null },
        source: op,
        dataAsOf: new Date(cachedAt).toISOString(),
        invoicesScanned: all.length,
        lineCount: lines.length,
        totals: totalsBy(lines, () => "all", 10).map(({ name, ...t }) => t),
        byService: totalsBy(lines, (l) => str(l.service), 25),
        ...(isReseller ? { byEndCustomer: totalsBy(lines, (l) => str(l.endCustomer), 25) } : {}),
        lines: lines.slice(0, maxLines),
        ...(lines.length > maxLines
          ? { note: `Showing the ${maxLines} largest of ${lines.length} lines; totals cover all. Use endCustomer or maxLines to see others.` }
          : {}),
      };
    },
  });
}
