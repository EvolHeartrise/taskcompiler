export type TriggerType = 'webhook' | 'cron';
export type EventTriggerType = 'webhook' | 'cron' | 'manual' | 'replay';
export type RunStatus = 'running' | 'ok' | 'failed' | 'superseded';
export type HealStatus =
	| 'running'
	| 'success'
	| 'failed'
	| 'abandoned'
	| 'needs_attention'
	| 'resolved';
export type VersionCreatedBy = 'user' | 'heal';

export type RunErrorCategory = 'user_code' | 'infra' | 'unknown';

export type UnhealableCategory =
	| 'third_party_outage'
	| 'credential'
	| 'input_malformed'
	| 'capability_gap'
	| 'other';

export interface Project {
	id: string;
	userId: string;
	name: string;
	createdAt: number;
	updatedAt: number;
}

export interface EventSource {
	id: string;
	projectId: string;
	name: string;
	triggerType: TriggerType;
	cronExpr: string | null;
	createdAt: number;
	updatedAt: number;
	lastFiredAt: number;
}

export type WorkflowStatus = 'active' | 'paused';

export interface Workflow {
	id: string;
	projectId: string;
	eventSourceId: string;
	name: string;
	prompt: string;
	currentVersionId: string | null;
	status: WorkflowStatus;
	pausedAt: number | null;
	pausedBy: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface WorkflowVersion {
	id: string;
	workflowId: string;
	version: number;
	sourceTs: string;
	deployPath: string;
	createdAt: number;
	createdBy: VersionCreatedBy;
	parentVersionId: string | null;
	healedFromRunId: string | null;
}

export interface Event {
	id: string;
	eventSourceId: string;
	triggerType: EventTriggerType;
	payload: unknown;
	headers: Record<string, string>;
	receivedAt: number;
	dedupKey: string | null;
}

export interface RunError {
	name: string;
	message: string;
	stack?: string;
	category?: RunErrorCategory;
}

export interface RunLogEntry {
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	ts: number;
	data?: unknown;
}

export interface Run {
	id: string;
	eventId: string;
	workflowId: string;
	versionId: string;
	startedAt: number;
	finishedAt: number | null;
	status: RunStatus;
	error: RunError | null;
	result: unknown;
	logs: RunLogEntry[] | null;
	isReplay: boolean;
	parentRunId: string | null;
}

export interface HealTestResultDetail {
	eventId: string;
	ok: boolean;
	error?: RunError;
}

export interface HealTestResults {
	total: number;
	passed: number;
	failed: number;
	details: HealTestResultDetail[];
}

export interface HealAgentTranscriptEntry {
	ts: number;
	role: 'system' | 'agent' | 'tool' | 'observation';
	message: string;
	data?: unknown;
}

export interface HealSession {
	id: string;
	workflowId: string;
	triggeringRunId: string;
	startedAt: number;
	finishedAt: number | null;
	status: HealStatus;
	diff: string | null;
	testResults: HealTestResults | null;
	newVersionId: string | null;
	agentTranscript: HealAgentTranscriptEntry[] | null;
	unhealableCategory: UnhealableCategory | null;
	unhealableReason: string | null;
	resolvedAt: number | null;
}

export interface ProjectSecretMeta {
	projectId: string;
	name: string;
	createdAt: number;
	updatedAt: number;
}

export type InviteStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

// Project roles. `owner` is unique per project (transferable, not deletable).
// `admin` and `editor` are the granted-permission tiers — see
// `src/lib/server/auth/permissions.ts` for the action matrix. Invites only
// carry `admin`/`editor`; ownership is exclusively transferred, never invited.
export type ProjectRole = 'owner' | 'admin' | 'editor';
export type InviteRole = Exclude<ProjectRole, 'owner'>;

export interface Invite {
	id: string;
	projectId: string;
	email: string;
	token: string;
	invitedBy: string;
	status: InviteStatus;
	role: InviteRole;
	expiresAt: number;
	createdAt: number;
}

export interface ProjectMember {
	userId: string;
	name: string;
	email: string;
	role: ProjectRole;
	joinedAt: number;
}
