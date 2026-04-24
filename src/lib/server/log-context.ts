// AsyncLocalStorage-backed log context. Entry points wrap their handler in
// `withLogContext({ request_id, ... }, fn)` once; every log call inside the
// callback — including anything awaited through — inherits those fields
// without plumbing the logger explicitly.
//
// Requires `nodejs_compat` on the Worker (wrangler.toml), which is already on
// for D1/other uses. AsyncLocalStorage is the officially supported
// Cloudflare-approved way to propagate request-scoped state.

import { AsyncLocalStorage } from 'node:async_hooks';

export type LogContext = Record<string, unknown>;

const storage = new AsyncLocalStorage<LogContext>();

export function getLogContext(): LogContext {
	return storage.getStore() ?? {};
}

export function withLogContext<T>(fields: LogContext, fn: () => Promise<T>): Promise<T>;
export function withLogContext<T>(fields: LogContext, fn: () => T): T;
export function withLogContext<T>(fields: LogContext, fn: () => T | Promise<T>): T | Promise<T> {
	const parent = storage.getStore() ?? {};
	const merged: LogContext = { ...parent, ...fields };
	return storage.run(merged, fn);
}
