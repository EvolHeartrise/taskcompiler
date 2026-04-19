import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<{ env: Env }>();

export function withEnv<T>(env: Env, fn: () => Promise<T>): Promise<T> {
	return store.run({ env }, fn);
}

export function getEnv(): Env {
	const s = store.getStore();
	if (!s) throw new Error('getEnv() called outside request context');
	return s.env;
}
