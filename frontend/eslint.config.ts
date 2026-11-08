import { globalIgnores } from 'eslint/config'
import eslint from '@eslint/js'
import eslintConfigPrettier from 'eslint-config-prettier'
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended'
import eslintPluginVue from 'eslint-plugin-vue'
import globals from 'globals'
import typescriptEslint from 'typescript-eslint'
import eslintrcImport from './.eslintrc-auto-import.json'

export default typescriptEslint.config(
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node, ...eslintrcImport.globals },
      ecmaVersion: 'latest',
      parserOptions: {
        parser: typescriptEslint.parser,
      },
    },

    extends: [
      eslint.configs.recommended,
      ...typescriptEslint.configs.recommended,
      ...eslintPluginVue.configs['flat/recommended'],
    ],
    rules: {
      'no-console': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'no-debugger': process.env.NODE_ENV === 'production' ? 'warn' : 'off',
      'vue/multi-word-component-names': 'off',
      'vue/no-required-prop-with-default': 'off',
      'vue/no-v-html': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'warn',

      'prettier/prettier': [
        'warn',
        {
          singleQuote: true,
          semi: false,
          trailingComma: 'es5',
          printWidth: 100,
          tabWidth: 2,
          endOfLine: 'auto',
        },
      ],
    },
  },
  globalIgnores([
    'node_modules/',
    'dist/',
    'public/',
    'eslint.config.ts',
    '**/*.md',
    '**/*.woff',
    '**/*.ttf',
    '**/.vscode/',
    '**/.DS_Store',
  ]),
  eslintConfigPrettier,
  eslintPluginPrettierRecommended,
)
