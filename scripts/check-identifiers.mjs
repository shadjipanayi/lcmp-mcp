// Fails if a tracked file contains a GUID, e.g. a subscription, tenant or app ID. The repo is public:
// deployment identifiers belong in .env or a git-ignored parameter file, and docs use placeholders.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Public, well-known IDs that are fine to publish.
const ALLOWED = new Set([
  "04b07795-8ddb-461a-bbee-02f9e1bf7b46", // Microsoft's Azure CLI client ID
]);
// Vendored or synthetic content: the API spec's examples, lockfiles, test fixtures, vendored skills.
const SKIPPED = [/^package-lock\.json$/, /^openapi\.json$/, /^test\//, /^\.claude\/skills\//];
const GUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !SKIPPED.some((re) => re.test(f)));

const hits = [];
for (const file of files) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      for (const [guid] of line.matchAll(GUID)) {
        if (!ALLOWED.has(guid.toLowerCase())) hits.push(`${file}:${i + 1}: ${guid}`);
      }
    });
}

if (hits.length) {
  console.error("GUIDs found in tracked files. Replace them with placeholders, or allowlist a public ID in scripts/check-identifiers.mjs:");
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.error(`check-identifiers: ${files.length} files clean`);
