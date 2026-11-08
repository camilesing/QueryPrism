import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.ts'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Batch 7: jest globals only where tests live — the old blanket block
  // injected describe/it/expect into PRODUCTION lint scope.
  {
    files: ['src/**/*.spec.ts', 'test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // The `_` prefix marks intentionally-unused params/vars/caught-errors
      // (stub handlers, ignored DTOs). Standard convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      "prettier/prettier": ["error", { endOfLine: "lf" }],
    },
  },
  // Jest assertions reference methods as values (`expect(obj.spy)
  // .toHaveBeenCalledWith`); the type-checked `unbound-method` rule mis-flags
  // those. `jest.fn()` mocks are inherently typed `any`, so accessing
  // `.mock.calls[0][0].data` triggers `no-unsafe-member-access`/`-assignment`
  // even with a cast — these are unavoidable in mock-introspection specs
  // (esp. for non-deterministic values like AES ciphertext, where
  // `toHaveBeenCalledWith` can't assert the exact arg). Standard Jest+TS override.
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);
