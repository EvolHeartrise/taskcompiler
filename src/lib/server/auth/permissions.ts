// Server-side companion to `$lib/permissions.ts` — re-exports the shared
// matrix/`can()` and adds `requireCan()`, which throws a SvelteKit 403.
// Server code should keep importing from here so the audit-trail breadcrumb
// "yes, we ran the role check on the server" is unambiguous.

import { error } from '@sveltejs/kit';
import { can, type ProjectAction, type ProjectRole } from '$lib/permissions';

export { can };
export type { ProjectAction, ProjectRole };

// Stable, audit-friendly forbidden marker. Throws a SvelteKit 403 so it
// surfaces as a clean HTTP response in both remote functions and form
// actions. Catch sites that need a softer failure mode (e.g. returning
// `{ ok: false, error }`) should use `can()` directly instead.
export function requireCan(role: ProjectRole, action: ProjectAction): void {
	if (!can(role, action)) {
		error(403, `forbidden: role '${role}' cannot perform '${action}'`);
	}
}
