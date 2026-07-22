import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS projects (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    main_file_id UUID,
    -- Capability secret: whoever holds this can edit/delete anything in the
    -- project (see projects.ts / requireEditAccess in server.ts). The plain
    -- project id alone only grants read access. gen_random_uuid() has been
    -- built into Postgres core since v13 — no extension needed.
    edit_token TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  // Upgrades a projects table created before edit_token existed.
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS edit_token TEXT`,
  `UPDATE projects SET edit_token = gen_random_uuid()::text WHERE edit_token IS NULL`,
  `ALTER TABLE projects ALTER COLUMN edit_token SET DEFAULT gen_random_uuid()::text`,
  `ALTER TABLE projects ALTER COLUMN edit_token SET NOT NULL`,
  `CREATE TABLE IF NOT EXISTS files (
    id UUID PRIMARY KEY,
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'binary')),
    content TEXT,
    storage_key TEXT,
    content_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, path)
  )`,
  `CREATE INDEX IF NOT EXISTS files_project_id_idx ON files (project_id)`,
];

/** Plain, idempotent CREATE TABLE IF NOT EXISTS migrations — no separate migration tool/history table needed at this scale. */
export async function runMigrations(): Promise<void> {
  for (const statement of MIGRATIONS) {
    await pool.query(statement);
  }
}
