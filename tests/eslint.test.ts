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
import { scratchDir } from './scratch'

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
  async function lint(text: string, rules: Record<string, string> = { 'eqeqeq': 'error', 'dot-notation': 'error' }) {
    const { default: parser } = await tsParser
    const { ESLint } = await import('eslint')
    const overrideConfig = [
      { files: ['**/*.kay'], processor },
      { files: ['**/*.kay/*.tsx'], languageOptions: { parser }, rules },
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

  it('reports the heads of else if, await and slot, and a spread, whose spans the other constructs do not cover', async () => {
    const { messages } = await lint(`---
const { rest, load } = props<{ rest: Record<string, string>, load: Promise<string> }>()
---
section({...rest['a']})
  if rest.a === 'x'
    p x
  else if rest['b'] == 'y'
    p y
  await load['x'] then value
    p {value}
  slot row(rest['c'])
`)

    expect(messages.map(message => [message.ruleId, message.line])).toEqual([
      ['dot-notation', 4],
      ['dot-notation', 7],
      ['eqeqeq', 7],
      ['dot-notation', 9],
      ['dot-notation', 11],
    ])
  })

  it('reports an expression the compiler copies twice once', async () => {
    const { messages } = await lint('---\nconst values = { a: signal(\'\') }\n---\ninput(bind:value={values[\'a\']})\n')

    expect(messages.map(message => [message.ruleId, message.line, message.column])).toEqual([['dot-notation', 4, 26]])
  })

  it('drops a fix adding a line break to a template expression, and keeps one in a fence', () => {
    const [block] = processor.preprocess(`---\nlet count = 1\n---\np {count == 1}\n`, FILE)
    const tsx = block!.text
    const fence = tsx.indexOf('let count')
    const expression = tsx.indexOf('count == 1')
    const messages = processor.postprocess([[
      at(tsx, expression, { fix: { range: [expression, expression + 5], text: 'count\n' } }),
      at(tsx, fence, { fix: { range: [fence, fence + 3], text: 'const\n' } }),
    ]], FILE)

    expect(messages.map(message => message.fix?.text)).toEqual([undefined, 'const\n'])
  })

  it('reports no rule on the generated parentheses and wrappers around an expression', async () => {
    const { messages } = await lint('---\nconst { n } = props<{ n: number }>()\n---\nif n === 1\n  p {n === 2 ? \'a\' : \'b\'}\nconst m = n\nspan {m}\n', { 'no-extra-parens': 'error', 'no-void': 'error', 'no-sequences': 'error' })

    expect(messages).toEqual([])
  })
})

describe('kay/eslint over a template slot\'s parameters', () => {
  const tsParser = import('@typescript-eslint/parser')
  const stylistic = import('@stylistic/eslint-plugin')

  async function lint(slot: string, rules: Record<string, unknown>) {
    const { default: parser } = await tsParser
    const { default: plugin } = await stylistic
    const { ESLint } = await import('eslint')
    const overrideConfig = [
      { files: ['**/*.kay'], processor },
      { files: ['**/*.kay/*.tsx'], languageOptions: { parser }, plugins: { style: plugin }, rules },
    ] as never
    const text = `---\nconst { list } = props<{ list: number[] }>()\n---\nT(key="a")\n  ${slot}\n    span {text}\n`
    const [result] = await new ESLint({ cwd: join(import.meta.dir, 'fixtures', 'lint'), overrideConfigFile: true, overrideConfig }).lintText(text, { filePath: FILE })

    return result!.messages.map(message => [message.ruleId, message.line, message.column])
  }

  const ARROW = { 'style/arrow-parens': ['error', 'as-needed'] }

  it('reports no rule on the parentheses kay writes around a slot\'s one parameter', async () => {
    expect(await lint('@about(text)', ARROW)).toEqual([])
  })

  it('reports nothing for a slot with several parameters, none, a destructured one or one with a default', async () => {
    expect(await lint('@about(text, index)', ARROW)).toEqual([])
    expect(await lint('@about', ARROW)).toEqual([])
    expect(await lint('@about({ text })', ARROW)).toEqual([])
    expect(await lint('@about(text = \'a\')', ARROW)).toEqual([])
  })

  it('still reports the code the author wrote in a parameter, at its .kay column', async () => {
    expect(await lint('@about(text = list["length"])', { 'dot-notation': 'error', ...ARROW })).toEqual([['dot-notation', 5, 22]])
    expect(await lint('@about({ text = list["length"] })', { 'dot-notation': 'error' })).toEqual([['dot-notation', 5, 24]])
  })
})

describe('kay/eslint over template classes', () => {
  const TEMPLATE = `---
const { n } = props<{ n: number }>()
---
div.flex.flex-col.nope-x(class="p-4 m-2 w-4 h-4" id="a")
  p.text-sm.w-4.h-4(class={n ? 'a-b w-4' : 'c-d'}) hi
  span(class="w-4 h-4 flex")
`

  // The tailwind rules of the plugin @kaynooo/eslint ships, run through the processor on the file, reports as they stand and after \`--fix\`.
  async function lint(text: string) {
    const { default: parser } = await import('@typescript-eslint/parser')
    const { default: plugin } = await import('eslint-plugin-better-tailwindcss')
    const { ESLint } = await import('eslint')
    const cwd = await scratchDir('kay-eslint-classes')

    await Bun.write(join(cwd, 'src', 'app.css'), '@import "tailwindcss";\n')

    const overrideConfig = [
      { files: ['**/*.kay'], processor },
      {
        files: ['**/*.kay/*.tsx'],
        languageOptions: { parser },
        plugins: { 'better-tailwindcss': plugin },
        settings: { 'better-tailwindcss': { entryPoint: join(cwd, 'src', 'app.css') } },
        rules: { 'better-tailwindcss/no-unknown-classes': 'warn', 'better-tailwindcss/enforce-shorthand-classes': 'warn', 'better-tailwindcss/enforce-consistent-class-order': 'warn' },
      },
    ] as never
    const run = async (fix: boolean) => (await new ESLint({ cwd, overrideConfigFile: true, overrideConfig, fix }).lintText(text, { filePath: join(cwd, 'src', 'card.kay') }))[0]!

    return { messages: (await run(false)).messages, fixed: await run(true) }
  }

  it('reports a class of the shorthand and of a static class attribute at its .kay position', async () => {
    const { messages } = await lint(TEMPLATE)
    const lines = TEMPLATE.split('\n')
    const unknown = messages.filter(message => message.ruleId === 'better-tailwindcss/no-unknown-classes').map(message => lines[message.line - 1]!.slice(message.column - 1, message.endColumn! - 1))

    expect(unknown).toEqual(['nope-x', 'a-b', 'c-d'])
  })

  it('reports a shorthand rule at the first class of the pair, in the shorthand and in the attribute', async () => {
    const { messages } = await lint(TEMPLATE)
    const lines = TEMPLATE.split('\n')
    const shorthand = messages.filter(message => message.ruleId === 'better-tailwindcss/enforce-shorthand-classes' && message.message.startsWith('Non shorthand')).map(message => `${message.line}:${lines[message.line - 1]!.slice(message.column - 1, message.endColumn! - 1)}`)

    expect(shorthand).toEqual(['4:w-4', '5:w-4', '6:w-4'])
  })

  it('fixes a class inside a static attribute, and leaves the shorthand and a mixed string without a fix', async () => {
    const { fixed } = await lint('---\n---\nspan(class="w-4 h-4 flex")\ndiv.w-4.h-4(class="flex")\n')

    expect(fixed.output).toMatch(/span\(class="flex\s+size-4"\)/)
    expect(fixed.output).toContain('div.w-4.h-4(class="flex")')
  })

  it('reports nothing on a template without a class', async () => {
    const { messages } = await lint('---\n---\np hello\n')

    expect(messages).toEqual([])
  })

  it('tells two elements with the same classes apart, a component call and a class merged with a spread among them', async () => {
    const text = '---\nconst { rest } = props<{ rest: Record<string, string> }>()\n---\ndiv.zz-a\ndiv.zz-a\nFoo.zz-b(class="zz-c")\np.zz-d({...rest} class="zz-e")\n'
    const { messages } = await lint(text)
    const lines = text.split('\n')
    const found = messages.filter(message => message.ruleId === 'better-tailwindcss/no-unknown-classes').map(message => `${message.line}:${lines[message.line - 1]!.slice(message.column - 1, message.endColumn! - 1)}`)

    expect(found).toEqual(['4:zz-a', '5:zz-a', '6:zz-b', '6:zz-c', '7:zz-d', '7:zz-e'])
  })

  it('maps an edit inside a static class as written, and none on an element that also has a shorthand', () => {
    const [block] = processor.preprocess('---\n---\ndiv.w-4.h-4(class="flex")\nspan(class="a  b")\n', FILE)
    const tsx = block!.text
    const mixed = tsx.indexOf('w-4 h-4 flex')
    const plain = tsx.indexOf('a  b')
    const messages = processor.postprocess([[
      at(tsx, mixed, { ruleId: 'better-tailwindcss/probe', fix: { range: [mixed, mixed + 3], text: 'size-4' } }),
      at(tsx, mixed + 8, { ruleId: 'better-tailwindcss/probe', fix: { range: [mixed + 8, mixed + 12], text: 'block' } }),
      at(tsx, plain + 1, { ruleId: 'better-tailwindcss/probe', fix: { range: [plain + 1, plain + 2], text: '' } }),
    ]], FILE)

    expect(messages.map(message => message.fix?.text)).toEqual([undefined, undefined, ''])
  })

  it('leaves the rules about code off the strings generated for classes', () => {
    const [block] = processor.preprocess('---\n---\np.flex(class="mt-2") hi\n', FILE)
    const tsx = block!.text
    const literal = tsx.indexOf('"flex mt-2"')

    expect(processor.postprocess([[at(tsx, literal, { ruleId: 'style/quotes' }), at(tsx, literal + 1, { ruleId: 'better-tailwindcss/no-unknown-classes' })]], FILE).map(message => message.ruleId)).toEqual(['better-tailwindcss/no-unknown-classes'])
  })

  it('fixes no class of an element that also writes a shorthand, whichever string the pair is split across', async () => {
    const text = '---\n---\ndiv.w-4(class="h-4")\ndiv.h-4(class="w-4 flex")\n'
    const { fixed } = await lint(text)

    expect(fixed.output ?? text).toBe(text)
  })

  it('rewrites a static class in the order the plugin wants, quotes kept, and maps a string with irregular spaces', async () => {
    const { fixed, messages } = await lint('---\n---\ndiv(class=\'m-2 p-4 flex w-4\')\nspan(class="flex  w-4  h-4")\n')

    expect(fixed.output).toMatch(/div\(class='[^']*'\)/)
    expect(fixed.output).not.toContain('m-2 p-4 flex w-4')
    expect(messages.some(message => message.line === 4)).toBe(true)
  })

  it('reports a class on a component call, and two strings of one element reading the same only once told apart', async () => {
    const text = '---\nconst { rest } = props<{ rest: Record<string, string> }>()\n---\nFoo.zz-a(class="zz-b")\ndiv.zz-c({...rest} class="zz-c")\n'
    const { messages } = await lint(text)
    const lines = text.split('\n')
    const found = messages.filter(message => message.ruleId === 'better-tailwindcss/no-unknown-classes').map(message => `${message.line}:${lines[message.line - 1]!.slice(message.column - 1, message.endColumn! - 1)}`)

    expect(found).toEqual(['4:zz-a', '4:zz-b'])
  })
})
