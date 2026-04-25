// Granular per-project permissions. Single source of truth for "is role X
// allowed to do Y on a project?". Add a new action by extending
// `ProjectAction` and the `MATRIX` below — every cell is a deliberate choice
// and a missing entry counts as "deny".
//
// Convention: every project-scoped server entry resolves the caller's role
// (via `getProjectForUser`) and calls `requireCan(role, action)` before
// touching state. Read endpoints can use `'workflow.viewHistory'` /
// `'workflow.viewCode'` — those are allowed for every role and serve as an
// audit-trail breadcrumb that says "yes, we ran the role check here".

import { error } from '@sveltejs/kit';
import type { ProjectRole } from '$lib/server/db/types';

export type { ProjectRole };

export type ProjectAction =
	| 'workflow.create'
	| 'workflow.edit'
	| 'workflow.delete'
	| 'workflow.run'
	| 'workflow.viewHistory'
	| 'workflow.viewCode'
	| 'secret.manage'
	| 'eventSource.manage'
	| 'member.invite'
	| 'invite.revoke'
	| 'member.remove'
	| 'project.rename'
	| 'project.delete'
	// Future-task-8 mutations. The matrix already encodes who's allowed; the
	// route handlers don't exist yet.
	| 'member.changeRole'
	| 'project.transferOwnership'
	// Role someone is allowed to invite *as* — composed with `member.invite`.
	| 'invite.role.admin'
	| 'invite.role.editor';

const OWNER_ACTIONS: readonly ProjectAction[] = [
	'workflow.create',
	'workflow.edit',
	'workflow.delete',
	'workflow.run',
	'workflow.viewHistory',
	'workflow.viewCode',
	'secret.manage',
	'eventSource.manage',
	'member.invite',
	'invite.revoke',
	'member.remove',
	'project.rename',
	'project.delete',
	'member.changeRole',
	'project.transferOwnership',
	'invite.role.admin',
	'invite.role.editor'
];

const ADMIN_ACTIONS: readonly ProjectAction[] = [
	'workflow.create',
	'workflow.edit',
	'workflow.delete',
	'workflow.run',
	'workflow.viewHistory',
	'workflow.viewCode',
	'secret.manage',
	'eventSource.manage',
	'member.invite',
	'invite.revoke',
	'member.remove',
	'project.rename',
	'member.changeRole',
	'invite.role.admin',
	'invite.role.editor'
];

const EDITOR_ACTIONS: readonly ProjectAction[] = [
	'workflow.create',
	'workflow.edit',
	'workflow.delete',
	'workflow.run',
	'workflow.viewHistory',
	'workflow.viewCode',
	'eventSource.manage'
];

const MATRIX: Record<ProjectRole, ReadonlySet<ProjectAction>> = {
	owner: new Set(OWNER_ACTIONS),
	admin: new Set(ADMIN_ACTIONS),
	editor: new Set(EDITOR_ACTIONS)
};

export function can(role: ProjectRole, action: ProjectAction): boolean {
	return MATRIX[role].has(action);
}

// Stable, audit-friendly forbidden marker. Throws a SvelteKit 403 so it
// surfaces as a clean HTTP response in both remote functions and form
// actions. Catch sites that need a softer failure mode (e.g. returning
// `{ ok: false, error }`) should use `can()` directly instead.
export function requireCan(role: ProjectRole, action: ProjectAction): void {
	if (!can(role, action)) {
		error(403, `forbidden: role '${role}' cannot perform '${action}'`);
	}
}
