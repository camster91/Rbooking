import js from '@eslint/js';

export default [
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'commonjs',
            globals: {
                // Node.js globals
                require: 'readonly',
                module: 'readonly',
                exports: 'readonly',
                process: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                console: 'readonly',
                Buffer: 'readonly',
                // Browser globals
                document: 'readonly',
                window: 'readonly',
                FormData: 'readonly',
                fetch: 'readonly',
                alert: 'readonly',
                location: 'readonly',
                bootstrap: 'readonly',
                flatpickr: 'readonly',
                lucide: 'readonly',
            },
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
        ignores: ['node_modules/**', 'coverage/**', 'uploads/**'],
    },
];