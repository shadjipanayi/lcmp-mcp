import { LcmpApiError, extractErrorMessage } from "./errors.js";

/**
 * What kind of work a call is. The client turns it into a timeout and a lane, so callers never deal with either:
 * - quick: a single lookup (default timeout, LCMP_MAX_CONCURRENCY in flight)
 * - bulk: one of many per-item calls a tool fans out, e.g. GetSubscription per subscription (default timeout,
 *   2 in flight across all tools, so a fan-out can't take the slots quick lookups need)
 * - heavy: reports and big lists that take minutes (300 s, 2 in flight)
 */
export type Workload = "quick" | "bulk" | "heavy";

/** The production runbooks give heavy reports 300 s, and so does the client. */
export const HEAVY_TIMEOUT_MS = 300_000;

/** What tools need from a marketplace's API connection. The real LcmpClient and the test fake both satisfy it. */
export interface LcmpPort {
  /**
   * Calls an operation and returns the parsed JSON response (the raw text if it isn't JSON, null if empty).
   * Throws LcmpApiError for HTTP errors; a fan-out of bulk calls can simply be started together, the client queues them.
   */
  call(operation: string, body?: Record<string, unknown>, workload?: Workload): Promise<unknown>;
}

export interface LcmpConfig {
  baseUrl: string;
  username: string;
  password: string;
  /** Timeout for quick and bulk calls. */
  timeoutMs: number;
  /** Maximum quick API requests in flight for this marketplace user (default 3). */
  maxConcurrency?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected for tests; defaults to Date.now. */
  now?: () => number;
}

const CONTENT_TYPE = "application/json;charset=UTF8";
const BULK_CONCURRENCY = 2;
const HEAVY_CONCURRENCY = 2;

/** Parses the GetSessionToken response, which may be a bare string or a JSON-encoded string. */
function parseToken(body: string): string {
  let token = body.trim();
  if (token.startsWith('"')) {
    try {
      token = JSON.parse(token);
    } catch {
      token = token.replace(/^"+|"+$/g, "");
    }
  }
  return token.trim();
}

/** FIFO semaphore: caps concurrent requests so several users can't overload the API at once. */
class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Client for the Marketplace SimpleAPI: every operation is `POST /<Operation>` with a JSON body, authenticated with
 * `Authenticate: CCPSessionId <token>`. One client per marketplace user, shared by every tool call (and, in HTTP
 * mode, by the whole team), so it owns the load policy: three lanes (see Workload), plus the token check, which
 * bypasses the lanes so no fan-out or report can hold it up.
 */
export class LcmpClient implements LcmpPort {
  /** A token is trusted for this long after login or its last successful PingPong check. */
  static readonly TOKEN_TTL_MS = 3.5 * 60 * 60 * 1000;

  private token: string | undefined;
  private tokenVerifiedAt = 0;
  private tokenInFlight: Promise<string> | undefined;
  private readonly lanes: Record<Workload, Limiter>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: LcmpConfig) {
    this.lanes = {
      quick: new Limiter(Math.max(1, config.maxConcurrency ?? 3)),
      bulk: new Limiter(BULK_CONCURRENCY),
      heavy: new Limiter(HEAVY_CONCURRENCY),
    };
    this.fetchImpl = config.fetch ?? fetch;
    this.now = config.now ?? Date.now;
  }

  async call(operation: string, body: Record<string, unknown> = {}, workload: Workload = "quick"): Promise<unknown> {
    const token = await this.getToken();
    try {
      return await this.post(operation, body, token, workload);
    } catch (err) {
      if (err instanceof LcmpApiError && err.isSessionError) {
        // Session expired: log in again once and retry.
        this.invalidate(token);
        const fresh = await this.getToken();
        return await this.post(operation, body, fresh, workload);
      }
      throw err;
    }
  }

  private invalidate(token: string): void {
    if (this.token === token) this.token = undefined;
  }

  /**
   * Returns a session token. Sessions are never terminated (each marketplace's MCP API user is shared by
   * the whole team, so ending a session could log out a colleague). A token is reused for TOKEN_TTL_MS, then
   * checked with PingPong and kept if still valid, otherwise replaced by a new login.
   */
  private async getToken(): Promise<string> {
    if (this.token && this.now() - this.tokenVerifiedAt < LcmpClient.TOKEN_TTL_MS) return this.token;
    // Share one login/verification between concurrent callers.
    this.tokenInFlight ??= (this.token ? this.verifyOrLogin(this.token) : this.login()).finally(() => {
      this.tokenInFlight = undefined;
    });
    return this.tokenInFlight;
  }

  private async verifyOrLogin(token: string): Promise<string> {
    try {
      // Not through a lane: at most one check is in flight, and it must not wait behind a fan-out.
      const res = await this.send("PingPong", {}, token, this.config.timeoutMs);
      await res.text(); // read the body so the connection can be reused
      if (!res.ok) throw new Error(`PingPong HTTP ${res.status}`);
      this.tokenVerifiedAt = this.now();
      return token;
    } catch {
      this.invalidate(token);
      return this.login();
    }
  }

  private async login(): Promise<string> {
    const res = await this.send("GetSessionToken", { username: this.config.username, password: this.config.password }, undefined, this.config.timeoutMs);
    const text = await res.text();
    if (!res.ok) {
      throw new LcmpApiError(`Login failed (HTTP ${res.status}): ${extractErrorMessage(text)}`, res.status, "GetSessionToken", text);
    }
    const token = parseToken(text);
    if (!token) throw new LcmpApiError("Login returned an empty session token", res.status, "GetSessionToken", text);
    this.token = token;
    this.tokenVerifiedAt = this.now();
    return token;
  }

  private async post(operation: string, body: Record<string, unknown>, token: string, workload: Workload) {
    const timeoutMs = workload === "heavy" ? HEAVY_TIMEOUT_MS : this.config.timeoutMs;
    // The timeout starts when the request is sent, not while it waits for a free slot.
    const { res, text } = await this.lanes[workload].run(async () => {
      const r = await this.send(operation, body, token, timeoutMs);
      return { res: r, text: await r.text() };
    });
    if (!res.ok) {
      throw new LcmpApiError(`${operation} failed (HTTP ${res.status}): ${extractErrorMessage(text)}`, res.status, operation, text);
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private send(operation: string, body: Record<string, unknown>, token: string | undefined, timeoutMs: number) {
    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPE,
      // Responses are documented as */*; errors come back as XML.
      Accept: "application/json, */*",
    };
    if (token) headers.Authenticate = `CCPSessionId ${token}`;
    return this.fetchImpl(`${this.config.baseUrl}/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
}
