import { FlatCompat } from '@eslint/eslintrc'
import eslintPluginImport from 'eslint-plugin-import'
import tseslint from '@typescript-eslint/eslint-plugin'

const compat = new FlatCompat({
  // import.meta.dirname is available after Node.js v20.11.0
  baseDirectory: import.meta.dirname,
})

const importPlugin = eslintPluginImport.default ?? eslintPluginImport
const typescriptPlugin = tseslint.default ?? tseslint

const eslintConfig = [
  ...compat.config({
    extends: ['next'],
  }),
  {
    plugins: {
      import: importPlugin,
      '@typescript-eslint': typescriptPlugin,
    },
    rules: {
      'react/no-unescaped-entities': 'off',
      '@next/next/no-img-element': 'off',
      // '@typescript-eslint/no-unused-vars': 'off',
      // '@typescript-eslint/no-explicit-any': 'off',
      'react-hooks/exhaustive-deps': 'off',
      'import/no-unresolved': 'error',
      'import/named': 'error',
      'import/default': 'error',
      'import/namespace': 'error',
      'import/no-absolute-path': 'error',
      'import/no-dynamic-require': 'error',
      'import/no-self-import': 'error',
      'import/no-cycle': 'error',
      'import/no-useless-path-segments': 'error',
    },
  },
]

export default eslintConfig
