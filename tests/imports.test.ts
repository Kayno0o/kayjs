import { expect, it } from 'bun:test'
import { insertImport } from '../src/imports'

const cms = 'import { cms } from \'@kaynooo/kayjs-cms\''

it('places an import where the preset sorts it, among externals and after builtins', () => {
  const config = 'import { defineConfig } from \'kay/server\'\nimport tailwind from \'bun-plugin-tailwind\'\n\nexport default defineConfig({})\n'

  expect(insertImport(config, cms)).toBe(`${cms}\nimport { defineConfig } from 'kay/server'\nimport tailwind from 'bun-plugin-tailwind'\n\nexport default defineConfig({})\n`)
  expect(insertImport('import { join } from \'node:path\'\nimport { a } from \'a\'\nimport { z } from \'z\'\n', 'import { m } from \'m\'')).toBe('import { join } from \'node:path\'\nimport { a } from \'a\'\nimport { m } from \'m\'\nimport { z } from \'z\'\n')
  expect(insertImport('import { join } from \'node:path\'\n\nexport const x = 1\n', cms)).toBe(`import { join } from 'node:path'\n${cms}\n\nexport const x = 1\n`)
})

it('sorts case-insensitively and by number, relative imports last, types first', () => {
  const source = 'import type { T } from \'t\'\nimport { B } from \'Beta\'\nimport { v10 } from \'v10\'\nimport { r } from \'./r\'\nimport \'./side\'\n'

  expect(insertImport(source, 'import { a } from \'alpha\'')).toContain('\'t\'\nimport { a } from \'alpha\'\nimport { B }')
  expect(insertImport(source, 'import { c } from \'gamma\'')).toContain('\'Beta\'\nimport { c } from \'gamma\'\nimport { v10 }')
  expect(insertImport(source, 'import { v } from \'v9\'')).toContain('import { v } from \'v9\'\nimport { v10 }')
  expect(insertImport(source, 'import { e } from \'./env\'')).toContain('import { e } from \'./env\'\nimport { r }')
  expect(insertImport(source, 'import type { U } from \'u\'')).toContain('\'t\'\nimport type { U } from \'u\'\nimport { B }')
})

it('handles a multi-line import and a file with no import', () => {
  expect(insertImport('import {\n  a,\n  b,\n} from \'a\'\nexport {}\n', 'import { z } from \'z\'')).toBe('import {\n  a,\n  b,\n} from \'a\'\nimport { z } from \'z\'\nexport {}\n')
  expect(insertImport('export {}\n', 'import { z } from \'z\'')).toBe('import { z } from \'z\'\nexport {}\n')
})
