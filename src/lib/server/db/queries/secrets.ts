import { getDb, now } from '../index.ts';
import type { UserSecret, UserSecretMeta } from '../types.ts';

interface UserSecretRow {
	user_id: string;
	name: string;
	value: string;
	created_at: number;
	updated_at: number;
}

function rowToMeta(row: UserSecretRow): UserSecretMeta {
	return {
		createdAt: row.created_at,
		name: row.name,
		updatedAt: row.updated_at,
		userId: row.user_id
	};
}

function rowToSecret(row: UserSecretRow): UserSecret {
	return {
		...rowToMeta(row),
		value: row.value
	};
}

const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function isValidSecretName(name: string): boolean {
	return NAME_RE.test(name);
}

export async function listSecretNamesForUser(userId: string): Promise<UserSecretMeta[]> {
	const res = await getDb()
		.prepare(
			`SELECT user_id, name, '' AS value, created_at, updated_at
			 FROM user_secrets WHERE user_id = ? ORDER BY name ASC`
		)
		.bind(userId)
		.all<UserSecretRow>();
	return res.results.map(rowToMeta);
}

export async function getSecretsForUser(userId: string): Promise<UserSecret[]> {
	const res = await getDb()
		.prepare(
			`SELECT user_id, name, value, created_at, updated_at
			 FROM user_secrets WHERE user_id = ? ORDER BY name ASC`
		)
		.bind(userId)
		.all<UserSecretRow>();
	return res.results.map(rowToSecret);
}

export async function upsertSecret(
	userId: string,
	name: string,
	value: string
): Promise<UserSecretMeta> {
	if (!isValidSecretName(name)) {
		throw new Error(
			`Invalid secret name: ${name}. Use uppercase letters, digits, and underscores; must start with a letter.`
		);
	}
	const ts = now();
	await getDb()
		.prepare(
			`INSERT INTO user_secrets (user_id, name, value, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(user_id, name) DO UPDATE
			   SET value = excluded.value, updated_at = excluded.updated_at`
		)
		.bind(userId, name, value, ts, ts)
		.run();
	const row = await getDb()
		.prepare(
			`SELECT user_id, name, '' AS value, created_at, updated_at
			 FROM user_secrets WHERE user_id = ? AND name = ?`
		)
		.bind(userId, name)
		.first<UserSecretRow>();
	if (!row) {
		throw new Error(`upsertSecret: row missing after upsert (user=${userId}, name=${name})`);
	}
	return rowToMeta(row);
}

export async function deleteSecret(userId: string, name: string): Promise<void> {
	await getDb()
		.prepare(`DELETE FROM user_secrets WHERE user_id = ? AND name = ?`)
		.bind(userId, name)
		.run();
}
