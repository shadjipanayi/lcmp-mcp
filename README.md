# lcmp-mcp

Read-only [MCP](https://modelcontextprotocol.io) server for the Logicom Cloud Marketplace SimpleAPI
([spec](https://app.swaggerhub.com/apis/MarketplaceSimpleAPI/MarketplaceSimpleAPI/1.0.0), copy in `openapi.json`).
It lets internal and support staff look things up in any country marketplace from Claude, instead of logging in to
each marketplace separately. It never changes anything in the marketplace.

## What you can ask

**Support lookups:**

| Tool | Use it for |
| --- | --- |
| `find_account` | Find a reseller or customer by name, VAT ID or account ID, and see which reseller it belongs to |
| `get_customer_overview` | Account details, reseller, credit limit, users, and subscriptions with status, errors and end dates |
| `get_subscription_status` | One subscription: provisioning status and errors, NCE/Legacy, end date, days left, end-date action, scheduled termination, add-ons |
| `get_customer_invoices` | Invoice lines for a reseller, or a customer's lines on its reseller's invoices (last month, a given month, or preview) |

**Operational checks** (from the team's automation runbooks):
`review_provisioning_requests`, `review_credit_health`, `review_upcoming_renewals`, `review_nce_trials`,
`review_seat_changes`, `review_consumption_forecast`, `review_inactive_resellers`.

**Raw API tools**: 35 tools that each call one SimpleAPI read operation (`get_company`, `get_subscriptions`,
`execute_report`, ...).

Every call queries exactly one country marketplace, chosen with the `marketplace` input (`CYMA`, `GR`, ...).
There is no search across countries: if you don't name the country, Claude asks for it.
`marketplace` can be left out only when one marketplace is configured.

Example prompts:

- "Find the customer Acme in Cyprus and show me its subscriptions."
- "Why is subscription 1234567 in Romania not provisioned?"
- "Which CSP subscriptions in Greece end in the next 30 days?"
- "Show last month's invoice lines for UAE customer 2345678."

## Setup

```bash
npm install
npm run build
```

Configuration is through environment variables (template in `.env.example`):

| Variable | Description |
| --- | --- |
| `LCMP_BASE_URL` | `https://marketplace.logicom.net/SimpleAPI/SimpleAPIService.svc/rest` |
| `LCMP_MARKETPLACES` | Codes to enable: `CYMA, GR, ENET, RO, IT, SA, JO, LB, AE, QA, KW, OM, BH, MA` |
| `LCMP_<CODE>_USERNAME` / `LCMP_<CODE>_PASSWORD` | The read-only API user for that marketplace (no MFA) |
| `LCMP_TIMEOUT_MS` | Optional default timeout, 30000. Reports always use 300 s |
| `LCMP_MAX_CONCURRENCY` | Optional, quick API requests in flight per marketplace user, default 3. Reports and big lists use a separate queue of 2, so they never hold up quick lookups. Extra calls wait |

With only `LCMP_USERNAME` / `LCMP_PASSWORD` (and no `LCMP_MARKETPLACES`), the server runs for one marketplace.
For local runs, put the values in a `.env` file (git-ignored); `npm start`, `npm run dev` and `npm run inspect` load it.

### Add to Claude Code

Add the server to your user config (`~/.claude.json`) so it is available in every project:

```bash
claude mcp add-json lcmp --scope user '{
  "command": "node",
  "args": ["C:/path/to/lcmp-mcp/dist/index.js"],
  "env": {
    "LCMP_BASE_URL": "https://marketplace.logicom.net/SimpleAPI/SimpleAPIService.svc/rest",
    "LCMP_MARKETPLACES": "CYMA,GR",
    "LCMP_CYMA_USERNAME": "...", "LCMP_CYMA_PASSWORD": "...",
    "LCMP_GR_USERNAME": "...",   "LCMP_GR_PASSWORD": "..."
  }
}'
```

For Claude Desktop, put the same object under `mcpServers.lcmp` in `claude_desktop_config.json`.
Then check a login with the `ping` tool, e.g. "ping the LCMP Greece marketplace".

## Hosted mode (Azure, Copilot Studio)

Started with `--http` or `MCP_TRANSPORT=http`, the server speaks MCP Streamable HTTP instead of stdio:

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | MCP endpoint (stateless). Requires an Entra ID access token |
| `GET /health` | Liveness probe, no auth. Returns the version and configured marketplaces |

Extra settings:

| Variable | Description |
| --- | --- |
| `HOST` / `PORT` | Bind address, default `127.0.0.1:3000`. The Docker image uses `0.0.0.0:3000` |
| `ENTRA_TENANT_ID` | Your Entra tenant ID |
| `ENTRA_AUDIENCE` | Accepted token audiences: the API app registration's Application ID URI and/or client ID, comma-separated |
| `ENTRA_REQUIRED_ROLE` | App role a user must be assigned, default `LCMP.Read`. Assign it to the support group in Entra |

Requests without a valid token get `401`; signed-in users without the role get `403`. The server refuses to start in
HTTP mode without the Entra settings. For local tests only, `MCP_AUTH=none` disables authentication, and only works
with a loopback `HOST`.

Every tool call writes one JSON line to stderr (`event: "tool_call"`, tool, marketplace, signed-in user, duration,
outcome; no arguments), which Azure collects into Log Analytics.

The `Dockerfile` builds the hosted image (`node dist/index.js` with HTTP defaults).

## Good to know

- The server logs in to a marketplace on first use and reuses the session token. After 3.5 hours it checks the
  token with `PingPong` and logs in again only if the token is no longer valid. Sessions are never terminated,
  because each marketplace's MCP user is shared by the whole team.
- Searching customers by name lists every reseller's customers the first time for each marketplace (a minute or two);
  the list is then cached for 6 hours.
- Avoid heavy reports during the platform's billing run (00:00-02:50 UTC) and Azure sync (05:30-06:30 UTC). They time out.

## Testing

- `npm run smoke`: starts the server and calls a few tools against the SwaggerHub mock server (example data, no
  credentials needed). `ping` fails on the mock by design, because the mock can't answer empty responses.
- `npm test`: offline tests (no API calls) for password redaction, the Entra token check, date handling and the support tools.
- `npm run inspect`: opens the MCP Inspector UI.
