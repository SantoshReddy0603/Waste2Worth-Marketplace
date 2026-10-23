// Clears all deals, listings and photos so the next start re-seeds the demo catalog.
// Usage: npm run reset  (uses DATABASE_URL from .env when set, otherwise data/runtime.json)
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}

const databaseUrl = process.env.DATABASE_URL || "";
if (databaseUrl) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: databaseUrl.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, ""), ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false } });
  await client.connect();
  await client.query("DELETE FROM w2w_docs; DELETE FROM w2w_images;").catch((error) => {
    if (error.code !== "42P01") throw error;
  });
  await client.end();
  console.log("Cleared Postgres tables. Restart the server to re-seed the catalog.");
} else {
  await rm(path.join(ROOT, "data", "runtime.json"), { force: true });
  await rm(path.join(ROOT, "data", "images"), { recursive: true, force: true });
  console.log("Cleared data/runtime.json and data/images. Restart the server to re-seed the catalog.");
}
