/**
 * The Subscription module: every rule about what a subscription is and when it ends, in one place.
 * Tools fetch subscriptions here and turn them into a SubscriptionView; they never re-derive the CSP model, end date,
 * end-date action or urgency themselves, so every tool gives the same answer for the same subscription.
 * Terms (CSP model, Legacy monthly, stored/effective end-date action, days left, urgency) are defined in GLOSSARY.md.
 */
import type { LcmpPort, Workload } from "./client.js";
import { type Rec, daysUntil, isoDay, parseDate, str, todayIn } from "./reports.js";

export type CspModel = "NCE" | "Legacy";
export type Urgency = "past_end_date" | "urgent" | "soon" | "later";
export type EndDateSource = "PriceProtectionEndDate" | "AdvancePeriodEndDate" | "Subscriptionenddate field" | "ContractEndDate";

/**
 * CSP model of a product. NCE products carry the literal "(NCE)" in their display name. Only Microsoft CSP licences
 * have a model: Microsoft products' technical names start with "156469_", and tenants, Azure Plans, reserved instances
 * and Azure subscriptions aren't licences. Report rows from the MSCSP reports may omit the technical name; they only
 * hold CSP licences, so a missing technical name counts as a licence.
 *
 * The runbooks match `-match '(NCE)'`, a case-insensitive regex that also matches "nce" inside words such as
 * "Compliance"; that is a runbook bug and deliberately not copied.
 */
export function cspModel(product: { displayName: unknown; technicalName?: unknown }): CspModel | null {
  if (/\(NCE\)/i.test(str(product.displayName))) return "NCE";
  const technical = str(product.technicalName);
  if (technical) {
    if (!technical.startsWith("156469_")) return null;
    if (/tenant|AzurePlan|AzureReserved|AzureRI|AzureSubscription/i.test(technical)) return null;
  }
  return "Legacy";
}

export const isTrial = (billingType: unknown) => /trial/i.test(str(billingType));

/** Monthly-term subscriptions renew every month: NCE "P1M" billing types and Legacy monthly. */
export function hasMonthlyTerm(billingType: unknown, model: CspModel | null, hasAdvancePayment: boolean): boolean {
  if (/P1M|1-month commitment/i.test(str(billingType))) return true;
  return model === "Legacy" && !hasAdvancePayment;
}

/** Whole days from today's date in the marketplace's time zone to `date`; negative once it has passed. */
export function daysLeft(date: Date, timeZone: string, now = new Date()): number {
  return daysUntil(date, parseDate(`${todayIn(timeZone, now)}T00:00:00`)!);
}

/** The runbooks' bands: below 0 past end date, 0-31 urgent, 32-60 soon, over 60 later. */
export function urgency(days: number | null): Urgency | null {
  if (days === null) return null;
  return days < 0 ? "past_end_date" : days <= 31 ? "urgent" : days <= 60 ? "soon" : "later";
}

export interface SubscriptionView {
  accountId: unknown;
  service: unknown;
  vendor: unknown;
  cspModel: CspModel | null;
  /** True/false for Legacy licences when the subscription says so; null when unknown or not Legacy. */
  legacyMonthly: boolean | null;
  billingType: string | null;
  state: unknown;
  status: unknown;
  endDate: string | null;
  endDateSource: EndDateSource | null;
  daysLeft: number | null;
  urgency: Urgency | null;
  storedEndDateAction: string | null;
  effectiveEndDateAction: string | null;
  scheduledTerminationDate: unknown;
  errorDetails: unknown;
  notes: string[];
}

const field = (sub: Rec, name: RegExp): Rec | undefined =>
  (Array.isArray(sub.Fields) ? (sub.Fields as Rec[]) : []).find((f) => name.test(str(f.Name)));

/**
 * Legacy monthly from GetSubscription alone (verified on CYMA): the BillingType product field is "Monthly", and such
 * subscriptions have no advance period (AdvancePeriodEndDate/Action are absent). Prepaid ones say "Annually prepaid"
 * and do have an advance period. When the two signals disagree or are missing, it's unknown.
 */
function isLegacyMonthly(sub: Rec, model: CspModel | null, billingType: string): boolean | null {
  if (model !== "Legacy") return null;
  const hasAdvancePeriod = sub.AdvancePeriodEndDate != null || sub.AdvancePeriodEndAction != null;
  if (/^monthly$/i.test(billingType)) return hasAdvancePeriod ? null : true;
  if (/prepaid|annual/i.test(billingType)) return false;
  return hasAdvancePeriod ? false : null;
}

/**
 * End date using the runbooks' precedence (price-protection end, then advance-period end, then the
 * "Subscriptionenddate" product field), then the contract end date, which the runbooks never need but is the only date
 * on e.g. Azure Plans. Only GetSubscription returns these dates; the GetSubscriptions list does not.
 */
function endDateOf(sub: Rec): { date: Date; source: EndDateSource } | undefined {
  // Exact name: "Subscriptionenddatealignment" is a different date.
  const endField = field(sub, /^subscriptionenddate$/i);
  const candidates: [EndDateSource, unknown][] = [
    ["PriceProtectionEndDate", sub.PriceProtectionEndDate],
    ["AdvancePeriodEndDate", sub.AdvancePeriodEndDate],
    ["Subscriptionenddate field", endField?.Value ?? endField?.Date],
    ["ContractEndDate", sub.ContractEndDate],
  ];
  for (const [source, value] of candidates) {
    const date = parseDate(value);
    if (date) return { date, source };
  }
  return undefined;
}

/**
 * Everything the tools report about one subscription, from a GetSubscription (or GetSubscriptions list) record and
 * the marketplace's time zone. List records have no dates, so their end date, days left and urgency are null.
 */
export function describeSubscription(sub: Rec, timeZone: string, now = new Date()): SubscriptionView {
  const model = cspModel({ displayName: sub.ServiceDisplayName, technicalName: sub.ServiceName });
  const billingType = str(field(sub, /^billingtype$/i)?.Value) || null;
  const legacyMonthly = isLegacyMonthly(sub, model, billingType ?? "");
  const end = endDateOf(sub);
  const days = end ? daysLeft(end.date, timeZone, now) : null;
  const stored = str(sub.AdvancePeriodEndAction) || null;
  const effective = legacyMonthly ? "Renew" : stored;
  const status = sub.ProvisioningStatus ?? sub.Status ?? null; // the live API returns ProvisioningStatus; the spec documents Status

  const notes: string[] = [];
  if (legacyMonthly && stored !== "Renew") notes.push("Legacy monthly subscriptions renew every month, whatever the stored end-date action says.");
  if (model === "Legacy" && legacyMonthly === null && end)
    notes.push("Could not tell whether this Legacy subscription is monthly or prepaid, so the effective end-date action is the stored one.");
  if (days !== null && days < 0 && sub.AccountState === "Active") notes.push("End date is in the past but the subscription is still active: check the renewal.");

  return {
    accountId: sub.AccountId,
    service: sub.ServiceDisplayName ?? sub.ServiceName,
    vendor: sub.VendorDisplayName ?? null,
    cspModel: model,
    legacyMonthly,
    billingType,
    state: sub.AccountState,
    status,
    endDate: end ? isoDay(end.date) : null,
    endDateSource: end?.source ?? null,
    daysLeft: days,
    urgency: urgency(days),
    storedEndDateAction: stored,
    effectiveEndDateAction: effective,
    scheduledTerminationDate: sub.ScheduledTerminationDate ?? null,
    errorDetails: sub.ErrorDetails || null,
    notes,
  };
}

const first = (data: unknown): Rec | undefined =>
  Array.isArray(data) ? (data[0] as Rec | undefined) : data && typeof data === "object" ? (data as Rec) : undefined;

/** One subscription's full record (with dates and fields), or undefined when the API returns nothing. */
export async function fetchSubscription(client: LcmpPort, accountId: number, workload: Workload = "quick"): Promise<Rec | undefined> {
  const sub = first(await client.call("GetSubscription", { accountId }, workload));
  return sub?.AccountId !== undefined ? sub : undefined;
}

/** At most this many of one interactive tool call's fetches run at once, so it never holds every quick slot. */
const INTERACTIVE_FAN_OUT = 2;

/**
 * Full records for several subscriptions, in input order. A failed fetch is returned as its Error instead of failing
 * the whole batch.
 * - "bulk" (default, for reviews that fetch up to hundreds): the client's bulk lane, shared FIFO by all tools.
 * - "interactive" (a support lookup someone is waiting on, e.g. get_customer_overview): the quick lane, 2 at a time,
 *   so it isn't queued behind a colleague's running review.
 */
export async function fetchSubscriptions(
  client: LcmpPort,
  accountIds: number[],
  mode: "bulk" | "interactive" = "bulk",
): Promise<(Rec | undefined | Error)[]> {
  const fetchOne = async (id: number) => {
    try {
      return await fetchSubscription(client, id, mode === "bulk" ? "bulk" : "quick");
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  };
  if (mode === "bulk") return Promise.all(accountIds.map(fetchOne));
  const results = new Array<Rec | undefined | Error>(accountIds.length);
  let next = 0;
  const worker = async () => {
    while (next < accountIds.length) {
      const i = next++;
      results[i] = await fetchOne(accountIds[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(INTERACTIVE_FAN_OUT, accountIds.length) }, worker));
  return results;
}
