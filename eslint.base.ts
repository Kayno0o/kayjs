import type { TypedFlatConfigItem } from '@kaynooo/eslint'

// What kay and each of its libraries lint with over @kaynooo/eslint's strict preset, so a library lints as strictly as kay.
export const kayRules: TypedFlatConfigItem[] = [{
  files: ['**/tests/**/*.ts', '**/tests-dom/**/*.ts'],
  rules: {
    // Tests embed .kay sources, whose expressions hold JS template literals inside plain strings.
    'no-template-curly-in-string': 'off',
    // bun-types types the matchers of `expect(promise).rejects` as returning void, though they must be awaited.
    'ts/await-thenable': 'off',
    // Tests run the inline scripts kay writes into a page.
    'ts/no-implied-eval': 'off',
    // bun-types types the asymmetric matchers, `expect.stringContaining()` and the like, as any.
    'ts/no-unsafe-argument': 'off',
  },
}, {
  // A component declares its handlers and hooks in any order: a function body runs after the whole component, and TypeScript itself rejects a read of a const before its declaration.
  files: ['**/*.kay/*.tsx'],
  rules: {
    // Pending @kaynooo/eslint 7.0.4, whose kay preset turns off the rules below. A handler stays on the one line of its attribute list, and with `style/indent` off the autofix of a split cannot lay it out; a slot's params and a loop's callbacks are generated in parentheses the template never wrote; a prop with a default is read as a ternary the template never wrote, which nests the ternaries around it.
    'antfu/if-newline': 'off',
    'kaynooo/max-statements-per-line': 'off',
    'no-nested-ternary': 'off',
    'style/arrow-parens': 'off',
    'ts/no-use-before-define': 'off',
  },
}]
