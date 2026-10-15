import { defineConfig } from '@kaynooo/eslint'
import { kayRules } from '../../eslint.base'

// Lints as kay does, the fixture app left out of the type-aware rules as it is out of the tsconfig.
export default defineConfig({ strict: true, filesTypeAware: ['src/**/*.ts', 'tests/*.ts', 'tests/{helpers,probes}/*.ts'] }, kayRules)
