import { createHighlighterCore, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

let highlighterPromise: Promise<HighlighterCore> | null = null;

async function getHighlighter(): Promise<HighlighterCore> {
	if (!highlighterPromise) {
		highlighterPromise = createHighlighterCore({
			themes: [import('shiki/themes/github-dark.mjs')],
			langs: [import('shiki/langs/typescript.mjs')],
			engine: createJavaScriptRegexEngine()
		});
	}
	return highlighterPromise;
}

export async function highlightTs(code: string): Promise<string> {
	const highlighter = await getHighlighter();
	return highlighter.codeToHtml(code, {
		lang: 'typescript',
		theme: 'github-dark'
	});
}
