import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// Every collection is held in memory and written through to the backend. The demo runs as a
// single instance, so memory is the source of truth for reads and the backend for restarts.
export async function createStore({ dataDir, databaseUrl, pgModule }) {
  const collections = new Map();
  const backend = databaseUrl ? await postgresBackend(databaseUrl, pgModule) : await jsonBackend(dataDir);
  for (const [collection, docs] of Object.entries(await backend.loadAll())) {
    collections.set(collection, new Map(docs.map((doc) => [doc.id, doc])));
  }

  function bucket(collection) {
    if (!collections.has(collection)) collections.set(collection, new Map());
    return collections.get(collection);
  }

  return {
    kind: backend.kind,
    get: (collection, id) => bucket(collection).get(id) || null,
    list: (collection) => [...bucket(collection).values()],
    count: (collection) => bucket(collection).size,
    async put(collection, id, doc) {
      bucket(collection).set(id, doc);
      await backend.save(collection, id, doc, collections);
      return doc;
    },
    putImage: (id, mime, buffer) => backend.putImage(id, mime, buffer),
    getImage: (id) => backend.getImage(id),
  };
}

async function jsonBackend(dataDir) {
  const file = path.join(dataDir, "runtime.json");
  const imageDir = path.join(dataDir, "images");
  let writing = Promise.resolve();
  return {
    kind: "json-file",
    async loadAll() {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8"));
        return parsed.version === 2 ? parsed.collections : {};
      } catch {
        return {};
      }
    },
    async save(_collection, _id, _doc, collections) {
      const snapshot = { version: 2, collections: Object.fromEntries([...collections].map(([name, docs]) => [name, [...docs.values()]])) };
      // Serialize writes so concurrent requests cannot interleave temp-file renames.
      writing = writing.then(async () => {
        const temporary = `${file}.tmp`;
        await writeFile(temporary, JSON.stringify(snapshot, null, 2), "utf8");
        await rename(temporary, file);
      });
      return writing;
    },
    async putImage(id, mime, buffer) {
      await mkdir(imageDir, { recursive: true });
      await writeFile(path.join(imageDir, `${id}.jpg`), buffer);
    },
    async getImage(id) {
      try {
        return { mime: "image/jpeg", data: await readFile(path.join(imageDir, `${id}.jpg`)) };
      } catch {
        return null;
      }
    },
  };
}

async function postgresBackend(databaseUrl, pgModule) {
  const pg = pgModule || (await import("pg")).default;
  const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
  // TLS is configured here, so drop sslmode from the URL; otherwise pg lets it override `ssl`.
  const connectionString = databaseUrl.replace(/([?&])sslmode=[^&]*&?/, "$1").replace(/[?&]$/, "");
  const pool = new pg.Pool({ connectionString, max: 4, ssl: local ? false : { rejectUnauthorized: false } });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS w2w_docs (
      collection text NOT NULL,
      id text NOT NULL,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (collection, id)
    );
    CREATE TABLE IF NOT EXISTS w2w_images (
      id text PRIMARY KEY,
      mime text NOT NULL,
      data bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );`);
  return {
    kind: "postgres",
    async loadAll() {
      const { rows } = await pool.query("SELECT collection, data FROM w2w_docs");
      const grouped = {};
      for (const row of rows) (grouped[row.collection] ||= []).push(row.data);
      return grouped;
    },
    async save(collection, id, doc) {
      await pool.query(
        `INSERT INTO w2w_docs (collection, id, data, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [collection, id, doc],
      );
    },
    async putImage(id, mime, buffer) {
      await pool.query("INSERT INTO w2w_images (id, mime, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING", [id, mime, buffer]);
    },
    async getImage(id) {
      const { rows } = await pool.query("SELECT mime, data FROM w2w_images WHERE id = $1", [id]);
      return rows[0] ? { mime: rows[0].mime, data: rows[0].data } : null;
    },
  };
}
