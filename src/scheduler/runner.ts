import { KeepaClient } from "../adapter/client.js";
import { initDb } from "../storage/db.js";
import { runDailyCollection } from "./collector.js";

async function main() {
  console.log("[keepa-adapter] Starting daily collection...");

  const client = new KeepaClient();
  const db = await initDb();

  const result = await runDailyCollection(client, db);

  console.log(`[keepa-adapter] Collection complete:`);
  console.log(`  Snapshots: ${result.snapshots}`);
  console.log(`  Changes detected: ${result.changes.length}`);
  console.log(`  Errors: ${result.errors.length}`);
  console.log(`  Duration: ${result.duration_ms}ms`);

  if (result.changes.length > 0) {
    const critical = result.changes.filter((c) => c.severity === "critical");
    const warnings = result.changes.filter((c) => c.severity === "warning");
    console.log(`  Critical: ${critical.length}, Warnings: ${warnings.length}`);
  }

  if (result.errors.length > 0) {
    for (const err of result.errors) {
      console.error(`  Error for batch [${err.batch.join(",")}]: ${err.error}`);
    }
  }

  db.close();
}

main().catch((err) => {
  console.error("[keepa-adapter] Fatal:", err);
  process.exit(1);
});
