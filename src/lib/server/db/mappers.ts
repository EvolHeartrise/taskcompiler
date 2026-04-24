// Run a single-row D1 query and map the result to its camelCase domain
// shape, or null if no row matched. Saves the boilerplate `row ? mapRow(row) : null`
// at every single-row lookup site.
export async function fetchOne<R extends object, D>(stmt: D1PreparedStatement): Promise<D | null> {
	const row = await stmt.first<R>();
	return row ? mapRow<D>(row) : null;
}

// Run a multi-row D1 query and map each result to its camelCase domain
// shape. Saves the boilerplate `res.results.map((r) => mapRow(r))` at every
// list lookup site.
export async function fetchAll<R extends object, D>(stmt: D1PreparedStatement): Promise<D[]> {
	const res = await stmt.all<R>();
	return res.results.map((r) => mapRow<D>(r));
}

// Convert a snake_case row from D1 to its camelCase domain shape. Pass
// `skip` to exclude columns the caller will layer on top (JSON-decoded or
// boolean-coerced fields); the returned object is cast to the caller's
// Omit<T, ...> type.
export function mapRow<T>(row: object, skip: readonly string[] = []): T {
	const skipSet = new Set(skip);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(row)) {
		if (skipSet.has(key)) {
			continue;
		}
		let camel = '';
		let capitalize = false;
		for (const ch of key) {
			if (ch === '_') {
				capitalize = true;
			} else if (capitalize) {
				camel += ch.toUpperCase();
				capitalize = false;
			} else {
				camel += ch;
			}
		}
		out[camel] = value;
	}
	return out as T;
}
