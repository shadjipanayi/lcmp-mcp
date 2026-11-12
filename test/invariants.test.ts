// The server's hard rules, checked mechanically: every tool is read-only, no write operation is ever called,
// sessions are never terminated (the marketplace API users are shared by the team), and stdout stays the MCP transport.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MarketplaceRegistry, createMarketplace } from "../src/marketplaces.js";
import { createServer } from "../src/server.js";

const SRC = path.join(import.meta.dirname, "..", "src");
const sources = fs
  .readdirSync(SRC, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts"))
  .map((f) => ({ file: f, text: fs.readFileSync(path.join(SRC, f), "utf8") }));

/** API operation names that change state. Read operations are Get*, List*, Execute(Report), PingPong, ... */
const WRITE_OPERATION = /^(Create|Update|Delete|Set|Add|Remove|Terminate|Cancel|Retry|Approve|Decline|Reject|Assign|Unassign|Reset|Change|Suspend|Resume|Activate|Deactivate|Provision|Send|Upload|Import|Move|Transfer|Enable|Disable|Submit|Save)/;

/** Every operation name the code can send: `operation: "X"` in tool specs and `call("X"` / `call(op` literals. */
function operationsInSource(): Set<string> {
  const ops = new Set<string>();
  for (const { text } of sources) {
    for (const m of text.matchAll(/operation:\s*"(\w+)"/g)) ops.add(m[1]);
    for (const m of text.matchAll(/\.call\(\s*"(\w+)"/g)) ops.add(m[1]);
    for (const m of text.matchAll(/\["(\w+)",\s*\{/g)) ops.add(m[1]); // [op, body] tuples, e.g. invoice periods
  }
  return ops;
}

describe("invariants", () => {
  it("registers every tool as read-only", async () => {
    const fake = { call: async () => null };
    const registry = new MarketplaceRegistry([createMarketplace({ code: "GR", name: "Greece", timeZone: "Europe/Athens", client: fake })]);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(registry).connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 30, `expected the full tool set, got ${tools.length}`);
    const notReadOnly = tools.filter((t) => t.annotations?.readOnlyHint !== true).map((t) => t.name);
    assert.deepEqual(notReadOnly, []);
  });

  it("never calls a write operation", () => {
    const ops = operationsInSource();
    assert.ok(ops.has("GetSubscription") && ops.has("ExecuteReport"), "operation scan found the known reads");
    const writes = [...ops].filter((op) => WRITE_OPERATION.test(op));
    assert.deepEqual(writes, []);
  });

  it("never terminates a session and never writes to stdout", () => {
    const offenders = sources
      .filter(({ text }) => /TerminateSessionToken|console\.log\(|process\.stdout\.write\(/.test(text.replace(/^\s*(\/\/|\*).*$/gm, "")))
      .map(({ file }) => file);
    assert.deepEqual(offenders, []);
  });
});
