export async function fetchOne<R extends object, D>(stmt: D1PreparedStatement): Promise<D | null> {
	const row = await stmt.first<R>();
	return row ? mapRow<D>(row) : null;
}

export async function fetchAll<R extends object, D>(stmt: D1PreparedStatement): Promise<D[]> {
	const res = await stmt.all<R>();
	return res.results.map((r) => mapRow<D>(r));
}

// Use when domain fields need a transform mapRow can't do — JSON parsing,
// boolean coercion, or camel-renames that don't follow snake_case rules.
export function rowToDomain<R extends object, D>(
	row: R,
	skipCols: readonly string[],
	layers: Partial<D>
): D {
	return { ...mapRow<Partial<D>>(row, skipCols), ...layers } as D;
}

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
