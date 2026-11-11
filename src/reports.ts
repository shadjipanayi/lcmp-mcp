import type { LcmpPort } from "./client.js";
import { isBlockedReport } from "./knowledge.js";

export type Rec = Record<string, unknown>;

interface ReportColumn {
  Name: string;
  CellIndex?: number;
}

/**
 * Converts an ExecuteReport result (`{ Columns: [{Name, CellIndex}], Rows: [{Cells: [...]}] }`) into one object per
 * row, keyed by column name. Rows are also accepted as bare arrays (the shape the OpenAPI spec documents).
 * Summary rows (any cell equal to "ZZ_Total") are dropped, as every runbook does.
 * Returns undefined when the input does not look like a report table.
 */
export function reportToRecords(data: unknown): Rec[] | undefined {
  if (!data || typeof data !== "object") return undefined;
  const { Columns, Rows } = data as { Columns?: unknown; Rows?: unknown };
  if (!Array.isArray(Columns) || !Array.isArray(Rows)) return undefined;
  const columns = Columns as ReportColumn[];
  const records: Rec[] = [];
  for (const row of Rows) {
    const cells: unknown[] | undefined = Array.isArray(row) ? row : (row as { Cells?: unknown[] })?.Cells;
    if (!Array.isArray(cells)) continue;
    if (cells.some((c) => c === "ZZ_Total")) continue;
    const rec: Rec = {};
    columns.forEach((col, i) => {
      rec[col.Name] = cells[col.CellIndex ?? i] ?? null;
    });
    records.push(rec);
  }
  return records;
}

/**
 * The one way to run a report: every report call (execute_report and the review tools) goes through here, so reports
 * in BLOCKED_REPORTS are refused before anything reaches the API. Returns the raw ExecuteReport response.
 */
export async function executeReport(
  client: LcmpPort,
  reportName: string,
  parameters: Record<string, unknown> = {},
  columns?: string[],
): Promise<unknown> {
  if (isBlockedReport(reportName)) {
    throw new Error(`The report "${reportName}" is disabled in this server because it overloads the platform.`);
  }
  return client.call("ExecuteReport", { reportName, parameters, ...(columns ? { columns } : {}) }, "heavy");
}

/** Runs a named report and returns its rows as records. */
export async function runReport(
  client: LcmpPort,
  reportName: string,
  parameters: Record<string, unknown> = {},
): Promise<Rec[]> {
  const records = reportToRecords(await executeReport(client, reportName, parameters));
  if (!records) throw new Error(`Report "${reportName}" did not return a Columns/Rows table.`);
  return records;
}

/**
 * Runs independent parts of a tool (reports, lists) side by side and keeps what worked: a failed part becomes a
 * "<label>: <message>" entry in `errors` instead of failing the tool. Undefined parts are skipped.
 * `allFailed` tells the caller when nothing at all came back, so it can fail instead of returning an empty result.
 */
export async function settle<T extends Record<string, Promise<unknown> | undefined>>(
  parts: T,
): Promise<{ values: { [K in keyof T]?: Awaited<T[K]> }; errors: string[]; allFailed: boolean }> {
  const entries = Object.entries(parts).filter((e): e is [string, Promise<unknown>] => e[1] !== undefined);
  const results = await Promise.allSettled(entries.map(([, p]) => p));
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  results.forEach((r, i) => {
    const label = entries[i][0];
    if (r.status === "fulfilled") values[label] = r.value;
    else errors.push(`${label}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  return { values: values as { [K in keyof T]?: Awaited<T[K]> }, errors, allFailed: entries.length > 0 && errors.length === entries.length };
}

/** Case-insensitive field lookup: report column names vary in casing between reports and marketplaces. */
export function pick(rec: Rec, ...names: string[]): unknown {
  for (const name of names) {
    if (name in rec) return rec[name];
    const lower = name.toLowerCase();
    const key = Object.keys(rec).find((k) => k.toLowerCase() === lower);
    if (key !== undefined) return rec[key];
  }
  return undefined;
}

export function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

export function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Parses ISO dates (zone-less ones as UTC) and WCF-style "/Date(1700000000000+0200)/" values. */
export function parseDate(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  const wcf = /\/Date\((-?\d+)/.exec(s);
  // The API sends dates without a time zone ("2026-11-10T00:00:00"). They are calendar dates, so read them as UTC:
  // as local time they shift by a day depending on where the server runs.
  const zoneless = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s);
  const d = wcf ? new Date(Number(wcf[1])) : new Date(zoneless ? `${s}Z` : s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/** Whole days from today to `date` (negative when in the past). */
export function daysUntil(date: Date, now = new Date()): number {
  return Math.round((startOfDay(date) - startOfDay(now)) / DAY_MS);
}

/** Today's calendar date (YYYY-MM-DD) in a time zone, e.g. "Asia/Nicosia". */
export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function isoDay(date: Date | undefined): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}
