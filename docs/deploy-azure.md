# Deploy lcmp-mcp to Azure

This guide puts the MCP server on **Azure Container Apps**, protected by **Entra ID**, with the marketplace
credentials in **Key Vault**. At the end, Copilot Studio (or any MCP client) can call it at
`https://<your-app>.azurecontainerapps.io/mcp`.

What you will create, all in resource group `Cloud_BU_RG`:

| Resource | Purpose |
| --- | --- |
| Entra app registration "LCMP MCP API" | Defines who may call the server (app role `LCMP.Read`) |
| Entra app registration "LCMP MCP - Copilot Studio" | The client Copilot Studio signs in with |
| Container registry (ACR) | Stores the server image. Azure builds the image, so you don't need Docker |
| Key Vault | Holds the MCP API users' usernames and passwords |
| User-assigned managed identity | Lets the app pull the image and read the secrets, with no passwords in config |
| Log Analytics workspace + Container Apps environment | Hosting and logs |
| Container App `lcmp-mcp` | The server: one replica, always on |

Plan for about an hour. Steps 1 to 3 need an Entra admin (creating app registrations, granting admin consent,
assigning users).

## Before you start

- Azure CLI installed and signed in (`az login`), with **Owner** or **Contributor + User Access Administrator** on
  `Cloud_BU_RG`. Role assignments in step 6 need the second one.
- Permission to create app registrations and grant admin consent in Entra ID (Application Administrator or similar).
- The repo checked out locally. Run every command from the repo root, in **one Git Bash window**: later steps use
  variables set earlier. If the window closes, set the variables again (step 0).
- The read-only MCP API user for each country you want to enable (`Marketplace` user, no MFA).

> Git Bash on Windows rewrites arguments that start with `/` (like Azure resource IDs) into Windows paths. Step 0
> turns that off with `MSYS_NO_PATHCONV=1`. Without it, `az role assignment create --scope /subscriptions/...` fails.

## Step 0: Variables

```bash
export MSYS_NO_PATHCONV=1

SUBSCRIPTION="Microsoft Azure Sponsorship 12k"
RG=Cloud_BU_RG
APP=lcmp-mcp
ENV_NAME=lcmp-mcp-env
LAW=lcmp-mcp-logs
IDENTITY=lcmp-mcp-identity
SUFFIX=$RANDOM                       # registry and vault names must be unique across Azure
ACR=lcmpmcp$SUFFIX                   # letters and digits only
KV=lcmp-mcp-kv-$SUFFIX               # 3-24 characters
IMAGE_TAG=$(node -p "require('./package.json').version")

az account set --subscription "$SUBSCRIPTION"
LOC=$(az group show -n $RG --query location -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Region $LOC, tenant $TENANT_ID, registry $ACR, vault $KV, image tag $IMAGE_TAG"
```

Write down `ACR` and `KV`: you need the same names when you come back to update the app.

Register the resource providers once per subscription (harmless if already registered):

```bash
for p in Microsoft.App Microsoft.OperationalInsights Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.ManagedIdentity; do
  az provider register -n $p --wait
done
```

## Step 1: Entra app registration for the API

This registration represents the MCP server. Tokens are issued *for* it, and only users holding its `LCMP.Read`
role are let in.

```bash
API_APP_ID=$(az ad app create --display-name "LCMP MCP API" --sign-in-audience AzureADMyOrg --query appId -o tsv)
API_OBJ_ID=$(az ad app show --id $API_APP_ID --query id -o tsv)
ROLE_ID=$(node -e "console.log(crypto.randomUUID())")
SCOPE_ID=$(node -e "console.log(crypto.randomUUID())")

cat > api-app.json <<EOF
{
  "identifierUris": ["api://$API_APP_ID"],
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [{
      "id": "$SCOPE_ID", "value": "access_as_user", "type": "User", "isEnabled": true,
      "adminConsentDisplayName": "Use the LCMP MCP server",
      "adminConsentDescription": "Read-only access to the LCMP Marketplace through the MCP server.",
      "userConsentDisplayName": "Use the LCMP MCP server",
      "userConsentDescription": "Read-only access to the LCMP Marketplace through the MCP server."
    }]
  },
  "appRoles": [{
    "id": "$ROLE_ID", "value": "LCMP.Read", "isEnabled": true, "allowedMemberTypes": ["User"],
    "displayName": "LCMP MCP read access",
    "description": "Can use the read-only LCMP MCP server."
  }]
}
EOF
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$API_OBJ_ID" \
  --headers Content-Type=application/json --body @api-app.json
```

Let the Azure CLI request tokens for this API, so you can test the server from the command line in step 8. This is a
second update because it refers to the scope created above.

```bash
cat > api-preauth.json <<EOF
{ "api": { "preAuthorizedApplications": [
  { "appId": "04b07795-8ddb-461a-bbee-02f9e1bf7b46", "delegatedPermissionIds": ["$SCOPE_ID"] }
] } }
EOF
az rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$API_OBJ_ID" \
  --headers Content-Type=application/json --body @api-preauth.json
rm api-app.json api-preauth.json
```

(`04b07795-...` is Microsoft's fixed client ID for the Azure CLI.)

Create the service principal and make role assignment **required**, so people without the role can't even get a token:

```bash
API_SP_ID=$(az ad sp create --id $API_APP_ID --query id -o tsv)
az ad sp update --id $API_SP_ID --set appRoleAssignmentRequired=true
```

## Step 2: Give the support team the `LCMP.Read` role

Assign the role to a security group (needs Entra ID P1 or higher), or to individual users.

```bash
# A group:
PRINCIPAL_ID=$(az ad group show --group "<support group name>" --query id -o tsv)
# ...or one user at a time:
# PRINCIPAL_ID=$(az ad user show --id someone@logicom.net --query id -o tsv)

az rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$API_SP_ID/appRoleAssignedTo" \
  --headers Content-Type=application/json \
  --body "{\"principalId\":\"$PRINCIPAL_ID\",\"resourceId\":\"$API_SP_ID\",\"appRoleId\":\"$ROLE_ID\"}"
```

Assign yourself too, so you can run the tests in step 8. Later you manage access in the Entra admin centre:
**Enterprise applications → LCMP MCP API → Users and groups**.

## Step 3: Entra app registration for Copilot Studio

Copilot Studio signs users in through this client app and asks for the API's `access_as_user` scope.

```bash
CLIENT_APP_ID=$(az ad app create --display-name "LCMP MCP - Copilot Studio" --sign-in-audience AzureADMyOrg --query appId -o tsv)
az ad sp create --id $CLIENT_APP_ID -o none
az ad app permission add --id $CLIENT_APP_ID --api $API_APP_ID --api-permissions $SCOPE_ID=Scope
az ad app permission admin-consent --id $CLIENT_APP_ID
CLIENT_SECRET=$(az ad app credential reset --id $CLIENT_APP_ID --display-name copilot-studio --years 1 --query password -o tsv)
echo "Client ID: $CLIENT_APP_ID"
echo "Client secret (shown once, save it in your password manager): $CLIENT_SECRET"
```

The secret expires after a year. Put a reminder in your calendar to renew it (`az ad app credential reset ... --append`)
and update it in Copilot Studio. The redirect URI is added in step 9, once Copilot Studio shows it.

## Step 4: Logs, hosting environment and registry

```bash
az monitor log-analytics workspace create -g $RG -n $LAW -l $LOC -o none
LAW_ID=$(az monitor log-analytics workspace show -g $RG -n $LAW --query customerId -o tsv)
LAW_KEY=$(az monitor log-analytics workspace get-shared-keys -g $RG -n $LAW --query primarySharedKey -o tsv)

az containerapp env create -g $RG -n $ENV_NAME -l $LOC \
  --logs-workspace-id $LAW_ID --logs-workspace-key $LAW_KEY -o none

az acr create -g $RG -n $ACR --sku Basic -l $LOC -o none
```

Build the image in Azure from your local checkout. Docker isn't needed: ACR builds from the `Dockerfile`, and
`.dockerignore` keeps `.env` and your credentials out of the upload.

```bash
az acr build -r $ACR -t lcmp-mcp:$IMAGE_TAG .
```

## Step 5: Key Vault with the marketplace credentials

```bash
az keyvault create -g $RG -n $KV -l $LOC --enable-rbac-authorization true -o none
KV_ID=$(az keyvault show -n $KV --query id -o tsv)
ME=$(az ad signed-in-user show --query id -o tsv)
az role assignment create --role "Key Vault Secrets Officer" --assignee-object-id $ME \
  --assignee-principal-type User --scope $KV_ID -o none
```

Wait a minute for the role to take effect, then store one username and password per country. The commands read the
values without echoing them, so they don't end up in your shell history:

```bash
add_marketplace() {   # usage: add_marketplace CYMA
  local code=$(echo "$1" | tr '[:upper:]' '[:lower:]') user pass
  read -rp  "$1 MCP API username: " user
  read -rsp "$1 MCP API password: " pass; echo
  az keyvault secret set --vault-name $KV -n "lcmp-$code-username" --value "$user" -o none
  az keyvault secret set --vault-name $KV -n "lcmp-$code-password" --value "$pass" -o none
}

add_marketplace CYMA
# add_marketplace GR   ...one line per country you enable
```

## Step 6: Managed identity

One identity lets the app pull its image from ACR and read the secrets from Key Vault.

```bash
az identity create -g $RG -n $IDENTITY -l $LOC -o none
IDENTITY_ID=$(az identity show -g $RG -n $IDENTITY --query id -o tsv)
IDENTITY_PRINCIPAL=$(az identity show -g $RG -n $IDENTITY --query principalId -o tsv)
ACR_ID=$(az acr show -n $ACR --query id -o tsv)

az role assignment create --role AcrPull --assignee-object-id $IDENTITY_PRINCIPAL \
  --assignee-principal-type ServicePrincipal --scope $ACR_ID -o none
az role assignment create --role "Key Vault Secrets User" --assignee-object-id $IDENTITY_PRINCIPAL \
  --assignee-principal-type ServicePrincipal --scope $KV_ID -o none
```

Wait 1 to 2 minutes before step 7: new role assignments take a moment to apply, and the app can't start until they do.

## Step 7: Create the Container App

`MARKETPLACES` lists the countries whose credentials you stored in step 5. For each one, the app gets two secrets
(Key Vault references) and two environment variables pointing at them.

```bash
MARKETPLACES="CYMA"   # e.g. "CYMA,GR,RO"

SECRETS=() ; ENVS=()
for CODE in ${MARKETPLACES//,/ }; do
  c=$(echo $CODE | tr '[:upper:]' '[:lower:]')
  SECRETS+=("$c-user=keyvaultref:https://$KV.vault.azure.net/secrets/lcmp-$c-username,identityref:$IDENTITY_ID")
  SECRETS+=("$c-pass=keyvaultref:https://$KV.vault.azure.net/secrets/lcmp-$c-password,identityref:$IDENTITY_ID")
  ENVS+=("LCMP_${CODE}_USERNAME=secretref:$c-user" "LCMP_${CODE}_PASSWORD=secretref:$c-pass")
done

az containerapp create -g $RG -n $APP --environment $ENV_NAME \
  --image $ACR.azurecr.io/lcmp-mcp:$IMAGE_TAG \
  --registry-server $ACR.azurecr.io --registry-identity $IDENTITY_ID \
  --user-assigned $IDENTITY_ID \
  --ingress external --target-port 3000 \
  --min-replicas 1 --max-replicas 1 \
  --cpu 1.0 --memory 2.0Gi \
  --secrets "${SECRETS[@]}" \
  --env-vars "${ENVS[@]}" \
    LCMP_BASE_URL=https://marketplace.logicom.net/SimpleAPI/SimpleAPIService.svc/rest \
    LCMP_MARKETPLACES=$MARKETPLACES \
    ENTRA_TENANT_ID=$TENANT_ID \
    "ENTRA_AUDIENCE=api://$API_APP_ID,$API_APP_ID" \
    ENTRA_REQUIRED_ROLE=LCMP.Read \
  -o none

FQDN=$(az containerapp show -g $RG -n $APP --query properties.configuration.ingress.fqdn -o tsv)
echo "MCP endpoint: https://$FQDN/mcp"
```

Why these settings:

- **Exactly one replica, always on.** API sessions, the customer-name directory and the invoice cache live in memory.
  More than one replica would mean more logins and separate caches; scaling to zero would lose them all, and the
  first request after a quiet spell would be slow.
- **2 GiB memory.** The invoice cache holds whole country-months of invoices.
- The image already sets `MCP_TRANSPORT=http`, `HOST=0.0.0.0` and `PORT=3000`.

## Step 8: Check it works

```bash
curl -s https://$FQDN/health
# {"status":"ok","version":"0.3.0","marketplaces":["CYMA"]}

curl -s -o /dev/null -w "%{http_code}\n" -X POST https://$FQDN/mcp
# 401  (no token: refused, as it should be)
```

Now call it with your own token. This needs your user to hold the `LCMP.Read` role (step 2):

```bash
TOKEN=$(az account get-access-token --scope "api://$API_APP_ID/access_as_user" --query accessToken -o tsv)

curl -s https://$FQDN/mcp -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping","arguments":{"marketplace":"CYMA"}}}'
# ..."Connected: the session is valid."...
```

If something fails:

| Symptom | Likely cause |
| --- | --- |
| `/health` doesn't answer | The app didn't start. Run `az containerapp logs show -g $RG -n $APP --tail 50`. Usually a role from step 6 wasn't active yet: wait, then `az containerapp revision restart` |
| 401 with a token | Wrong audience or tenant. Check `ENTRA_AUDIENCE` contains the API app ID |
| 403 "not assigned the 'LCMP.Read' role" | Assign the role (step 2), then get a new token |
| `az account get-access-token` fails with AADSTS65001 | The Azure CLI pre-authorisation in step 1 is missing |
| `ping` says "Login failed" | Wrong username or password in Key Vault, or the MCP API user has MFA |

Watch the usage log, one line per tool call:

```bash
az containerapp logs show -g $RG -n $APP --follow
```

Or in Log Analytics (it can take a few minutes for logs to arrive):

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "lcmp-mcp" and Log_s has "tool_call"
| extend e = parse_json(Log_s)
| project TimeGenerated, tool = e.tool, marketplace = e.marketplace, user = e.user, ms = e.ms, ok = e.ok, error = e.error
| order by TimeGenerated desc
```

## Step 9: Connect Copilot Studio

In Copilot Studio, open your agent, then go to **Tools → Add a tool → New tool → Model Context Protocol**. Menu names
change from time to time; look for the option to add an MCP server. Fill in:

| Field | Value |
| --- | --- |
| Server name | LCMP Marketplace |
| Server description | Read-only lookups of Logicom Marketplace resellers, customers, subscriptions and invoices, one country at a time |
| Server URL | `https://<FQDN>/mcp` |
| Authentication | OAuth 2.0, **Manual** |
| Client ID | `$CLIENT_APP_ID` from step 3 |
| Client secret | `$CLIENT_SECRET` from step 3 |
| Authorization URL | `https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/authorize` |
| Token URL | `https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/token` |
| Refresh URL | same as the token URL |
| Scopes | `api://<API_APP_ID>/access_as_user offline_access` |

After you create the tool, Copilot Studio shows a **redirect URL**. Add it to the client app:

```bash
az ad app update --id $CLIENT_APP_ID --web-redirect-uris "<redirect URL from Copilot Studio>"
```

Then create the connection in Copilot Studio and sign in. Each user signs in with their own account, which is how the
usage log knows who asked what.

## Updating the server

After code changes, build a new image with a new tag (bump `version` in `package.json` first), then point the app at it.
Container Apps starts the new version, then retires the old one.

```bash
IMAGE_TAG=$(node -p "require('./package.json').version")
az acr build -r $ACR -t lcmp-mcp:$IMAGE_TAG .
az containerapp update -g $RG -n $APP --image $ACR.azurecr.io/lcmp-mcp:$IMAGE_TAG
```

Roll back by pointing the app at the previous image tag again (the registry keeps old images):

```bash
az acr repository show-tags -n $ACR --repository lcmp-mcp -o table
az containerapp update -g $RG -n $APP --image $ACR.azurecr.io/lcmp-mcp:<previous-tag>
```

## Adding a country later

1. Store its credentials: `add_marketplace GR` (step 5).
2. Add its secrets and settings to the app:

```bash
CODE=GR; c=gr
az containerapp secret set -g $RG -n $APP --secrets \
  "$c-user=keyvaultref:https://$KV.vault.azure.net/secrets/lcmp-$c-username,identityref:$IDENTITY_ID" \
  "$c-pass=keyvaultref:https://$KV.vault.azure.net/secrets/lcmp-$c-password,identityref:$IDENTITY_ID"
az containerapp update -g $RG -n $APP --set-env-vars \
  LCMP_MARKETPLACES=CYMA,GR \
  LCMP_${CODE}_USERNAME=secretref:$c-user LCMP_${CODE}_PASSWORD=secretref:$c-pass
```

Changing a password works the same way: update the Key Vault secret, then `az containerapp revision restart` so the
app reads it again.

## Known limits

- **Long requests.** Container Apps ends HTTP requests after about 4 minutes, and Copilot Studio gives tools less
  time than that. The support tools answer in seconds, but some checks take longer:
  - `review_seat_changes`: about 4 minutes;
  - `review_upcoming_renewals`: about 3 minutes;
  - `review_consumption_forecast`: over 5 minutes, so it fails;
  - the first `get_customer_invoices` per month and country: about 3 minutes, then cached.

  Expect these to time out in Copilot Studio; they work from Claude Code over stdio.
- **Outgoing IP.** Calls to `marketplace.logicom.net` come from Azure's shared outgoing addresses. If the Logicom API
  only accepts known IPs, the environment needs a fixed outgoing IP (a NAT gateway on a custom VNet), which this
  guide doesn't set up.
- **Blackout windows.** Heavy reports time out during the platform's billing run (00:00-02:50 UTC) and Azure sync
  (05:30-06:30 UTC). Nothing to configure; just avoid them.
