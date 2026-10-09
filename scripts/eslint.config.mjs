import parser from '@typescript-eslint/parser';

export default [
	{ ignores: ['**/node_modules/**', '.svelte-kit/**', '.agents/**', '.stryker-tmp/**', 'build/**', '.netlify/**', 'reports/**', '.tools/**', '.codacy/**'] },
	{
		files: ['src/**/*.{js,ts}', 'scripts/**/*.{js,mjs,ts}', 'e2e/**/*.{ts,mjs}', '*.{js,mjs,ts}'],
		languageOptions: { parser, parserOptions: { ecmaVersion: 'latest', sourceType: 'module' } },
		rules: {
			'constructor-super': 'error',
			'no-debugger': 'error',
			'no-dupe-args': 'error',
			'no-dupe-else-if': 'error',
			'no-duplicate-case': 'error',
			'no-unreachable': 'error',
			'no-unsafe-finally': 'error',
			'valid-typeof': 'error'
		}
	}
];
