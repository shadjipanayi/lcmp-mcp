/**
 * Support lookups, one country marketplace per call: find an account, summarise a customer, explain a subscription,
 * and pull a customer's invoice lines. All read-only.
 *
 * Accounts (root -> resellers -> customers, lookups, name search) come from the marketplace's Accounts module,
 * subscription facts from the Subscription module, invoices from the marketplace's Invoices module.
 * Invoices are issued to resellers; each charge line names the end customer and the subscription AccountId.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { accountSummary, first } from "../accounts.js";
import type { LcmpPort, Workload } from "../client.js";
import { lookup } from "../errors.js";
import type { InvoicePeriod } from "../invoices.js";
import type { MarketplaceRegistry } from "../marketplaces.js";
import { type Rec, settle, str } from "../reports.js";
import { type SubscriptionView, describeSubscription, fetchSubscriptions } from "../subscription.js";
import { registerCompositeTool } from "./helpers.js";

const MAX_MATCHES = 25;
/** Active subscriptions fetched one by one for their end dates in get_customer_overview. */
const MAX_DETAILED_SUBSCRIPTIONS = 50;

/** Calls an operation and returns undefined instead of throwing (for optional sections and probing). */
async function tryCall(client: LcmpPort, op: string, body: Rec, workload?: Workload): Promise<unknown> {
  try {
    return await client.call(op, body, workload);
  } catch {
    return undefined;
  }
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
    run: async ({ query, includeCustomers = true }, _client, m) => {
      const { matches, warnings } = await m.accounts.search(query, includeCustomers);
      if (!matches.length) return undefined;
      return {
        matches: matches.slice(0, MAX_MATCHES),
        ...(matches.length > MAX_MATCHES ? { note: `${matches.length} matches; showing the first ${MAX_MATCHES}. Refine the query.` } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
    },
  });

  registerCompositeTool(server, registry, {
    name: "get_customer_overview",
    title: "Customer overview",
    description:
      "One-call summary of a customer company or reseller: account details, its reseller, credit limit, users and " +
      "subscriptions (service, CSP model NCE/Legacy, state, provisioning status/errors, end date, days left, urgency and " +
      "end-date action). For a reseller, lists its customers instead of subscriptions (for the marketplace root, its " +
      "resellers). Urgency: 'past_end_date' (<0 days left), 'urgent' (0-31), 'soon' (32-60), 'later'.",
    input: {
      accountId: z.number().int().optional().describe("Company or reseller Account ID."),
      vatId: z.string().optional().describe("VAT ID, if the Account ID is not known."),
    },
    run: async ({ accountId, vatId }, client, m) => {
      if (accountId === undefined && !vatId) throw new Error("Give accountId or vatId (use find_account to search by name).");
      const account = accountId !== undefined ? await m.accounts.get(accountId) : await m.accounts.byVat(vatId!);
      const id = Number(account.AccountId);
      const role = await m.accounts.role(account);
      const hasChildren = role !== "customer";
      // Each section is independent: one failing (e.g. a missing permission) doesn't hide the others.
      const [parent, { values, errors }] = await Promise.all([
        m.accounts.resellerOf(account),
        settle({
          "credit limit": client.call("GetCreditLimit", { accountId: id }),
          users: client.call("GetUsers", { companyAccountId: id }),
          subscriptions: hasChildren ? undefined : client.call("GetSubscriptions", { parentAccountId: id }, "heavy"),
          [role === "root" ? "resellers" : "customers"]: hasChildren ? client.call("GetCompanies", { parentAccountId: id }, "heavy") : undefined,
        }),
      ]);
      const credit = values["credit limit"];
      const users = values.users;
      const subs = values.subscriptions;
      const children = values[role === "root" ? "resellers" : "customers"];

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
      const fetched = await fetchSubscriptions(client, active.map((s) => Number(s.AccountId)), "interactive");
      const detailed = new Map<string, Rec>();
      fetched.forEach((full, i) => {
        if (full instanceof Error) errors.push(`subscription ${str(active[i].AccountId)} details: ${full.message}`);
        else if (full) detailed.set(str(active[i].AccountId), full);
      });
      const subList = listed.map((s) => subscriptionRow(describeSubscription(detailed.get(str(s.AccountId)) ?? s, m.timeZone)));
      subList.sort((a, b) => (a.state === b.state ? (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9) : a.state === "Active" ? -1 : 1));
      const childList = (Array.isArray(children) ? (children as Rec[]) : []).map((c) => ({
        accountId: c.AccountId,
        name: c.CompanyName,
        vatId: c.VATID ?? null,
        state: c.AccountState ?? null,
      }));

      return {
        account: { ...accountSummary(account), role },
        ...(parent ? { reseller: { accountId: parent.AccountId, name: parent.CompanyName, vatId: parent.VATID ?? null } } : {}),
        creditLimit: credit ?? null,
        ...(role === "root"
          ? { resellerCount: childList.length, resellers: childList.slice(0, 200) }
          : role === "reseller"
            ? { customerCount: childList.length, customers: childList.slice(0, 200) }
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
      const company = sub.CompanyAccountId ? await m.accounts.find(Number(sub.CompanyAccountId)) : undefined;
      const reseller = company ? await m.accounts.resellerOf(company) : undefined;
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
      const account = await m.accounts.get(accountId);
      if ((year === undefined) !== (month === undefined)) throw new Error("Give both year and month, or neither.");
      const isReseller = (await m.accounts.role(account)) !== "customer";
      const period: InvoicePeriod = preview ? { preview: true } : year !== undefined ? { year, month: month! } : {};
      const { source, data: all, cachedAt } = await m.invoices.get(period);

      let subscriptionIds = new Set<string>();
      if (!isReseller) {
        const subs = (await tryCall(client, "GetSubscriptions", { parentAccountId: accountId }, "heavy")) as Rec[] | undefined;
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
        source,
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
