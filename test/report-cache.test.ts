// Report results are remembered per marketplace for a short time (issue #9). Tested through MCP tool calls, with a
// fake API client that counts ExecuteReport calls and a clock the tests move.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LcmpPort } from "../src/client.js";
import { MarketplaceRegistry, createMarketplace } from "../src/marketplaces.js";
import { createServer } from "../src/server.js";

type Body = Record<string, unknown>;
const table = (rows: unknown[][], columns = ["Name"]) => ({ Columns: columns.map((Name) => ({ Name })), Rows: rows.map((Cells) => ({ Cells })) });

/** Starts the real server with one or more fake marketplaces; `report` answers ExecuteReport for every marketplace. */
async function setup(report: (body: Body, code: string) => unknown, codes = ["GR"]) {
  const clock = { t: Date.parse("2026-11-13T10:00:00Z") };
  const calls: { code: string; body: Body }[] = [];
  const fake = (code: string): LcmpPort => ({
    async call(op: string, body: Body = {}) {
      if (op !== "ExecuteReport") throw new Error(`${op} failed (HTTP 500): not faked`);
      calls.push({ code, body });
      return report(body, code);
    },
  });
  const registry = new MarketplaceRegistry(
    codes.map((code) => createMarketplace({ code, name: code, timeZone: "Europe/Athens", client: fake(code), now: () => clock.t })),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(registry).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const tool = async (name: string, args: Body) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(r.content[0].text).data;
    } catch {}
    return { isError: !!r.isError, text: r.content[0].text, json };
  };
  return { tool, calls, clock };
}

const run = (reportName: string, parameters: Body = {}, more: Body = {}) => ({ reportName, parameters, ...more });

describe("report cache", () => {
  it("answers a repeated report from memory", async () => {
    const { tool, calls } = await setup(() => table([["Acme"]]));
    const first = await tool("execute_report", run("Resellers"));
    const second = await tool("execute_report", run("Resellers"));
    assert.equal(calls.length, 1);
    assert.deepEqual(second.json?.rows, [{ Name: "Acme" }]);
    assert.deepEqual(second.json?.rows, first.json?.rows);
  });

  it("fetches separately for different parameters or columns, but not for reordered parameters", async () => {
    const { tool, calls } = await setup(() => table([["Acme"]]));
    await tool("execute_report", run("MSCSPSeatDelta", { StartDate: "2026-11-01", EndDate: "2026-11-07" }));
    await tool("execute_report", run("MSCSPSeatDelta", { EndDate: "2026-11-07", StartDate: "2026-11-01" }));
    await tool("execute_report", run("MSCSPSeatDelta", { StartDate: "2026-11-02", EndDate: "2026-11-07" }));
    await tool("execute_report", run("MSCSPSeatDelta", { StartDate: "2026-11-01", EndDate: "2026-11-07" }, { columns: ["Name"] }));
    assert.equal(calls.length, 3);
  });

  it("shares one request between concurrent identical calls", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { tool, calls } = await setup(async () => (await gate, table([["Acme"]])));
    const both = Promise.all([tool("execute_report", run("Resellers")), tool("execute_report", run("Resellers"))]);
    await new Promise((r) => setTimeout(r, 20));
    release();
    const [a, b] = await both;
    assert.equal(calls.length, 1);
    assert.deepEqual(a.json?.rows, [{ Name: "Acme" }]);
    assert.deepEqual(b.json?.rows, [{ Name: "Acme" }]);
  });

  it("doesn't remember a failed report", async () => {
    let fail = true;
    const { tool, calls } = await setup(() => {
      if (fail) throw new Error("ExecuteReport failed: The operation was aborted due to timeout");
      return table([["Acme"]]);
    });
    const first = await tool("execute_report", run("Resellers"));
    assert.equal(first.isError, true);
    assert.match(first.text, /timeout/);
    fail = false;
    const second = await tool("execute_report", run("Resellers"));
    assert.equal(calls.length, 2);
    assert.deepEqual(second.json?.rows, [{ Name: "Acme" }]);
  });

  it("fetches again once a result is older than its report's TTL", async () => {
    let name = "Acme";
    const { tool, calls, clock } = await setup(() => table([[name]]));
    await tool("execute_report", run("Resellers"));
    name = "Beta";
    clock.t += 14 * 60_000;
    assert.deepEqual((await tool("execute_report", run("Resellers"))).json?.rows, [{ Name: "Acme" }]);
    clock.t += 2 * 60_000; // 16 min: past the 15 min default
    assert.deepEqual((await tool("execute_report", run("Resellers"))).json?.rows, [{ Name: "Beta" }]);
    assert.equal(calls.length, 2);
  });

  it("keeps last month's billing for hours and provisioning data for minutes", async () => {
    const { tool, calls, clock } = await setup(() => table([["Acme"]]));
    await tool("execute_report", run("MSCSP Resellers"));
    await tool("execute_report", run("Waiting provisioning requests"));
    clock.t += 10 * 60_000;
    await tool("execute_report", run("MSCSP Resellers"));
    await tool("execute_report", run("Waiting provisioning requests"));
    assert.deepEqual(
      calls.map((c) => c.body.reportName),
      ["MSCSP Resellers", "Waiting provisioning requests", "Waiting provisioning requests"],
    );
  });

  it("refresh fetches again, and later calls get the refreshed result", async () => {
    let name = "Acme";
    const { tool, calls } = await setup(() => table([[name]]));
    await tool("execute_report", run("Resellers"));
    name = "Beta";
    const refreshed = await tool("execute_report", run("Resellers", {}, { refresh: true }));
    assert.deepEqual(refreshed.json?.rows, [{ Name: "Beta" }]);
    assert.deepEqual((await tool("execute_report", run("Resellers"))).json?.rows, [{ Name: "Beta" }]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.refresh, undefined, "refresh is a tool input, not a report parameter");
  });

  it("says when the data was fetched: the oldest report a review used", async () => {
    const { tool, clock } = await setup(() => table([]));
    const t0 = new Date(clock.t).toISOString();
    assert.equal((await tool("execute_report", run("Waiting provisioning requests"))).json?.dataAsOf, t0);
    clock.t += 2 * 60_000;
    // Waiting requests come from memory (fetched at t0); failed details are fetched now.
    const review = await tool("review_provisioning_requests", {});
    assert.equal(review.isError, false, review.text);
    assert.equal(review.json?.dataAsOf, t0);
  });

  it("still refuses blocked reports, and never asks the API for them", async () => {
    const { tool, calls } = await setup(() => table([]));
    const r = await tool("execute_report", run("Failed provisioning statistics"));
    assert.equal(r.isError, true);
    assert.match(r.text, /disabled/);
    assert.equal(calls.length, 0);
  });

  it("doesn't share results between marketplaces", async () => {
    const { tool, calls } = await setup((_body, code) => table([[code]]), ["GR", "CYMA"]);
    await tool("execute_report", { ...run("Resellers"), marketplace: "GR" });
    const cy = await tool("execute_report", { ...run("Resellers"), marketplace: "CYMA" });
    assert.deepEqual(cy.json?.rows, [{ Name: "CYMA" }]);
    assert.deepEqual(calls.map((c) => c.code), ["GR", "CYMA"]);
  });

  it("logs every call, and whether it was answered from memory", async () => {
    const { tool } = await setup(() => table([["Acme"]]));
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => void lines.push(String(line));
    try {
      await tool("execute_report", run("Resellers"));
      await tool("execute_report", run("Resellers"));
    } finally {
      console.error = original;
    }
    const events = lines.map((l) => JSON.parse(l)).filter((e) => e.event === "tool_call");
    assert.deepEqual(events.map((e) => e.fromCache), [false, true]);
  });
});
