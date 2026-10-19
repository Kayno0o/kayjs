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
  expect(insertImport('export {}\n', 'import { z } from \'z\'')).toBe('import { z } from \'z\'\n\nexport {}\n')
})

it('goes below a shebang and directives, keeps CRLF and reads trailing comments and attributes', () => {
  expect(insertImport('#!/usr/bin/env bun\nexport {}\n', 'import { z } from \'z\'')).toBe('#!/usr/bin/env bun\nimport { z } from \'z\'\n\nexport {}\n')
  expect(insertImport('\'use strict\'\nexport {}\n', 'import { z } from \'z\'')).toBe('\'use strict\'\nimport { z } from \'z\'\n\nexport {}\n')
  expect(insertImport('import { a } from \'a\'\r\n\r\nexport {}\r\n', 'import { b } from \'b\'')).toBe('import { a } from \'a\'\r\nimport { b } from \'b\'\r\n\r\nexport {}\r\n')
  expect(insertImport('import a from \'a\' // note\nimport j from \'./j.json\' with { type: \'json\' }\n', 'import { b } from \'b\'')).toBe('import a from \'a\' // note\nimport { b } from \'b\'\nimport j from \'./j.json\' with { type: \'json\' }\n')
  expect(insertImport('import { join } from \'node:path\'\nconst meta = import.meta.dir\n', 'import { ws } from \'ws\'')).toBe('import { join } from \'node:path\'\nimport { ws } from \'ws\'\nconst meta = import.meta.dir\n')
})

it('goes below a byte order mark before a shebang or a directive', () => {
  expect(insertImport('\uFEFF#!/usr/bin/env bun\nexport {}\n', 'import { z } from \'z\'')).toBe('\uFEFF#!/usr/bin/env bun\nimport { z } from \'z\'\n\nexport {}\n')
  expect(insertImport('\uFEFF\'use strict\'\nexport {}\n', 'import { z } from \'z\'')).toBe('\uFEFF\'use strict\'\nimport { z } from \'z\'\n\nexport {}\n')
  expect(insertImport('\uFEFFexport {}\n', 'import { z } from \'z\'')).toBe('\uFEFFimport { z } from \'z\'\n\nexport {}\n')
})

it('goes below a comment header, and above a comment that belongs to the code under it', () => {
  const z = 'import { z } from \'z\''

  expect(insertImport('// Copyright 2026\n// Licensed under MIT\n\nexport {}\n', z)).toBe(`// Copyright 2026\n// Licensed under MIT\n\n${z}\n\nexport {}\n`)
  expect(insertImport('/**\n * Copyright 2026\n */\n\nexport {}\n', z)).toBe(`/**\n * Copyright 2026\n */\n\n${z}\n\nexport {}\n`)
  expect(insertImport('#!/usr/bin/env bun\n// Copyright\n\n\'use strict\'\nexport {}\n', z)).toBe(`#!/usr/bin/env bun\n// Copyright\n\n'use strict'\n${z}\n\nexport {}\n`)
  expect(insertImport('// Copyright\n\n// Adds one.\nexport function add() {}\n', z)).toBe(`// Copyright\n\n${z}\n\n// Adds one.\nexport function add() {}\n`)
  expect(insertImport('// Adds one.\nexport function add() {}\n', z)).toBe(`${z}\n\n// Adds one.\nexport function add() {}\n`)
  expect(insertImport('// @ts-nocheck\nexport {}\n', z)).toBe(`// @ts-nocheck\n${z}\n\nexport {}\n`)
  expect(insertImport('/* eslint-disable */\r\nexport {}\r\n', z)).toBe(`/* eslint-disable */\r\n${z}\r\n\r\nexport {}\r\n`)
  expect(insertImport('// Only a note\n', z)).toBe(`// Only a note\n${z}\n`)
})

it('reads a block comment sharing its line with code as code, a triple-slash directive as a tool comment, and groups after a byte order mark', () => {
  const z = 'import { z } from \'z\''

  expect(insertImport('/* a */ export const x = 1\n\nconst y = 2\n/* b */\n\nfoo()\n', z)).toBe(`${z}\n\n/* a */ export const x = 1\n\nconst y = 2\n/* b */\n\nfoo()\n`)
  expect(insertImport('/// <reference types="bun" />\nexport {}\n', z)).toBe(`/// <reference types="bun" />\n${z}\n\nexport {}\n`)
  expect(insertImport('\uFEFFimport { a } from \'a\'\nexport {}\n', 'import { b } from \'b\'')).toBe('\uFEFFimport { a } from \'a\'\nimport { b } from \'b\'\nexport {}\n')
})
