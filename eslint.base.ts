import type { TypedFlatConfigItem } from '@kaynooo/eslint'
import { testRules } from './src/eslint'

// What kay and each of its libraries lint with over @kaynooo/eslint's strict preset, so a library lints as strictly as kay.
export const kayRules: TypedFlatConfigItem[] = [...testRules, {
  files: ['**/tests/**/*.ts', '**/tests-dom/**/*.ts'],
  rules: {
    // Tests embed .kay sources, whose expressions hold JS template literals inside plain strings.
    'no-template-curly-in-string': 'off',
    // Tests run the inline scripts kay writes into a page.
    'ts/no-implied-eval': 'off',
    // bun-types types the asymmetric matchers, `expect.stringContaining()` and the like, as any.
    'ts/no-unsafe-argument': 'off',
  },
}, {
  // A component declares its handlers and hooks in any order: a function body runs after the whole component, and TypeScript itself rejects a read of a const before its declaration.
  files: ['**/*.kay/*.tsx'],
  rules: {
    'ts/no-use-before-define': 'off',
  },
}]
