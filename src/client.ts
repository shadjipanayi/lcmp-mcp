import { LcmpApiError, extractErrorMessage } from "./errors.js";

export interface LcmpConfig {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
  /** Maximum quick API requests in flight for this marketplace user (default 3). */
  maxConcurrency?: number;
}

const CONTENT_TYPE = "application/json;charset=UTF8";

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
 * Thin client for the Marketplace SimpleAPI: every operation is `POST /<Operation>` with a JSON body,
 * authenticated with `Authenticate: CCPSessionId <token>`.
 */
export class LcmpClient {
  /** A token is trusted for this long after login or its last successful PingPong check. */
  static readonly TOKEN_TTL_MS = 3.5 * 60 * 60 * 1000;

  private token: string | undefined;
  private tokenVerifiedAt = 0;
  private tokenInFlight: Promise<string> | undefined;
  /**
   * Two queues per marketplace user: heavy calls (reports, big lists; any call with a longer timeout than the
   * default) run for minutes, so they get their own slots and can't hold up quick lookups or the token check.
   */
  private readonly quick: Limiter;
  private readonly heavy = new Limiter(2);

  constructor(private readonly config: LcmpConfig) {
    this.quick = new Limiter(Math.max(1, config.maxConcurrency ?? 3));
  }

  /**
   * Calls an operation and returns the parsed JSON response (or the raw text if it is not JSON).
   * `timeoutMs` overrides the configured timeout, for heavy reports that take minutes.
   */
  async call(operation: string, body: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
    const token = await this.getToken();
    try {
      return await this.post(operation, body, token, timeoutMs);
    } catch (err) {
      if (err instanceof LcmpApiError && err.isSessionError) {
        // Session expired: log in again once and retry.
        this.invalidate(token);
        const fresh = await this.getToken();
        return await this.post(operation, body, fresh, timeoutMs);
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
    if (this.token && Date.now() - this.tokenVerifiedAt < LcmpClient.TOKEN_TTL_MS) return this.token;
    // Share one login/verification between concurrent callers.
    this.tokenInFlight ??= (this.token ? this.verifyOrLogin(this.token) : this.login()).finally(() => {
      this.tokenInFlight = undefined;
    });
    return this.tokenInFlight;
  }

  private async verifyOrLogin(token: string): Promise<string> {
    try {
      await this.post("PingPong", {}, token);
      this.tokenVerifiedAt = Date.now();
      return token;
    } catch {
      this.invalidate(token);
      return this.login();
    }
  }

  private async login(): Promise<string> {
    const res = await this.fetch("GetSessionToken", {
      username: this.config.username,
      password: this.config.password,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new LcmpApiError(
        `Login failed (HTTP ${res.status}): ${extractErrorMessage(text)}`,
        res.status,
        "GetSessionToken",
        text,
      );
    }
    const token = parseToken(text);
    if (!token) throw new LcmpApiError("Login returned an empty session token", res.status, "GetSessionToken", text);
    this.token = token;
    this.tokenVerifiedAt = Date.now();
    return token;
  }

  private async post(operation: string, body: Record<string, unknown>, token: string, timeoutMs?: number) {
    // The timeout starts when the request is sent, not while it waits for a free slot.
    const queue = timeoutMs !== undefined && timeoutMs > this.config.timeoutMs ? this.heavy : this.quick;
    const { res, text } = await queue.run(async () => {
      const r = await this.fetch(operation, body, token, timeoutMs);
      return { res: r, text: await r.text() };
    });
    if (!res.ok) {
      throw new LcmpApiError(
        `${operation} failed (HTTP ${res.status}): ${extractErrorMessage(text)}`,
        res.status,
        operation,
        text,
      );
    }
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private fetch(operation: string, body: Record<string, unknown>, token?: string, timeoutMs?: number) {
    const headers: Record<string, string> = {
      "Content-Type": CONTENT_TYPE,
      // Responses are documented as */*; errors come back as XML.
      Accept: "application/json, */*",
    };
    if (token) headers.Authenticate = `CCPSessionId ${token}`;
    return fetch(`${this.config.baseUrl}/${operation}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs),
    });
  }
}
