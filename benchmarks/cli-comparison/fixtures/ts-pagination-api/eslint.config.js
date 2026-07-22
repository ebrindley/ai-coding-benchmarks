// ESLint 9 flat config. The pinned eslint@9.x no longer reads .eslintrc.* files,
// so this fixture uses the flat-config format directly. Rule intent mirrors the
// previous eslintrc: eslint:recommended + @typescript-eslint/recommended + eqeqeq.
const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      eqeqeq: ['error', 'always'],
    },
  },
];
