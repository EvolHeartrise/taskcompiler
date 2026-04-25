// Shared per-project permission matrix. Imported by both server code and
// Svelte components — must stay free of server-only deps. The server-side
// `requireCan` (which throws SvelteKit 403s) lives in
// `$lib/server/auth/permissions.ts` and re-exports `can` and the types
// from here.
//
// Add a new action by extending `ProjectAction` and the `MATRIX` below —
// every cell is a deliberate choice and a missing entry counts as "deny".

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
