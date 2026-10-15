import type { LintMessage } from '../src/eslint'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { writeShadowTypes } from '../src/check'
import { readShadowSettings, serializeShadowSettings, SHADOW_SETTINGS } from '../src/check/shadow'
import { positionAt } from '../src/compiler/mapping'
import { processor, shadowParser } from '../src/eslint'
import { projectPaths } from '../src/project'

const FILE = join(import.meta.dir, 'fixtures', 'lint', 'src', 'components', 'card.kay')
const CARD = `---
import { signal } from 'kay'

const { label } = props<{ label: string }>()
let count = signal(0)
---
p {label} {count()}
`

// What ESLint would report at `offset` of the TSX the processor handed it.
function at(tsx: string, offset: number, extra: Partial<LintMessage> = {}): LintMessage {
  return { ruleId: 'probe', message: 'probe', ...positionAt(tsx, offset), ...extra }
}

describe('kay/eslint', () => {
  it('reports what falls in a fence\'s own code at its .kay line, and drops the generated code around it', () => {
    const [block] = processor.preprocess(CARD, FILE)
    const tsx = block!.text
    const declaration = tsx.indexOf('let count')
    // `label` reads as `__props.label`, and a `;` follows the copied statement.
    const generated = tsx.indexOf('__props.')
    const semicolon = tsx.indexOf(';', generated)

    expect(block!.filename).toBe('kay.tsx')

    const messages = processor.postprocess([[
      at(tsx, declaration, { fix: { range: [declaration, declaration + 3], text: 'const' } }),
      at(tsx, generated),
      at(tsx, semicolon),
    ]], FILE)

    expect(messages).toEqual([expect.objectContaining({ line: 5, column: 1, fix: { range: [CARD.indexOf('let count'), CARD.indexOf('let count') + 3], text: 'const' } })])
  })

  it('keeps a parse failure the generated code holds, at the top of the file, so lint does not pass', () => {
    const [block] = processor.preprocess(CARD, FILE)
    const messages = processor.postprocess([[at(block!.text, block!.text.indexOf('__props.'), { ruleId: null, fatal: true, message: 'Parsing error' })]], FILE)

    expect(messages).toEqual([expect.objectContaining({ line: 1, column: 1, fatal: true })])
  })

  it('keeps a parser that threw, which reports no position, at the top of the file', () => {
    processor.preprocess(CARD, FILE)

    expect(processor.postprocess([[{ ruleId: null, fatal: true, message: 'Parsing error: no type information yet', line: 0, column: 0 }]], FILE)).toEqual([expect.objectContaining({ line: 1, column: 1, fatal: true })])
  })

  it('compiles with the routes directory and lint levels the last kay check wrote the shadow tree with', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-eslint-'))
    const page = join(root, 'pages', 'posts', '[id].kay')
    const source = '--- server\nconst id = ctx.params.id\n---\np {id}\n'

    try {
      await Bun.write(join(root, 'tsconfig.json'), '{}')
      await Bun.write(page, source)

      // Read with the default `src/routes`, the page is no route, and its params are untyped.
      expect(processor.preprocess(source, page)[0]!.text).not.toContain('"id": string')

      await writeShadowTypes(root, { routes: 'pages', lints: { 'unread-name': 'allow' } })

      expect(processor.preprocess(source, page)[0]!.text).toContain('"id": string')
      // And the lint levels it compiled with.
      expect(readShadowSettings(root).lints).toEqual({ 'unread-name': 'allow' })
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('types the params of an extension\'s page from its own routes, as the last kay check mounted them, and of none from settings written before mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-eslint-'))
    const page = join(root, 'lib', 'routes', 'posts', '[id].kay')
    const source = '--- server\nconst id = ctx.params.id\n---\np {id}\n'
    const settings = join(projectPaths(root).types, SHADOW_SETTINGS)

    try {
      await Bun.write(join(root, 'tsconfig.json'), '{}')
      await Bun.write(page, source)
      await Bun.write(settings, JSON.stringify({ routes: 'src/routes', islandOnly: [] }))

      expect(processor.preprocess(source, page)[0]!.text).not.toContain('"id": string')

      await Bun.write(settings, serializeShadowSettings(root, { routesDir: join(root, 'src/routes'), mounts: [{ dir: join(root, 'lib/routes'), prefix: '' }], islandOnly: new Set() }))

      expect(processor.preprocess(source, page)[0]!.text).toContain('"id": string')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ends a message whose end falls in generated code at the end of the word it starts on', () => {
    const [block] = processor.preprocess(CARD, FILE)
    const tsx = block!.text
    const declaration = tsx.indexOf('let count')
    const end = positionAt(tsx, tsx.length)
    const messages = processor.postprocess([[at(tsx, declaration, { endLine: end.line, endColumn: end.column })]], FILE)

    expect(messages).toEqual([expect.objectContaining({ line: 5, column: 1, endLine: 5, endColumn: 4 })])
  })

  it('drops a fix reaching past the code copied from the fence', () => {
    const [block] = processor.preprocess(CARD, FILE)
    const tsx = block!.text
    const declaration = tsx.indexOf('let count')
    const messages = processor.postprocess([[at(tsx, declaration, { fix: { range: [declaration, tsx.length], text: '' } })]], FILE)

    expect(messages).toEqual([expect.objectContaining({ line: 5, fix: undefined })])
  })

  it('points the parser at the shadow file kay check writes, and names the command when there is none yet', () => {
    const seen: string[] = []
    const parser = shadowParser({ parseForESLint: (_code: string, options: { filePath?: string, projectService?: boolean }) => seen.push(options.filePath ?? '') })
    const block = join(FILE, '0_kay.tsx')

    parser.parseForESLint('', { filePath: block })
    parser.parseForESLint('', { filePath: join(import.meta.dir, 'eslint.test.ts') })

    expect(seen).toEqual([join(import.meta.dir, '..', '.kay', 'types', 'tests', 'fixtures', 'lint', 'src', 'components', 'card.kay.tsx'), join(import.meta.dir, 'eslint.test.ts')])
    expect(() => parser.parseForESLint('', { filePath: block, projectService: true })).toThrow('tests/fixtures/lint/src/components/card.kay has no type information yet: run kay check, or kay dev, before linting it')
  })
})
