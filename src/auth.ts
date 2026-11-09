import { InsufficientScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { type JWTVerifyGetKey, createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";

export interface EntraConfig {
  tenantId: string;
  /** Accepted `aud` values: the API's Application ID URI and/or its client ID. */
  audiences: string[];
  /** App role the caller must hold (the `roles` claim). Empty string disables the check. */
  requiredRole: string;
}

/**
 * Reads the Entra ID settings for the HTTP transport:
 *   ENTRA_TENANT_ID      directory (tenant) ID
 *   ENTRA_AUDIENCE       comma-separated accepted audiences, e.g. "api://<client-id>,<client-id>"
 *   ENTRA_REQUIRED_ROLE  app role users must be assigned (default "LCMP.Read"; set to "" to allow any user in the tenant)
 * Returns undefined when not configured.
 */
export function loadEntraConfig(env: NodeJS.ProcessEnv = process.env): EntraConfig | undefined {
  const tenantId = env.ENTRA_TENANT_ID?.trim();
  const audiences = (env.ENTRA_AUDIENCE ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (!tenantId && !audiences.length) return undefined;
  if (!tenantId || !audiences.length) throw new Error("Set both ENTRA_TENANT_ID and ENTRA_AUDIENCE.");
  return { tenantId, audiences, requiredRole: (env.ENTRA_REQUIRED_ROLE ?? "LCMP.Read").trim() };
}

/**
 * Validates Entra ID access tokens issued for this API: signature (tenant signing keys), issuer (v1 or v2
 * endpoint of the tenant), audience, expiry, and the required app role. The caller's UPN is attached for the
 * usage log.
 */
export function createEntraVerifier(cfg: EntraConfig, keys?: JWTVerifyGetKey): OAuthTokenVerifier {
  // `keys` is only passed by tests; in production the tenant's published signing keys are used.
  const jwks = keys ?? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${cfg.tenantId}/discovery/v2.0/keys`));
  const issuers = [`https://login.microsoftonline.com/${cfg.tenantId}/v2.0`, `https://sts.windows.net/${cfg.tenantId}/`];

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, jwks, { issuer: issuers, audience: cfg.audiences }));
      } catch (err) {
        const reason = err instanceof joseErrors.JOSEError ? err.code : "invalid token";
        throw new InvalidTokenError(`Access token rejected (${reason}).`);
      }
      const roles = Array.isArray(payload.roles) ? (payload.roles as string[]) : [];
      if (cfg.requiredRole && !roles.includes(cfg.requiredRole)) {
        throw new InsufficientScopeError(`The signed-in account is not assigned the '${cfg.requiredRole}' role.`);
      }
      const scopes = typeof payload.scp === "string" ? payload.scp.split(" ") : [];
      return {
        token,
        clientId: String(payload.azp ?? payload.appid ?? ""),
        scopes: [...scopes, ...roles],
        expiresAt: payload.exp,
        extra: {
          user: payload.preferred_username ?? payload.upn ?? payload.unique_name ?? payload.oid ?? null,
          oid: payload.oid ?? null,
        },
      };
    },
  };
}
