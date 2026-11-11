import { XMLParser } from "fast-xml-parser";

/** Error raised for any non-success response from the LCMP API. */
export class LcmpApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly operation: string,
    readonly rawBody: string,
  ) {
    super(message);
    this.name = "LcmpApiError";
  }

  /** True when the failure looks like an expired or invalid session token. */
  get isSessionError(): boolean {
    if (this.status === 401 || this.status === 403) return true;
    const text = `${this.message} ${this.rawBody}`;
    return /session/i.test(text) && /(expired|invalid|not valid|not found|unauthori[sz]ed)/i.test(text);
  }
}

/**
 * Thrown by lookups when the API says an account isn't in this marketplace. Carries the API's wording, because the
 * API uses the same message for "wrong ID" and "this user lacks a permission".
 */
export class NotFoundError extends Error {
  constructor(readonly apiMessage?: string) {
    super(apiMessage ?? "not found");
    this.name = "NotFoundError";
  }
}

/**
 * API errors that mean "this account isn't in this marketplace", as opposed to timeouts or outages. Observed on the
 * live API: unknown IDs give "Invalid account id"; accounts of another country give "Not enough permissions to get
 * account details"; subscriptions outside the user's tree give "Not enough permissions to execute ... for the AccountId".
 */
const NOT_FOUND =
  /invalid account|not found|does not exist|not enough permissions to get account details|not enough permissions to execute .* for the accountid/i;

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Runs a lookup; turns the API's "not in this marketplace" errors into NotFoundError, rethrows anything else. */
export async function lookup<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    if (NOT_FOUND.test(messageOf(err))) throw new NotFoundError(messageOf(err));
    throw err;
  }
}

/** For optional lookups (a parent reseller, a subscription's customer): undefined instead of NotFoundError. */
export async function optional<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof NotFoundError) return undefined;
    throw err;
  }
}

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
});

// Element names that typically hold a human-readable error message, in order of preference.
const MESSAGE_KEYS = ["message", "errormessage", "faultstring", "reason", "text", "description", "detail", "error"];

function findMessage(node: unknown, depth = 0): string | undefined {
  if (depth > 8 || node == null) return undefined;
  if (typeof node === "string") return node.trim() || undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const m = findMessage(item, depth + 1);
      if (m) return m;
    }
    return undefined;
  }
  if (typeof node === "object") {
    const entries = Object.entries(node as Record<string, unknown>);
    for (const key of MESSAGE_KEYS) {
      const hit = entries.find(([k]) => k.toLowerCase() === key);
      if (hit) {
        const m = findMessage(hit[1], depth + 1);
        if (m) return m;
      }
    }
    for (const [, value] of entries) {
      const m = findMessage(value, depth + 1);
      if (m) return m;
    }
  }
  return undefined;
}

/**
 * Turns an error response body (usually XML, sometimes JSON or plain text) into a short readable message.
 */
export function extractErrorMessage(body: string): string {
  const text = body.trim();
  if (!text) return "(empty response body)";

  if (text.startsWith("<")) {
    try {
      const parsed = parser.parse(text);
      const msg = findMessage(parsed);
      if (msg) return msg;
    } catch {
      // fall through to raw text
    }
    // Strip tags as a last resort.
    const stripped = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (stripped) return stripped.slice(0, 1000);
  }

  if (text.startsWith("{") || text.startsWith("[") || text.startsWith('"')) {
    try {
      const msg = findMessage(JSON.parse(text));
      if (msg) return msg;
    } catch {
      // fall through
    }
  }

  return text.slice(0, 1000);
}
