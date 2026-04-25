#!/usr/bin/env bun
// Run with `--help` for usage; posts sample webhook payloads to a TaskCompiler
// webhook URL to exercise the ingest → execute pipeline end-to-end.

interface SyntheticShape {
	name: string;
	headers: Record<string, string>;
	body: unknown;
}

const SHAPES: SyntheticShape[] = [
	{
		body: {
			after: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
			before: '0000000000000000000000000000000000000000',
			commits: [
				{
					id: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
					message: 'Initial commit',
					timestamp: '2026-04-23T10:00:00Z'
				}
			],
			pusher: { email: 'octocat@github.com', name: 'octocat' },
			ref: 'refs/heads/main',
			repository: { full_name: 'octocat/hello-world', id: 1, name: 'hello-world' }
		},
		headers: {
			'content-type': 'application/json',
			'x-github-delivery': 'd1f2c3a4-b5e6-7890-abcd-ef0123456789',
			'x-github-event': 'push',
			'x-github-hook-id': '12345'
		},
		name: 'push'
	},
	{
		body: {
			action: 'opened',
			number: 42,
			pull_request: {
				body: 'This is a test PR',
				draft: false,
				head: { ref: 'feature/branch', sha: 'aaa111' },
				id: 1001,
				merged_at: null,
				number: 42,
				state: 'open',
				title: 'Add new feature',
				user: { id: 1, login: 'octocat' }
			},
			repository: { full_name: 'octocat/hello-world', id: 1 },
			sender: { id: 1, login: 'octocat' }
		},
		headers: {
			'content-type': 'application/json',
			'x-github-delivery': 'd2f3c4a5-b6e7-8901-bcde-f01234567890',
			'x-github-event': 'pull_request',
			'x-github-hook-id': '12345'
		},
		name: 'pull_request_opened'
	},
	{
		body: {
			action: 'closed',
			number: 42,
			pull_request: {
				body: 'This is a test PR',
				draft: false,
				head: { ref: 'feature/branch', sha: 'aaa111' },
				id: 1001,
				merged_at: '2026-04-23T11:00:00Z',
				number: 42,
				state: 'closed',
				title: 'Add new feature',
				user: { id: 1, login: 'octocat' }
			},
			repository: { full_name: 'octocat/hello-world', id: 1 },
			sender: { id: 1, login: 'octocat' }
		},
		headers: {
			'content-type': 'application/json',
			'x-github-delivery': 'd3f4c5a6-b7e8-9012-cdef-012345678901',
			'x-github-event': 'pull_request',
			'x-github-hook-id': '12345'
		},
		name: 'pull_request_closed'
	},
	{
		body: {
			action: 'opened',
			issue: {
				body: 'Found a bug',
				id: 2001,
				labels: [{ name: 'bug' }],
				number: 7,
				state: 'open',
				title: 'Bug report',
				user: { id: 1, login: 'octocat' }
			},
			repository: { full_name: 'octocat/hello-world', id: 1 },
			sender: { id: 1, login: 'octocat' }
		},
		headers: {
			'content-type': 'application/json',
			'x-github-delivery': 'd4f5c6a7-b8e9-0123-def0-123456789012',
			'x-github-event': 'issues',
			'x-github-hook-id': '12345'
		},
		name: 'issues_opened'
	},
	{
		body: {
			action: 'created',
			comment: {
				body: 'Great work!',
				id: 3001,
				user: { id: 1, login: 'octocat' }
			},
			issue: { id: 2001, number: 7 },
			repository: { full_name: 'octocat/hello-world', id: 1 }
		},
		headers: {
			authorization: 'Bearer should-be-redacted',
			'content-type': 'application/json',
			'x-github-delivery': 'd5f6c7a8-b9ea-1234-ef01-234567890123',
			'x-github-event': 'issue_comment',
			'x-github-hook-id': '12345',
			'x-hub-signature-256': 'sha256=should-be-redacted'
		},
		name: 'issue_comment_with_secrets'
	}
];

interface SendResult {
	shape: string;
	httpStatus: number;
	body: unknown;
}

async function send(url: string, shape: SyntheticShape): Promise<SendResult> {
	const res = await fetch(url, {
		body: JSON.stringify(shape.body),
		headers: shape.headers,
		method: 'POST'
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* non-JSON, keep raw text */
	}
	return { body, httpStatus: res.status, shape: shape.name };
}

function fmtResult(r: SendResult): string {
	return `[${r.shape}] http=${r.httpStatus} body=${JSON.stringify(r.body)}`;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
		console.log(
			[
				'Usage: bun run scripts/synthetic-webhook.ts <webhook-url> [options]',
				'',
				'Options:',
				'  --all                 Send every shape in sequence',
				'  --shape <name>        Send one specific shape by name',
				'  --delay <ms>          Delay between sends in --all mode (default 1500)',
				'  --list                List available shape names',
				'',
				`Available shapes: ${SHAPES.map((s) => s.name).join(', ')}`
			].join('\n')
		);
		return;
	}

	if (args[0] === '--list') {
		for (const s of SHAPES) {
			console.log(s.name);
		}
		return;
	}

	const url = args[0];
	if (!url || !url.startsWith('http')) {
		console.error('First argument must be the full webhook URL (https://...)');
		process.exit(1);
	}

	const all = args.includes('--all');
	const shapeIdx = args.indexOf('--shape');
	const shapeName = shapeIdx !== -1 ? args[shapeIdx + 1] : undefined;
	const delayIdx = args.indexOf('--delay');
	const delay = delayIdx !== -1 ? Number(args[delayIdx + 1] ?? 1500) : 1500;

	let toSend: SyntheticShape[];
	if (all) {
		toSend = SHAPES;
	} else if (shapeName) {
		const found = SHAPES.find((s) => s.name === shapeName);
		if (!found) {
			console.error(`Unknown shape: ${shapeName}. Use --list to see options.`);
			process.exit(1);
		}
		toSend = [found];
	} else {
		toSend = [SHAPES[0]!];
	}

	console.log(`POST ${url}`);
	console.log(`Sending ${toSend.length} shape(s): ${toSend.map((s) => s.name).join(', ')}`);
	console.log('');

	for (let i = 0; i < toSend.length; i++) {
		const shape = toSend[i]!;
		try {
			const result = await send(url, shape);
			console.log(fmtResult(result));
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[${shape.name}] FAILED: ${msg}`);
		}
		if (i < toSend.length - 1) {
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

void main();
