import { defineConfig } from '@kaynooo/eslint'
import { kayRules } from '../../eslint.base'

// Lints as kay does, the fixture app left out of the type-aware rules as it is out of the tsconfig.
export default defineConfig({ strict: true, filesTypeAware: ['src/**/*.ts', 'tests/*.ts', 'tests/{helpers,probes}/*.ts'] }, kayRules, {
  files: ['tests/**/*.ts'],
  // Unlike kay's: the test browser's `call` and `post` answer any, an action's answer as the test expects it, which these tests read unchecked.
  rules: { 'ts/no-unsafe-call': 'off', 'ts/no-unsafe-member-access': 'off', 'ts/no-unsafe-return': 'off' },
})
