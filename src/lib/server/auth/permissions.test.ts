import { describe, expect, it } from 'bun:test';
import { can, type ProjectAction, type ProjectRole } from './permissions.ts';

// One row per (role, action). The matrix is small enough to keep static —
// catching a typo here is more valuable than collapsing this into a loop.
type Cell = readonly [ProjectRole, ProjectAction, boolean];

const CELLS: readonly Cell[] = [
	// Workflow CRUD: every role.
	['owner', 'workflow.create', true],
	['admin', 'workflow.create', true],
	['editor', 'workflow.create', true],
	['owner', 'workflow.edit', true],
	['admin', 'workflow.edit', true],
	['editor', 'workflow.edit', true],
	['owner', 'workflow.delete', true],
	['admin', 'workflow.delete', true],
	['editor', 'workflow.delete', true],
	// Run / view: every role.
	['owner', 'workflow.run', true],
	['admin', 'workflow.run', true],
	['editor', 'workflow.run', true],
	['owner', 'workflow.viewHistory', true],
	['admin', 'workflow.viewHistory', true],
	['editor', 'workflow.viewHistory', true],
	['owner', 'workflow.viewCode', true],
	['admin', 'workflow.viewCode', true],
	['editor', 'workflow.viewCode', true],
	// Secrets: owner + admin only.
	['owner', 'secret.manage', true],
	['admin', 'secret.manage', true],
	['editor', 'secret.manage', false],
	// Event sources: every role.
	['owner', 'eventSource.manage', true],
	['admin', 'eventSource.manage', true],
	['editor', 'eventSource.manage', true],
	// Members: owner + admin only.
	['owner', 'member.invite', true],
	['admin', 'member.invite', true],
	['editor', 'member.invite', false],
	['owner', 'invite.revoke', true],
	['admin', 'invite.revoke', true],
	['editor', 'invite.revoke', false],
	['owner', 'member.remove', true],
	['admin', 'member.remove', true],
	['editor', 'member.remove', false],
	// Project: rename = owner+admin, delete = owner only.
	['owner', 'project.rename', true],
	['admin', 'project.rename', true],
	['editor', 'project.rename', false],
	['owner', 'project.delete', true],
	['admin', 'project.delete', false],
	['editor', 'project.delete', false],
	// Future task-8 mutations: matrix is already encoded.
	['owner', 'member.changeRole', true],
	['admin', 'member.changeRole', true],
	['editor', 'member.changeRole', false],
	['owner', 'project.transferOwnership', true],
	['admin', 'project.transferOwnership', false],
	['editor', 'project.transferOwnership', false],
	// Invite-role gating: owner and admin can invite either role; editors
	// can do neither (gated by member.invite anyway).
	['owner', 'invite.role.admin', true],
	['admin', 'invite.role.admin', true],
	['editor', 'invite.role.admin', false],
	['owner', 'invite.role.editor', true],
	['admin', 'invite.role.editor', true],
	['editor', 'invite.role.editor', false]
];

describe('can(role, action)', () => {
	for (const [role, action, expected] of CELLS) {
		it(`${role} ${expected ? 'can' : 'cannot'} ${action}`, () => {
			expect(can(role, action)).toBe(expected);
		});
	}
});
