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

export interface Workflow {
	id: string;
	projectId: string;
	eventSourceId: string;
	name: string;
	prompt: string;
	currentVersionId: string | null;
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
