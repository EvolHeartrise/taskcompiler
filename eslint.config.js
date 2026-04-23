import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import oxlint from 'eslint-plugin-oxlint';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// Typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// See: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				projectService: true,
				svelteConfig
			}
		}
	},
	// Must be last: disables rules already covered by oxlint, mirroring .oxlintrc.json.
	// Drop the mirrored-ignorePatterns config entry so oxlint's ignore of *.svelte
	// (needed because its prefer-const autofix breaks $state runes) doesn't cause
	// ESLint to skip .svelte files too.
	...oxlint
		.buildFromOxlintConfigFile('./.oxlintrc.json')
		.filter((c) => c.name !== 'oxlint/oxlint-config-ignore-patterns')
);
