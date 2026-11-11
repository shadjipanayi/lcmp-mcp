/**
 * The "MSCSPSeats" report, read in one place: one typed row per Microsoft CSP subscription. It is the only report
 * several review tools share, so its column names (and their casing, e.g. "companyname") stay here.
 */
import type { LcmpPort } from "./client.js";
import { num, pick, runReport, str } from "./reports.js";
import { type CspModel, cspModel, hasMonthlyTerm, isTrial } from "./subscription.js";

export interface SeatRow {
  /** The subscription Account ID. */
  accountId: number;
  reseller: unknown;
  customer: unknown;
  product: string;
  /** Technical product name, e.g. "156469_ExchanOnlinePlan1_45103". */
  technicalName: string;
  seats: number | undefined;
  billingType: string;
  hasAdvancePayment: boolean;
  cspModel: CspModel | null;
  trial: boolean;
  /** Renews every month: NCE P1M, or Legacy monthly. */
  monthlyTerm: boolean;
}

const bool = (v: unknown) => v === true || /^true$/i.test(str(v));

/** Turns one MSCSPSeats record into a SeatRow (exported for tests). */
export function seatRow(r: Record<string, unknown>): SeatRow {
  const product = str(pick(r, "ProductDisplayName"));
  const technicalName = str(pick(r, "productname"));
  const billingType = str(pick(r, "BillingType"));
  const hasAdvancePayment = bool(pick(r, "hasAdvancePayment"));
  const model = cspModel({ displayName: product, technicalName });
  return {
    accountId: Number(pick(r, "accountId")),
    reseller: pick(r, "reseller") ?? null,
    customer: pick(r, "companyname") ?? null,
    product,
    technicalName,
    seats: num(pick(r, "seats")),
    billingType,
    hasAdvancePayment,
    cspModel: model,
    trial: isTrial(billingType),
    monthlyTerm: hasMonthlyTerm(billingType, model, hasAdvancePayment),
  };
}

/** Every Microsoft CSP subscription in the marketplace, from the MSCSPSeats report (heavy: minutes on big countries). */
export async function readSeats(client: LcmpPort): Promise<SeatRow[]> {
  return (await runReport(client, "MSCSPSeats")).map(seatRow);
}
