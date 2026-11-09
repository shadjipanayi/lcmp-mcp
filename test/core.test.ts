// Run with `npm test`. No network: the API client is replaced by a fake, and Entra tokens are signed locally.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createEntraVerifier } from "../src/auth.js";
import type { LcmpClient } from "../src/client.js";
import { MarketplaceRegistry } from "../src/marketplaces.js";
import { daysUntil, isoDay, parseDate, subscriptionTerm, todayIn } from "../src/reports.js";
import { createServer } from "../src/server.js";
import { redactSecrets } from "../src/tools/helpers.js";

describe("redactSecrets", () => {
  it("hides tenant passwords in product fields and plain keys, keeps the rest", () => {
    const out = redactSecrets({
      Fields: [
        { Name: "InitialPassword", Value: "S3cret!" },
        { Name: "AdministratorUserName", Value: "admin@contoso.com" },
        { Name: "Requirepasswordchange", Value: true },
      ],
      fields: { InitialPassword: "S3cret!", Language: "en" },
    }) as { Fields: { Name: string; Value: unknown }[]; fields: Record<string, unknown> };
    assert.equal(out.Fields[0].Value, "[redacted]");
    assert.equal(out.Fields[1].Value, "admin@contoso.com");
    assert.equal(out.Fields[2].Value, true);
    assert.equal(out.fields.InitialPassword, "[redacted]");
    assert.equal(out.fields.Language, "en");
    assert.ok(!JSON.stringify(out).includes("S3cret!"));
  });
});

describe("dates", () => {
  const now = new Date("2026-11-09T12:00:00Z");

  it("reads the API's zone-less dates as calendar dates", () => {
    const d = parseDate("2026-11-10T00:00:00")!;
    assert.equal(isoDay(d), "2026-11-10");
    assert.equal(daysUntil(d, now), 1);
  });

  it("uses the marketplace's local date for today", () => {
    // 23:30 UTC on the 9th is already the 10th in Cyprus.
    assert.equal(todayIn("Asia/Nicosia", new Date("2026-11-09T23:30:00Z")), "2026-11-10");
    assert.equal(todayIn("UTC", new Date("2026-11-09T23:30:00Z")), "2026-11-09");
  });

  it("ignores the Subscriptionenddatealignment field and falls back to ContractEndDate", () => {
    const term = subscriptionTerm({
      Fields: [{ Name: "Subscriptionenddatealignment", Value: "2026-05-31" }],
      ContractEndDate: "2026-12-12T00:00:00",
    });
    assert.equal(term.endDate, "2026-12-12");
    assert.equal(term.endDateSource, "ContractEndDate");
  });

  it("prefers the price-protection end date", () => {
    const term = subscriptionTerm({ PriceProtectionEndDate: "2027-01-06T00:00:00", ContractEndDate: "2027-12-01T00:00:00" });
    assert.equal(term.endDate, "2027-01-06");
  });
});

describe("Entra token check", async () => {
  const tenant = "11111111-1111-1111-1111-111111111111";
  const audience = "api://lcmp-mcp";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const verifier = createEntraVerifier({ tenantId: tenant, audiences: [audience], requiredRole: "LCMP.Read" }, createLocalJWKSet({ keys: [jwk] }));
  const sign = (claims: Record<string, unknown>, aud = audience) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(`https://login.microsoftonline.com/${tenant}/v2.0`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

  it("accepts a user with the LCMP.Read role and records who it is", async () => {
    const info = await verifier.verifyAccessToken(await sign({ roles: ["LCMP.Read"], preferred_username: "jane@logicom.net" }));
    assert.equal(info.extra?.user, "jane@logicom.net");
  });

  it("rejects a signed-in user without the role", async () => {
    await assert.rejects(verifier.verifyAccessToken(await sign({ preferred_username: "bob@logicom.net" })), /LCMP\.Read/);
  });

  it("rejects a token issued for another API", async () => {
    await assert.rejects(verifier.verifyAccessToken(await sign({ roles: ["LCMP.Read"] }, "api://other")), /rejected/);
  });
});

/** Starts the real MCP server over an in-memory link, with a fake API client that answers from `handlers`. */
async function connect(handlers: Record<string, (body: Record<string, unknown>) => unknown>) {
  const fake = {
    async call(op: string, body: Record<string, unknown> = {}) {
      const h = handlers[op];
      if (!h) throw new Error(`${op} failed (HTTP 500): Invalid account id`);
      return h(body);
    },
  } as unknown as LcmpClient;
  const registry = new MarketplaceRegistry([{ code: "GR", name: "Greece", timeZone: "Europe/Athens", client: fake }]);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(registry).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    return { isError: !!r.isError, text: r.content[0].text };
  };
}

describe("support tools", () => {
  it("find_account searches an all-digit query as a VAT ID when it is not an account ID", async () => {
    const call = await connect({
      GetCompany: (b) => {
        if (b.accountId === undefined) return [{ AccountId: 1, CompanyName: "Logicom Greece" }];
        throw new Error("GetCompany failed (HTTP 500): Invalid account id");
      },
      GetCompanyByVatId: (b) => (b.vatId === "094014201" ? [{ AccountId: 5, CompanyName: "Acme SA", VATID: "094014201" }] : []),
      GetCompanies: () => [],
    });
    const r = await call("find_account", { query: "094014201", includeCustomers: false });
    assert.equal(r.isError, false, r.text);
    assert.equal(JSON.parse(r.text).data.matches[0].accountId, 5);
  });

  it("get_customer_overview refuses to guess when several accounts share a VAT ID", async () => {
    const call = await connect({
      GetCompanyByVatId: () => [
        { AccountId: 5, CompanyName: "Acme SA" },
        { AccountId: 6, CompanyName: "Other Ltd" },
      ],
    });
    const r = await call("get_customer_overview", { vatId: "000" });
    assert.equal(r.isError, true);
    assert.match(r.text, /2 accounts have VAT ID/);
  });

  it("a not-found answer includes the API's message, which can reveal a missing permission", async () => {
    const call = await connect({
      GetSubscription: () => {
        throw new Error("GetSubscription failed (HTTP 500): Not enough permissions to execute 0 for the AccountId:42. GetSubscription/PRODUCT_ACCOUNT required!");
      },
    });
    const r = await call("get_subscription_status", { accountId: 42 });
    assert.equal(r.isError, true);
    assert.match(r.text, /Not found in marketplace GR/);
    assert.match(r.text, /PRODUCT_ACCOUNT required/);
  });

  it("a timeout is reported as a timeout, not as not found", async () => {
    const call = await connect({
      GetCompany: () => {
        throw new Error("The operation was aborted due to timeout");
      },
    });
    const r = await call("get_customer_overview", { accountId: 7 });
    assert.equal(r.isError, true);
    assert.match(r.text, /timeout/);
    assert.doesNotMatch(r.text, /Not found/);
  });
});
