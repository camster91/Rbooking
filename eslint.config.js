import js from '@eslint/js';

const workerGlobals = Object.fromEntries([
    'Request', 'Response', 'Headers', 'URL', 'URLSearchParams', 'FormData', 'crypto', 'console',
    'TextEncoder', 'TextDecoder', 'btoa', 'atob', 'ReadableStream', 'WritableStream', 'FixedLengthStream',
    'setTimeout', 'clearTimeout', 'Intl'
].map(name => [name, 'readonly']));

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            globals: workerGlobals
        },
        rules: {
            'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            'no-console': 'off',
            'semi': ['error', 'always'],
            'quotes': ['error', 'single', { avoidEscape: true }],
            'indent': ['error', 4],
            'no-trailing-spaces': 'error',
            'eol-last': ['error', 'always'],
        },
    },
    {
        files: ['vitest.config.js'],
        languageOptions: { globals: { process: 'readonly' } },
    },
    {
        ignores: ['node_modules/**', 'coverage/**', '.wrangler/**', 'public/**', 'eslint.config.js'],
    },
];
