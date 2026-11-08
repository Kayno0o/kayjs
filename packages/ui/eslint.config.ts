import { defineConfig } from '@kaynooo/eslint'
import { kayRules } from '../../eslint.base'
import { ratchetRules } from '../../eslint.ratchet'

// Lints as kay does, the fixture app left out of the type-aware rules as it is out of the tsconfig.
export default defineConfig({ strict: true, kay: true, filesTypeAware: ['src/**/*.ts', 'tests/*.ts', 'tests-dom/*.ts'] }, kayRules, ...ratchetRules(import.meta.dirname))
