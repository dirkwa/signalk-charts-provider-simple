const tseslint = require('typescript-eslint');
const prettier = require('eslint-plugin-prettier');
const eslintJs = require('@eslint/js');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      // Ignore compiled frontend JS but keep .ts sources lintable.
      // ** glob covers nested folders that may appear later under
      // public/js/ (e.g. utils/) without revisiting this config.
      'public/js/**/*.js',
      'dist/**',
      'dist-test/**',
      'dist-e2e/**',
      'playwright-report/**',
      'test-results/**'
    ]
  },

  // Base recommended rules for all files
  eslintJs.configs.recommended,

  // TypeScript strict type-checked rules scoped to src/ AND test/ TS files.
  // Tests get the same scrutiny as production code — strict null checks,
  // no implicit any, exhaustive switch, etc.
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: [
      'src/**/*.ts',
      'test/**/*.ts',
      'e2e/**/*.ts',
      'public/js/**/*.ts',
      'playwright.config.ts'
    ]
  })),
  {
    files: [
      'src/**/*.ts',
      'test/**/*.ts',
      'e2e/**/*.ts',
      'public/js/**/*.ts',
      'playwright.config.ts'
    ],
    languageOptions: {
      parserOptions: {
        // Point at all four tsconfigs so each subtree is accepted by
        // the project service: src/ (tsconfig.json), test/, e2e/, and
        // public/js/ (tsconfig.public.json).
        project: [
          './tsconfig.json',
          './tsconfig.test.json',
          './tsconfig.e2e.json',
          './tsconfig.public.json'
        ],
        tsconfigRootDir: __dirname
      }
    },
    plugins: {
      prettier
    },
    rules: {
      'prettier/prettier': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
      curly: ['error', 'all'],
      'no-var': 'error',
      'prefer-const': 'error',
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true }
      ],
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } }
      ],
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/no-deprecated': 'warn'
    }
  },

  // Test-specific rule overrides.  Tests get strictTypeChecked so type
  // bugs are caught at compile time, but the most ergonomic-painful rules
  // are relaxed: assertions about results matter, control-flow purity
  // doesn't.  no-floating-promises in particular fires on every
  // intentional fire-and-forget setup call (setMbtilesType, etc.) where
  // we don't care about the return value, only the side effect.
  {
    files: ['test/**/*.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      // Tests intentionally compare for strict equality on numeric
      // boundary values where deepStrictEqual would over-restrict.
      '@typescript-eslint/no-non-null-assertion': 'off'
    }
  },

  // Frontend TS lives under public/js/ and runs as plain `<script>` tags
  // in the browser (no bundler). It uses DOM-driven flows that strict-
  // type-checked rules around floating promises and "unnecessary
  // condition" trip on; the relaxations here mirror the test/e2e block.
  {
    files: ['public/js/**/*.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off'
    }
  },

  // Test fixtures stay as CommonJS scripts — they're one-off setup
  // scripts, not under test. The `.cjs` extension keeps them parseable
  // as CJS now that the package is `"type": "module"`.
  {
    files: ['test/fixtures/**/*.cjs'],
    plugins: {
      prettier
    },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        Promise: 'readonly'
      }
    },
    rules: {
      'prettier/prettier': 'error',
      'no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      'no-console': 'off'
    }
  }
];
