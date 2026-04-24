import { CronExpressionParser } from 'cron-parser';
import { listCronEventSources, markEventSourceFired } from '$lib/server/db/queries/event-sources';
import { executeSourceEvent } from '$lib/server/engine';
import { errorMessage } from '$lib/server/util';

export interface CronTickResult {
	scanned: number;
	fired: {
		eventSourceId: string;
		eventId: string;
		dispatched: number;
	}[];
	skipped: { eventSourceId: string; reason: string }[];
}

// Fires at most once per event source per tick. Missed intervals (e.g.
// during a control-plane outage) are not backfilled here — catch-up needs
// a separate pass.
export async function handleCronTick(now: number = Date.now()): Promise<CronTickResult> {
	const sources = await listCronEventSources();
	const result: CronTickResult = {
		fired: [],
		scanned: sources.length,
		skipped: []
	};

	for (const source of sources) {
		const expr = source.cronExpr;
		if (!expr) {
			result.skipped.push({ eventSourceId: source.id, reason: 'missing cron expression' });
			continue;
		}

		let nextDue: number;
		try {
			const iter = CronExpressionParser.parse(expr, {
				currentDate: source.lastFiredAt > 0 ? new Date(source.lastFiredAt) : new Date(0),
				tz: 'UTC'
			});
			nextDue = iter.next().getTime();
		} catch (error) {
			result.skipped.push({
				eventSourceId: source.id,
				reason: `invalid cron: ${expr} (${errorMessage(error)})`
			});
			continue;
		}

		if (nextDue > now) {
			result.skipped.push({ eventSourceId: source.id, reason: 'not due yet' });
			continue;
		}

		try {
			await markEventSourceFired(source.id, now);
			const exec = await executeSourceEvent({
				eventSourceId: source.id,
				payload: { firedAt: now },
				trigger: 'cron'
			});
			result.fired.push({
				dispatched: exec.dispatched.length,
				eventId: exec.eventId,
				eventSourceId: source.id
			});
		} catch (error) {
			result.skipped.push({
				eventSourceId: source.id,
				reason: `error: ${errorMessage(error)}`
			});
		}
	}

	return result;
}
