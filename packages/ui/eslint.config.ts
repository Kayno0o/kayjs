import { defineConfig } from '@kaynooo/eslint'
import { kayRules } from '../../eslint.base'

// Lints as kay does, the fixture app left out of the type-aware rules as it is out of the tsconfig.
export default defineConfig({ strict: true, filesTypeAware: ['src/**/*.ts', 'tests/*.ts', 'tests-dom/*.ts'] }, kayRules, {
  // The popover shim moves to kay/test with the happy-dom preload (#616), where kay's own lint covers it.
  files: ['tests-dom/dom.ts'],
  rules: { 'ts/unbound-method': 'off' },
})
