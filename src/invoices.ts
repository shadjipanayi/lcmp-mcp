/**
 * A marketplace's invoices. Invoice downloads cover the whole marketplace and take minutes (~3 min for CYMA's last
 * closed month), so they are cached per marketplace: a closed month doesn't change (6 h), the preview month does
 * (15 min). Concurrent requests share one download.
 */
import type { LcmpPort } from "./client.js";
import type { Rec } from "./reports.js";

export type InvoicePeriod = { preview: true } | { year: number; month: number } | Record<string, never>;

const CLOSED_TTL_MS = 6 * 60 * 60 * 1000;
const PREVIEW_TTL_MS = 15 * 60 * 1000;

export class Invoices {
  private readonly cache = new Map<string, { at: number; ttl: number; data: Rec[] }>();
  private readonly loads = new Map<string, Promise<Rec[]>>();

  constructor(
    private readonly client: LcmpPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** The operation that returns a period's invoices: the preview month, a given month, or the last closed month. */
  static operation(period: InvoicePeriod): [string, Rec] {
    if ("preview" in period) return ["GetPreviewInvoices", {}];
    if ("year" in period) return ["GetLatestInvoicesForPeriod", { year: period.year, month: period.month }];
    return ["GetLatestInvoices", {}];
  }

  /** All invoices of the period, and when they were downloaded. */
  async get(period: InvoicePeriod): Promise<{ source: string; data: Rec[]; cachedAt: number }> {
    const [op, body] = Invoices.operation(period);
    const key = `${op}|${JSON.stringify(body)}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < hit.ttl) return { source: op, data: hit.data, cachedAt: hit.at };
    let load = this.loads.get(key);
    if (!load) {
      load = (async () => {
        const result = await this.client.call(op, body, "heavy");
        const list = Array.isArray(result) ? (result as Rec[]) : [];
        // Each entry is a whole country's month of invoices: drop expired ones so memory doesn't keep growing.
        for (const [k, v] of this.cache) if (this.now() - v.at >= v.ttl) this.cache.delete(k);
        this.cache.set(key, { at: this.now(), ttl: op === "GetPreviewInvoices" ? PREVIEW_TTL_MS : CLOSED_TTL_MS, data: list });
        return list;
      })().finally(() => this.loads.delete(key));
      this.loads.set(key, load);
    }
    const data = await load;
    return { source: op, data, cachedAt: this.cache.get(key)?.at ?? this.now() };
  }
}
