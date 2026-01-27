import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
    {
        ignores: ['node_modules/**', 'dist/**', 'generated/**', 'prisma/**/*.prisma'],
    },
    eslint.configs.recommended,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: './tsconfig.json',
                tsconfigRootDir: import.meta.dirname,
                sourceType: 'module',
            },
            globals: {
                console: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
                __dirname: 'readonly',
                __filename: 'readonly',
                module: 'readonly',
                require: 'readonly',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
        },
        rules: {
            // Spacing rules
            'space-in-parens': ['error', 'always'], // if( condition )
            'object-curly-spacing': ['error', 'always'], // { foo: bar }
            'array-bracket-spacing': ['error', 'always'], // [ 1, 2, 3 ]
            semi: ['error', 'always'],
            quotes: ['error', 'single'],
            indent: ['error', 4],
            'comma-dangle': ['error', 'always-multiline'],
            // TypeScript specific rules
            '@typescript-eslint/interface-name-prefix': 'off',
            '@typescript-eslint/explicit-function-return-type': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
            'no-undef': 'off', // TypeScript handles this
            'no-unused-vars': 'off', // Use @typescript-eslint/no-unused-vars instead
        },
    },
];
