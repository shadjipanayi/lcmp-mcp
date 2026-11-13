# Deploy lcmp-mcp to Azure

The MCP server runs on **Azure Container Apps**, protected by **Entra ID**, with the marketplace credentials in
**Key Vault**. Copilot Studio (or any MCP client) calls it at `https://<app>.azurecontainerapps.io/mcp`.

[`scripts/deploy-azure.sh`](../scripts/deploy-azure.sh) does the work, and this page explains its choices. The current
deployment's names and IDs are in [azure-deployment.md](azure-deployment.md).

## Before you start

- **Azure CLI**, signed in, with **Owner** (or **Contributor + User Access Administrator**) on the resource group.
  Stage 8 assigns roles, which needs the second one.
- **Entra ID role** that can create app registrations and grant admin consent: **Cloud Application Administrator**
  is enough.
- **Node.js 20.6 or later**, and **Git Bash** on Windows.
- **One read-only MCP API user per country** (`Marketplace` user, no MFA). Each one must be **on that marketplace's
  AllowList**, which the Logicom team manages. Without it, logins from Azure are refused, even though the same user can
  log in from the office. Put each user's credentials in `.env` as `LCMP_<CODE>_USERNAME` and `LCMP_<CODE>_PASSWORD`,
  or type them when the script asks.
- **[`scripts/azure.conf`](../scripts/azure.conf)** filled in with the subscription, resource group and names. For a new
  deployment, pick new `ACR` and `KV` names, because both must be unique across Azure.

## Run it

From the repo root in Git Bash:

```bash
scripts/deploy-azure.sh            # walk through every stage
scripts/deploy-azure.sh status     # read-only report: what exists, secrets vs .env, recent tool calls, live checks
```

Each stage first looks up what already exists, then creates only what's missing. So if it stops, run it again and it
continues from where it stopped. `status` doesn't change anything, so it's always safe to run, including while a stage
is still waiting in another window.

| Stage | What it sets up | Why |
| --- | --- | --- |
| 1. Prerequisites | Subscription, `containerapp` CLI extension, resource providers | |
| 2. API app registration | "LCMP MCP API" with app role `LCMP.Read`, scope `access_as_user`, v2 tokens; Azure CLI pre-authorised; role assignment **required** | Tokens are issued *for* this registration. With assignment required, people without the role can't even get a token. The pre-authorisation lets `status` test the server with your own token |
| 3. Access | `LCMP.Read` for the `ACCESS_GROUP` in `azure.conf`, and for you unless you're in that group | Only direct members of the group get the role. Group assignment needs Entra ID P1. A mail distribution list works too, but then whoever manages the list decides who has access |
| 4. Copilot Studio client app | "LCMP MCP - Copilot Studio" with admin consent for `access_as_user`, and a client secret | The secret is **shown once**: save it in your password manager. It expires after a year (see [Renewing the client secret](#renewing-the-client-secret)) |
| 5. Hosting | Log Analytics workspace, Container Apps environment, registry | |
| 6. Image | `lcmp-mcp:<version from package.json>`, built by ACR from your checkout | Docker isn't needed, and `.dockerignore` keeps `.env` out of the upload |
| 7. Key Vault | The vault, your *Key Vault Secrets Officer* role, `lcmp-<code>-username` and `-password` for each country | Values come from `.env` (parsed the way the server parses it) or are typed in; invisible characters are removed |
| 8. Managed identity | One identity with *AcrPull* and *Key Vault Secrets User* | The app pulls its image and reads its secrets with no passwords in its configuration |
| 9. Container App | The app, Key Vault references for each country, Entra settings | See [Why one replica](#why-one-replica) |
| 10. Checks | `/health`, `401` without a token, `ping` for each country with your token | |
| 11. Copilot Studio | Prints the values to enter, registers the redirect URL you paste | See [Copilot Studio](#copilot-studio) |

## Everyday commands

| Command | Use it to |
| --- | --- |
| `scripts/deploy-azure.sh status` | See what exists and whether it works |
| `scripts/deploy-azure.sh update` | Ship code changes. Bump `version` in `package.json` first: it refuses to rebuild an existing tag, because the app wouldn't roll to the same tag |
| `scripts/deploy-azure.sh credentials <CODE>` | Change a country's username or password. It reloads the app immediately, rather than waiting up to 30 minutes for Key Vault |
| `scripts/deploy-azure.sh restart` | Restart the running revision |
| Add a country to `MARKETPLACES` in `azure.conf`, then run `scripts/deploy-azure.sh` | Enable another country. Its API user must be on that marketplace's AllowList first |

To roll back, point the app at an earlier tag: `az acr repository show-tags -n <ACR> --repository lcmp-mcp`, then
`az containerapp update -g <RG> -n lcmp-mcp --image <ACR>.azurecr.io/lcmp-mcp:<tag>`.

## Why one replica

- **Exactly one replica, always on.** API sessions, the customer-name directory and the invoice cache live in memory.
  More replicas would mean more logins and separate caches; scaling to zero would lose them all, and the first request
  after a quiet spell would be slow. Updates and restarts still empty the caches, and during an update the old and new
  versions run side by side for a moment, so each logs in once.
- **Always on costs money even when idle.** One 1 CPU / 2 GiB replica running all month is billed in full.
- **2 GiB memory.** The invoice cache holds whole country-months of invoices.
- The image sets `MCP_TRANSPORT=http`, `HOST=0.0.0.0` and `PORT=3000`. Container Apps ignores the Dockerfile's
  `HEALTHCHECK`; it only checks that port 3000 accepts connections.

## Copilot Studio

Stage 11 prints the server URL, client ID, sign-in URLs and scopes, and opens Copilot Studio. There, open your agent,
go to **Tools → Add a tool → New tool → Model Context Protocol**, and choose **OAuth 2.0, Manual**. Menu names change
from time to time, so look for the option to add an MCP server. After you create the tool, paste the redirect URL it
shows back into the script.

Then set the tool's **Credentials to use** to **End user credentials**. With maker-provided credentials, every user's
calls run as you: the `LCMP.Read` check only ever sees your account, so anyone who can chat with the agent gets in, and
the usage log records every call under your name.

The agent's description, instructions, starter prompts and settings are in
[copilot-studio-agent.md](copilot-studio-agent.md).

### Renewing the client secret

The client secret expires after a year (`status` shows the date). Before then, run
`az ad app credential reset --id <client app ID> --display-name copilot-studio --years 1 --append`, then put the new
secret in Copilot Studio.

## Troubleshooting

Start with `scripts/deploy-azure.sh status`.

| Symptom | Likely cause |
| --- | --- |
| `ping` says "Login failed (HTTP 500): We couldn't sign you in" | The country's API user isn't on the marketplace's AllowList (ask the Logicom team; it can still work from the office). Otherwise `status` shows whether the stored credentials match `.env`, or the user has MFA |
| `/health` doesn't answer | The app didn't start: `az containerapp logs show -g <RG> -n lcmp-mcp --tail 50`. Usually a role from stage 8 wasn't active yet: `scripts/deploy-azure.sh restart` |
| Stage 9 hangs; `status` says the environment is suspended (`ManagedClusterSuspended`) | Azure suspended the environment's compute, and gives no reason. Delete the app and the environment, set a new `ENV_NAME` in `azure.conf`, and run the script again. The new environment can sit in `Waiting` for 10 to 15 minutes while the old one finishes deleting |
| Stage 6 fails with `TasksOperationsNotAllowed` | The subscription can't run ACR builds. The script prints the Docker Desktop commands to use instead |
| `401` with a token | Wrong audience or tenant: the app's `ENTRA_AUDIENCE` must contain the API app ID |
| `403` "not assigned the 'LCMP.Read' role" | Give the user the role (stage 3, or Entra admin centre → Enterprise applications → LCMP MCP API → Users and groups), then get a new token |
| Admin consent fails with "does not reference a valid application object" | Entra hasn't caught up with the new service principal. The script retries; if it still fails, run it again a minute later |

Some terminals (Git Bash on a Cloud PC, for example) mangle pasted text: an invisible `^[[200~` at the start of a
paste, and Ctrl+V typing an invisible character before the text. When the script asks for a password, paste with
**Shift+Insert** or right-click. The script also strips invisible characters before storing anything.

### Usage log

One line per tool call: `status` shows the last five, and the full log is in Log Analytics (it takes a few minutes
to arrive):

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "lcmp-mcp" and Log_s has "tool_call"
| extend e = parse_json(Log_s)
| project TimeGenerated, tool = e.tool, marketplace = e.marketplace, user = e.user, ms = e.ms, ok = e.ok, error = e.error
| order by TimeGenerated desc
```

`user` is the person who called the tool, from their Entra token. The marketplace login always uses the country's
shared API user.

## Known limits

- **Long requests.** Container Apps ends HTTP requests after about 4 minutes, and Copilot Studio gives tools less
  time than that. The support tools answer in seconds, but some checks take longer:
  - `review_seat_changes`: about 4 minutes;
  - `review_upcoming_renewals`: about 3 minutes;
  - `review_consumption_forecast`: over 5 minutes, so it fails;
  - the first `get_customer_invoices` per month and country: about 3 minutes, then cached.

  Expect these to time out in Copilot Studio; they work from Claude Code over stdio.
- **Outgoing IP.** Calls to `marketplace.logicom.net` come from Azure's shared outgoing addresses. No fixed IP is
  needed, provided the API user is on the AllowList.
- **Blackout windows.** Heavy reports time out during the platform's billing run (00:00-02:50 UTC) and Azure sync
  (05:30-06:30 UTC).
