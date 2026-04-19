import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dataDir = resolve(process.env.RUNELY_DATA_DIR ?? "./data");
const dbPath = join(dataDir, "runely.db");

mkdirSync(dataDir, { recursive: true });

export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");

export function runMigrations(): void {
	const sql = readFileSync(schemaPath, "utf8");
	db.exec(sql);
}

runMigrations();

export function uuid(): string {
	return crypto.randomUUID();
}

export function now(): number {
	return Date.now();
}
