export function writeVersion(
	workflowId: string,
	version: number,
	_sourceTs: string,
): Promise<string> {
	return Promise.resolve(`inline:${workflowId}/v${version}`);
}
