import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier/flat';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['**/*.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
    extends: [js.configs.recommended],
    rules: { curly: ['error', 'all'] },
  },
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // MCP stdio reserves stdout for protocol messages.
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  // Prettier owns formatting; disable any conflicting lint rules.
  prettier,
]);
