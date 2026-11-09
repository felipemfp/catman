// Flat config. Enforces the dependency rules (SPEC.md § Capability Map) and core's determinism bans.
import tseslint from 'typescript-eslint';

const bannedMath = ['random', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p', 'pow', 'sqrt', 'cbrt', 'hypot', 'fround'];
const why = 'SPEC-game-core § Determinism contract';

const noPhaser = { name: 'phaser', message: 'phaser is client-only (SPEC.md Boundaries).' };

export default tseslint.config(
  { ignores: ['dist/', 'dist-e2e/', '.wrangler/', 'worker-configuration.d.ts', 'playwright-report/', 'test-results/', 'node_modules/'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': ['error', { selector: 'TSEnumDeclaration', message: 'No enum: use string-literal unions.' }],
    },
  },
  // ---- game-core ----
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', ...bannedMath.map((property) => ({ object: 'Math', property, message: `Banned in core: ${why}.` }))],
      'no-restricted-globals': ['error', ...['Date', 'performance', 'crypto', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'queueMicrotask', 'requestAnimationFrame', 'process', 'window', 'document', 'globalThis'].map((name) => ({ name, message: `Hidden input, banned in core: ${why}.` }))],
      'no-restricted-syntax': [
        'error',
        { selector: "BinaryExpression[operator='**']", message: `** is banned in core: ${why}.` },
        { selector: "AssignmentExpression[operator='**=']", message: `**= is banned in core: ${why}.` },
        { selector: 'TSEnumDeclaration', message: 'No enum: use string-literal unions.' },
      ],
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [{ regex: '^(\\.\\./|node:|[a-z@])', message: 'src/core imports only src/core (dependency rule 1).' }] }],
    },
  },
  {
    files: ['src/core/**/*.ts'],
    ignores: ['src/core/**/*.test.ts', 'src/core/**/*.test-helpers.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [
        { regex: '^(\\.\\./|node:|[a-z@])', message: 'src/core imports only src/core (dependency rule 1).' },
        { regex: '^\\./testing\\.ts$', message: 'testing.ts is for *.test.ts and tools/** only (dependency rule 5).' },
      ] }],
    },
  },
  {
    files: ['src/core/**/*.test.ts', 'src/core/**/*.test-helpers.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [{ regex: '^(\\.\\./|node:)', message: 'core tests import only src/core and vitest.' }] }],
    },
  },
  // ---- balance-sim and client ----
  {
    files: ['src/sim/**/*.ts'],
    ignores: ['src/sim/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [
        { regex: '^\\.\\./core/(?!index\\.ts$)', message: 'src/sim imports core only via src/core/index.ts (rule 2).' },
        { regex: '^\\.\\./(client|sim)/|^\\.\\./\\.\\./', message: 'Module boundary (rule 4).' },
      ] }],
    },
  },
  {
    files: ['src/sim/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [
        { regex: '^\\.\\./core/(?!(index|testing)\\.ts$|fixtures/)', message: 'sim tests import core via index.ts, testing.ts or fixtures (rules 2, 5).' },
        { regex: '^\\.\\./client/|^\\.\\./\\.\\./', message: 'Module boundary (rule 4).' },
      ] }],
    },
  },
  {
    files: ['src/client/**/*.ts'],
    ignores: ['src/client/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { regex: '^\\.\\./core/(?!index\\.ts$)', message: 'src/client imports core only via src/core/index.ts (rule 2).' },
        { regex: '^\\.\\./sim/|^\\.\\./\\.\\./', message: 'Module boundary (rule 4).' },
      ] }],
    },
  },
  {
    files: ['src/client/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [
        { regex: '^\\.\\./core/(?!(index|testing)\\.ts$|fixtures/)', message: 'client tests import core via index.ts, testing.ts or fixtures (rules 2, 5).' },
        { regex: '^\\.\\./sim/|^\\.\\./\\.\\./', message: 'Module boundary (rule 4).' },
      ] }],
    },
  },
  // ---- ghost-api ----
  {
    files: ['worker/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [
        { regex: '^\\.\\./src/(?!core/ghost\\.ts$)', message: 'worker imports only src/core/ghost.ts (rule 3).' },
        { regex: '^\\.\\./(tools|e2e)/', message: 'Module boundary (rule 4).' },
      ] }],
    },
  },
  // ---- tools ----
  {
    files: ['tools/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [
        { regex: '^\\.\\./src/(?!core/(index|testing)\\.ts$)', message: 'tools import core only via index.ts and testing.ts (rule 6).' },
      ] }],
    },
  },
  // ---- e2e ----
  {
    files: ['e2e/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [
        { regex: '^\\.\\./src/(?!core/fixtures/[a-z]+\\.json$|client/dev-hooks\\.ts$)', message: 'e2e imports only core fixture JSON (rule 5) and, type-only, dev-hooks (rule 4).' },
      ] }],
    },
  },
  {
    files: ['e2e/**/*.ts'],
    ignores: ['e2e/global.d.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [noPhaser], patterns: [
        { regex: '^\\.\\./src/(?!core/fixtures/[a-z]+\\.json$)', message: 'e2e imports only core fixture JSON (rule 5).' },
      ] }],
    },
  },
);
