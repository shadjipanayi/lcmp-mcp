// Run with `npm test`. No network: the API client is replaced by a fake, and Entra tokens are signed locally.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { createEntraVerifier } from "../src/auth.js";
import type { LcmpPort } from "../src/client.js";
import { MarketplaceRegistry } from "../src/marketplaces.js";
import { createServer } from "../src/server.js";
import { describeSubscription } from "../src/subscription.js";
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

describe("Subscription module", () => {
  const now = new Date("2026-11-09T12:00:00Z");
  const tz = "Europe/Athens";
  // Shapes as GetSubscription returns them on CYMA.
  const legacyMonthly = {
    AccountId: 1,
    AccountState: "Active",
    ServiceName: "156469_LGCMExchangeOnlinePlan1GOV_14349",
    ServiceDisplayName: "Exchange Online Plan 1 (Government Pricing)",
    PriceProtectionEndDate: "2026-11-30T00:00:00",
    Fields: [
      { Name: "BillingType", Value: "Monthly" },
      { Name: "Subscriptionenddate", Value: "2021-05-27T00:00:00Z" },
    ],
  };
  const legacyPrepaid = {
    ...legacyMonthly,
    AdvancePeriodEndAction: "Terminate",
    AdvancePeriodEndDate: "2027-04-04T05:48:46.007",
    Fields: [{ Name: "BillingType", Value: "Annually prepaid" }],
  };

  it("Legacy monthly subscriptions effectively renew, though no action is stored", () => {
    const v = describeSubscription(legacyMonthly, tz, now);
    assert.equal(v.cspModel, "Legacy");
    assert.equal(v.legacyMonthly, true);
    assert.equal(v.storedEndDateAction, null);
    assert.equal(v.effectiveEndDateAction, "Renew");
    assert.match(v.notes.join(" "), /renew every month/);
  });

  it("Legacy prepaid and NCE subscriptions keep their stored end-date action", () => {
    const prepaid = describeSubscription(legacyPrepaid, tz, now);
    assert.equal(prepaid.legacyMonthly, false);
    assert.equal(prepaid.effectiveEndDateAction, "Terminate");
    const nce = describeSubscription(
      { ...legacyPrepaid, ServiceDisplayName: "(NCE) Exchange Online (Plan 1)", Fields: [{ Name: "BillingType", Value: "Monthly (with 1-month commitment) - P1M" }] },
      tz,
      now,
    );
    assert.equal(nce.cspModel, "NCE");
    assert.equal(nce.legacyMonthly, null);
    assert.equal(nce.effectiveEndDateAction, "Terminate");
  });

  it("does not take 'nce' inside a word for NCE, unlike the runbooks' regex", () => {
    const v = describeSubscription({ ...legacyPrepaid, ServiceDisplayName: "Microsoft 365 E5 Compliance" }, tz, now);
    assert.equal(v.cspModel, "Legacy");
  });

  it("gives non-licences no CSP model and falls back to the contract end date", () => {
    const v = describeSubscription(
      {
        ServiceName: "156469_AzurePlan_88587",
        ServiceDisplayName: "Azure Plan",
        Fields: [{ Name: "Subscriptionenddatealignment", Value: "2026-05-31" }],
        ContractEndDate: "2026-12-12T00:00:00",
      },
      tz,
      now,
    );
    assert.equal(v.cspModel, null);
    assert.equal(v.endDate, "2026-12-12");
    assert.equal(v.endDateSource, "ContractEndDate");
  });

  it("prefers the price-protection end date and counts days left in the marketplace's time zone", () => {
    const sub = { ...legacyMonthly, PriceProtectionEndDate: "2026-11-10T00:00:00", ContractEndDate: "2027-12-01T00:00:00" };
    // 23:30 UTC on the 9th is already the 10th in Athens, so the end date is today there.
    const late = new Date("2026-11-09T23:30:00Z");
    assert.equal(describeSubscription(sub, "Europe/Athens", late).daysLeft, 0);
    assert.equal(describeSubscription(sub, "UTC", late).daysLeft, 1);
    assert.equal(describeSubscription(sub, tz, now).endDateSource, "PriceProtectionEndDate");
  });

  it("puts days left into the runbooks' urgency bands", () => {
    const at = (end: string) => describeSubscription({ ...legacyMonthly, PriceProtectionEndDate: end }, tz, now).urgency;
    assert.equal(at("2026-11-08T00:00:00"), "past_end_date");
    assert.equal(at("2026-12-10T00:00:00"), "urgent"); // 31 days
    assert.equal(at("2026-12-11T00:00:00"), "soon"); // 32 days
    assert.equal(at("2027-01-09T00:00:00"), "later"); // 61 days
    assert.equal(describeSubscription({ AccountId: 2 }, tz, now).urgency, null);
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
  const fake: LcmpPort = {
    async call(op: string, body: Record<string, unknown> = {}) {
      const h = handlers[op];
      if (!h) throw new Error(`${op} failed (HTTP 500): Invalid account id`);
      return h(body);
    },
  };
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

  it("execute_report refuses blocked heavy reports without calling the API, and runs the others", async () => {
    const asked: string[] = [];
    const call = await connect({
      ExecuteReport: (b) => {
        asked.push(String(b.reportName));
        return { Columns: [{ Name: "id", CellIndex: 0 }], Rows: [{ Cells: [1] }] };
      },
    });
    const blocked = await call("execute_report", { reportName: "failed provisioning STATISTICS", parameters: {} });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /disabled/);
    const allowed = await call("execute_report", { reportName: "MSCSPSeats", parameters: {} });
    assert.equal(JSON.parse(allowed.text).data.rowCount, 1);
    assert.deepEqual(asked, ["MSCSPSeats"]);
  });

  it("get_customer_overview and get_subscription_status give a Legacy monthly subscription the same effective action", async () => {
    const sub = {
      AccountId: 42,
      AccountState: "Active",
      ServiceName: "156469_LGCMExchangeOnlinePlan1GOV_14349",
      ServiceDisplayName: "Exchange Online Plan 1 (Government Pricing)",
      PriceProtectionEndDate: "2027-05-27T00:00:00",
      Fields: [{ Name: "BillingType", Value: "Monthly" }],
    };
    const call = await connect({
      GetCompany: (b) => [{ AccountId: b.accountId ?? 1, CompanyName: "Acme SA", AccountType: "Company" }],
      GetSubscriptions: () => [{ AccountId: 42, AccountState: "Active", ServiceName: sub.ServiceName }],
      GetSubscription: () => sub,
      GetCreditLimit: () => null,
      GetUsers: () => [],
    });
    const overview = await call("get_customer_overview", { accountId: 7 });
    assert.equal(overview.isError, false, overview.text);
    const row = JSON.parse(overview.text).data.subscriptions[0];
    const status = await call("get_subscription_status", { accountId: 42 });
    assert.equal(status.isError, false, status.text);
    const detail = JSON.parse(status.text).data;
    for (const v of [row, detail]) {
      assert.equal(v.cspModel, "Legacy");
      assert.equal(v.effectiveEndDateAction, "Renew");
      assert.equal(v.endDate, "2027-05-27");
    }
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
