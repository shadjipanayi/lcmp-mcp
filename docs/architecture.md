# Architecture

How the server is put together. Read the section for the area you're changing; terms (root, reseller, customer, CSP model, effective end-date action, urgency, ...) are defined in [GLOSSARY.md](../GLOSSARY.md).

## The live API vs `openapi.json`

`openapi.json` is the local copy of the SimpleAPI spec: use it for operation names, request body fields and response shapes. The live API differs from it (verified on CYMA):

- Report rows are `Rows[{Cells}]`.
- Subscriptions have `ProvisioningStatus` (not `Status`).
- Only `GetSubscription` returns the term dates (`PriceProtectionEndDate`, `AdvancePeriodEndAction`, `ContractEndDate`); the `GetSubscriptions` list doesn't.
- Legacy monthly subscriptions have no `AdvancePeriodEndAction`/`AdvancePeriodEndDate` at all; their `BillingType` product field is "Monthly".
- The country root account (`GetCompany({})`) has `AccountType: "Reseller"`, like the resellers under it.
- Microsoft products' technical names start with `156469_`.
- Product fields include secrets such as the tenant `InitialPassword`: `redactSecrets` in `src/tools/helpers.ts` blanks them in every tool result.

Every operation is `POST {baseUrl}/{OperationName}` with a JSON body. Success responses are JSON (or empty); error responses are usually XML.

## Entry points

`src/index.ts` picks the transport: stdio by default, HTTP with `--http` or `MCP_TRANSPORT=http`. `src/server.ts` `createServer(registry)` registers all tools, and its `instructions` string tells the model which tools to start with: update it when adding tools. `ping` (checks every marketplace login) is registered there too.

`src/http.ts` serves stateless `POST /mcp` (a fresh `McpServer` per request; caches live in the registry) and `GET /health`. `src/auth.ts` validates Entra ID tokens (tenant JWKS, v1/v2 issuer, audience, required app role `LCMP.Read`); HTTP mode won't start without `ENTRA_TENANT_ID`/`ENTRA_AUDIENCE` unless `MCP_AUTH=none` on a loopback host. The `Dockerfile` builds the hosted image; deployment steps are in [deploy-azure.md](deploy-azure.md).

## API client (`src/client.ts`)

`LcmpClient` logs in lazily with `GetSessionToken`, sends `Authenticate: CCPSessionId <token>`, shares one login between concurrent calls, and on a session error logs in again and retries once. A token is trusted for 3.5 h (`TOKEN_TTL_MS`) after login or its last check, then verified with `PingPong` and replaced only if invalid. Sessions are never terminated: each marketplace's API user is shared by the whole team.

Callers state a `Workload`, never a timeout. The client owns the timeouts and FIFO lanes:

| Workload | For | In flight | Timeout |
| --- | --- | --- | --- |
| `quick` (default) | single lookups | `LCMP_MAX_CONCURRENCY` (3) | `LCMP_TIMEOUT_MS` (30 s) |
| `bulk` | per-item fan-outs in reviews and the name-search directory | 2, shared by all tools | 30 s |
| `heavy` | reports and big lists | 2 | 300 s |

Start a bulk fan-out's calls together; the lane queues them. A fan-out someone is waiting on (e.g. `get_customer_overview`'s subscription details) uses `fetchSubscriptions(..., "interactive")`: quick lane, 2 at a time, so it doesn't queue behind a colleague's review. The token check bypasses the lanes. Tools depend on the `LcmpPort` interface; `fetch` and the clock are injectable (see `test/client.test.ts`).

`src/errors.ts` holds `LcmpApiError` (`isSessionError` drives the retry), `extractErrorMessage` (a readable message from XML/JSON/text error bodies), and `NotFoundError` with `lookup()` / `optional()`: `lookup()` turns only the API's "not in this marketplace" errors ("Invalid account id", "Not enough permissions to get account details", ...) into `NotFoundError`, carrying the API's wording because the API says the same for a wrong ID and a missing permission. Everything else is rethrown. `optional()` turns `NotFoundError` into `undefined` for secondary lookups.

## Marketplaces (`src/marketplaces.ts`)

One `Marketplace` per country (same base URL, a dedicated API user each) in a `MarketplaceRegistry`, built by `createMarketplace`. Each owns its client, an `Accounts` and an `Invoices` module, so caches belong to the marketplace instance. Every call targets exactly one marketplace: tools get an injected `marketplace` input (required unless only one is configured), and `runInMarketplace` resolves it, runs the call and labels the result. A lookup that returns `undefined` or throws `NotFoundError` becomes a "not found in this marketplace" error. Each marketplace has a local time zone (`KNOWN_MARKETPLACES`), used for "today".

## Domain modules

- **`src/accounts.ts` (`Accounts`)**: hierarchy root → resellers (`GetCompanies(root)`) → customers (`GetCompanies(reseller)`). Lookup by ID (GetCompany, then GetReseller on "not here"), by VAT ID (several matches is an error listing them), name search over a 6 h directory (concurrent builds shared), `role` (root told apart by its ID) and `resellerOf`.
- **`src/invoices.ts` (`Invoices`)**: marketplace-wide invoice downloads (minutes each), cached 6 h for closed months and 15 min for the preview. Invoices go to resellers; a customer's lines are matched by subscription `AccountId` or `EndCustomerName`.
- **`src/subscription.ts`**: every subscription rule. `describeSubscription(record, timeZone)` returns one view (CSP model, Legacy monthly, end date and source, days left, urgency, stored and effective end-date action); `fetchSubscription(s)` fetches. Tools never re-derive these.
- **`src/reports.ts`**: `executeReport` is the only path to `ExecuteReport` and refuses `BLOCKED_REPORTS` (`src/knowledge.ts`); `runReport` + `reportToRecords` turn the `Columns[{Name,CellIndex}]` / `Rows[{Cells}]` table into records and drop `ZZ_Total` summary rows; `pick` looks up columns case-insensitively. `settle({label: promise})` runs a tool's independent parts and keeps what worked plus `"<label>: <error>"` entries.
- **`src/seats.ts`**: `readSeats`, the typed reader for "MSCSPSeats", the report several reviews share. A report that more tools start sharing gets a reader like it.
- **`src/knowledge.ts`**: report names and technical product codes used in production, embedded in tool descriptions, and `BLOCKED_REPORTS` (reports that overload the platform).

## Tools (`src/tools/`)

- **Raw read tools** are declared as data (`ReadToolSpec`: `name`, `operation`, `title`, `description`, zod `input`, optional `transform` and `workload`), grouped by domain, and registered with `registerReadTools`. Zod input keys are sent verbatim as the request body, so they must match the API's field names; undefined optional args are stripped. Shared field schemas (`accountId`, `resellerContext`, `serviceFilters`, ...) live in `helpers.ts`. List tools return compact rows through a `transform` (a country's full reseller records are ~200k characters); give new list tools the same treatment.
- **Support tools** (`support.ts`): `find_account`, `get_customer_overview`, `get_subscription_status`, `get_customer_invoices`, built on the domain modules above.
- **Review tools** (`runbooks.ts`, `review_*`) port the business rules of the PowerShell runbooks in `C:\Users\s.hadjipanayi\Documents\LogicomCloudBU\CloudBUAA-New\runbooks` (read-only reference: thresholds, NCE vs Legacy, end-date precedence). Each names its source runbook in its description; when a runbook's logic changes, update the matching tool. A runbook's write step is reported as `suggestedAction`.
- Composite tools are registered with `registerCompositeTool` (`run(args, client, marketplace)`).

`formatResult` redacts secrets, serialises compact JSON and truncates at `MAX_RESPONSE_CHARS` (100k). Tool errors are returned as `isError` content. `handle()` in `helpers.ts` wraps every call and writes one JSON `tool_call` line to stderr (tool, marketplace, Entra user, duration, outcome; never arguments).
