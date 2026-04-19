export type TriggerType = "webhook" | "cron" | "both";
export type EventTriggerType = "webhook" | "cron" | "manual" | "replay";
export type RunStatus = "running" | "ok" | "failed" | "superseded";
export type HealStatus = "running" | "success" | "failed" | "abandoned";
export type VersionCreatedBy = "user" | "heal";

export interface Workflow {
	id: string;
	name: string;
	prompt: string;
	currentVersionId: string | null;
	triggerType: TriggerType;
	cronExpr: string | null;
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
	workflowId: string;
	triggerType: EventTriggerType;
	payload: unknown;
	receivedAt: number;
	dedupKey: string | null;
}

export interface RunError {
	name: string;
	message: string;
	stack?: string;
}

export interface RunLogEntry {
	level: "debug" | "info" | "warn" | "error";
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
	role: "system" | "agent" | "tool" | "observation";
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
}

export interface WorkflowStateEntry {
	workflowId: string;
	key: string;
	value: unknown;
	updatedAt: number;
}
