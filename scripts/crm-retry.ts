// Retry Zoho updates that are pending or failed (e.g. after a Zoho outage).
//
//   npm run crm:retry                       retry everything due
//   npm run crm:retry -- --purchase <id>    retry one purchase
//   npm run crm:retry -- --include-permanent  also re-queue non-retryable failures (after fixing the Deal/config)

import { config } from "dotenv";
config({ path: ".env.local" });

import { retryDueSyncs, syncPurchase } from "@/lib/crm-sync";

async function main() {
  const args = process.argv.slice(2);
  const purchaseIdx = args.indexOf("--purchase");
  const purchaseId = purchaseIdx >= 0 ? args[purchaseIdx + 1] : undefined;

  const results = purchaseId
    ? [await syncPurchase(purchaseId)]
    : await retryDueSyncs({ includePermanent: args.includes("--include-permanent") });

  if (results.length === 0) console.log("Nothing to retry: every CRM update is synced.");
  for (const r of results) console.log(`${r.purchaseId}  ${r.status}${r.error ? `  ${r.error}` : ""}`);
  if (results.some((r) => r.status === "failed" || r.status === "failed_permanent")) process.exit(1);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
