// LcmpClient with an injected fetch and clock: login sharing, session retry, the token check and the lanes.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LcmpClient } from "../src/client.js";

interface Pending {
  op: string;
  token: string | undefined;
  respond: (status: number, body: string) => void;
}

/** A fetch that records each request and answers it from `answer`, or holds it until the test responds. */
function fakeApi(answer?: (op: string, token: string | undefined) => [number, string] | undefined) {
  const requests: Pending[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const op = url.split("/").pop()!;
    const token = (init.headers as Record<string, string>).Authenticate?.replace("CCPSessionId ", "");
    return new Promise<Response>((resolve) => {
      const p: Pending = { op, token, respond: (status, body) => resolve(new Response(body, { status })) };
      requests.push(p);
      const now = answer?.(op, token);
      if (now) p.respond(...now);
    });
  }) as typeof globalThis.fetch;
  return { fetch, requests, ops: () => requests.map((r) => r.op) };
}

const tick = () => new Promise((r) => setImmediate(r));

function client(api: ReturnType<typeof fakeApi>, clock = { t: 0 }) {
  return new LcmpClient({ baseUrl: "https://api.test", username: "u", password: "p", timeoutMs: 30_000, fetch: api.fetch, now: () => clock.t });
}

describe("LcmpClient", () => {
  it("shares one login between concurrent calls", async () => {
    const api = fakeApi((op) => (op === "GetSessionToken" ? [200, '"tok1"'] : [200, '{"ok":true}']));
    const c = client(api);
    await Promise.all([c.call("GetCompany"), c.call("GetUsers"), c.call("GetCreditLimit")]);
    assert.equal(api.ops().filter((o) => o === "GetSessionToken").length, 1);
    assert.ok(api.requests.filter((r) => r.op !== "GetSessionToken").every((r) => r.token === "tok1"));
  });

  it("logs in again and retries once when the session has expired", async () => {
    let logins = 0;
    const api = fakeApi((op, token) => {
      if (op === "GetSessionToken") return [200, `"tok${++logins}"`];
      return token === "tok1" ? [500, "<Error>Session is expired</Error>"] : [200, "[1]"];
    });
    assert.deepEqual(await client(api).call("GetCompany"), [1]);
    assert.deepEqual(api.ops(), ["GetSessionToken", "GetCompany", "GetSessionToken", "GetCompany"]);
  });

  it("checks the token with PingPong after 3.5 h and keeps it while it is valid", async () => {
    const clock = { t: 0 };
    let pingOk = true;
    const api = fakeApi((op) => (op === "GetSessionToken" ? [200, '"tok"'] : op === "PingPong" ? (pingOk ? [200, ""] : [401, ""]) : [200, "{}"]));
    const c = client(api, clock);
    await c.call("GetCompany");
    clock.t = LcmpClient.TOKEN_TTL_MS - 1;
    await c.call("GetCompany");
    assert.deepEqual(api.ops(), ["GetSessionToken", "GetCompany", "GetCompany"]);

    clock.t = LcmpClient.TOKEN_TTL_MS + 1;
    await c.call("GetCompany");
    assert.deepEqual(api.ops().slice(3), ["PingPong", "GetCompany"]);

    clock.t = 3 * LcmpClient.TOKEN_TTL_MS;
    pingOk = false;
    await c.call("GetCompany");
    assert.deepEqual(api.ops().slice(5), ["PingPong", "GetSessionToken", "GetCompany"]);
  });

  it("runs at most two bulk calls at once, without holding up quick calls or the token check", async () => {
    const clock = { t: 0 };
    const api = fakeApi((op) => (op === "GetSessionToken" || op === "PingPong" ? [200, '"tok"'] : undefined));
    const c = client(api, clock);
    const fanOut = Array.from({ length: 6 }, (_, i) => c.call("GetSubscription", { accountId: i }, "bulk"));
    await tick();
    const inFlight = () => api.requests.filter((r) => r.op === "GetSubscription").length;
    assert.equal(inFlight(), 2, "bulk lane caps the fan-out at 2");

    // The token check falls due while the fan-out is queued: it doesn't wait for a lane.
    clock.t = LcmpClient.TOKEN_TTL_MS + 1;
    const quick = c.call("GetCompany");
    await tick();
    assert.ok(api.ops().includes("PingPong"));
    await tick();
    const company = api.requests.find((r) => r.op === "GetCompany");
    assert.ok(company, "quick call is sent while bulk calls are still queued");
    company.respond(200, '{"AccountId":1}');
    assert.deepEqual(await quick, { AccountId: 1 });

    for (let done = 0; done < 6; done++) {
      await tick();
      api.requests.filter((r) => r.op === "GetSubscription")[done].respond(200, `{"AccountId":${done}}`);
    }
    assert.equal((await Promise.all(fanOut)).length, 6);
  });
});
