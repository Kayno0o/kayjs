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

describe('kay/eslint over template expressions', () => {
  const TEMPLATE = `---
const { n, list } = props<{ n: number, list: { id: number }[] }>()
---
p(
  title={n == 1 ? 'a' : 'b'}
  onClick={() => list['length']}
) {n == 2}
if n == 3 as x
  span {x}
for a, i of list key={a.id == i ? 1 : 2}
  span {a.id}
match n
  when 1, list['length']
    span x
const m = n == 4
span {m}
`
  const tsParser = import('@typescript-eslint/parser')

  // The rules of ESLint run through the processor on the file, as keslint runs them: the reports as they stand, and after `--fix`.
  async function lint(text: string) {
    const { default: parser } = await tsParser
    const { ESLint } = await import('eslint')
    const overrideConfig = [
      { files: ['**/*.kay'], processor },
      { files: ['**/*.kay/*.tsx'], languageOptions: { parser }, rules: { 'eqeqeq': 'error', 'dot-notation': 'error' } },
    ] as never
    const run = async (fix: boolean) => (await new ESLint({ cwd: join(import.meta.dir, 'fixtures', 'lint'), overrideConfigFile: true, overrideConfig, fix }).lintText(text, { filePath: FILE }))[0]!

    return { messages: (await run(false)).messages, fixed: await run(true) }
  }

  it('reports the rules of ESLint in expressions at their .kay line and column, whichever construct holds them', async () => {
    const { messages } = await lint(TEMPLATE)

    expect(messages.map(message => [message.ruleId, message.line, message.column])).toEqual([
      ['eqeqeq', 5, 12],
      ['dot-notation', 6, 23],
      ['eqeqeq', 7, 6],
      ['eqeqeq', 8, 6],
      ['eqeqeq', 10, 28],
      ['dot-notation', 13, 16],
      ['eqeqeq', 15, 13],
    ])
  })

  it('reports nothing on the generated code around an expression, nor on static text', async () => {
    const { messages } = await lint('---\nconst { n } = props<{ n: number }>()\n---\np.flex(title="a == b") a == b {n === 1}\n')

    expect(messages).toEqual([])
  })

  it('drops a fix reaching past an expression', () => {
    const [block] = processor.preprocess(TEMPLATE, FILE)
    const tsx = block!.text
    const start = tsx.indexOf('__props.n == 1')
    const messages = processor.postprocess([[at(tsx, start + '__props.n '.length, { fix: { range: [start, tsx.indexOf('</p>')], text: '' } })]], FILE)

    expect(messages).toEqual([expect.objectContaining({ line: 5, fix: undefined })])
  })

  it('applies the fixes inside expressions to the .kay file', async () => {
    const { fixed } = await lint(TEMPLATE)

    expect(fixed.output).toContain('onClick={() => list.length}')
    expect(fixed.output).toContain('when 1, list.length')
  })

  it('fixes a fence and a template expression of one file together', async () => {
    const { fixed } = await lint('---\nconst { list } = props<{ list: number[] }>()\nconst size = list["length"]\n---\np {list["length"]}\n')

    expect(fixed.output).toBe('---\nconst { list } = props<{ list: number[] }>()\nconst size = list.length\n---\np {list.length}\n')
    expect(fixed.messages).toEqual([])
  })
})
