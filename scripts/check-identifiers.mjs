// Fails if a tracked file contains a deployment identifier: a GUID (subscription, tenant or app ID) or an Azure or
// Power Platform host name. The repo is public: deployment identifiers belong in .env or a git-ignored parameter
// file, and docs use placeholders. Runs in CI and as the pre-commit hook (.githooks/pre-commit).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Public, well-known IDs that are fine to publish.
const ALLOWED = new Set([
  "04b07795-8ddb-461a-bbee-02f9e1bf7b46", // Microsoft's Azure CLI client ID
]);
// Vendored or synthetic content: the API spec's examples, lockfiles, test fixtures, vendored skills.
const SKIPPED = [/^package-lock\.json$/, /^openapi\.json$/, /^test\//, /^\.claude\/skills\//];
const PATTERNS = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  // A concrete (lower-case) host. Placeholders (HOST.azurecontainerapps.io, <app>.<env>.azurecontainerapps.io) and
  // shell variables ($ACR.azurecr.io) don't match.
  /(?<![$\w.{}-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:azurecontainerapps\.io|azurecr\.io|vault\.azure\.net|dynamics\.com|onmicrosoft\.com)\b/g,
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !SKIPPED.some((re) => re.test(f)));

const hits = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const re of PATTERNS) {
        for (const [id] of line.matchAll(re)) {
          if (!ALLOWED.has(id.toLowerCase())) hits.push(`${file}:${i + 1}: ${id}`);
        }
      }
    });
}

if (hits.length) {
  console.error("Deployment identifiers found in tracked files. Replace them with placeholders, or allowlist a public ID in scripts/check-identifiers.mjs:");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.error(`check-identifiers: ${files.length} files clean`);
