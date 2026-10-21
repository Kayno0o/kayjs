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

  it('points the parser at the shadow file kay check writes', () => {
    const seen: string[] = []
    const parser = shadowParser({ parseForESLint: (_code: string, options: { filePath?: string, projectService?: boolean }) => seen.push(options.filePath ?? '') })

    parser.parseForESLint('', { filePath: join(FILE, '0_kay.tsx') })
    parser.parseForESLint('', { filePath: join(import.meta.dir, 'eslint.test.ts') })

    expect(seen).toEqual([join(import.meta.dir, '..', '.kay', 'types', 'tests', 'fixtures', 'lint', 'src', 'components', 'card.kay.tsx'), join(import.meta.dir, 'eslint.test.ts')])
  })

  it('writes the types of a project that has none yet, and names the command when it cannot', async () => {
    const root = await scratchDir('eslint-types-')
    const seen: string[] = []
    const parser = shadowParser({ parseForESLint: (_code: string, options: { filePath?: string, projectService?: boolean }) => seen.push(options.filePath ?? '') })
    const block = join(root, 'src/routes/index.kay/0_kay.tsx')

    try {
      await Bun.write(join(root, 'package.json'), '{"type":"module"}')
      await Bun.write(join(root, 'tsconfig.json'), '{"extends":"kay/tsconfig.json"}')
      await Bun.write(join(root, 'src/routes/index.kay'), 'h1 Hello\n')
      parser.parseForESLint('', { filePath: block, projectService: true })

      expect(seen).toEqual([join(root, '.kay/types/src/routes/index.kay.tsx')])
      expect(await Bun.file(seen[0]!).exists()).toBe(true)

      // A project whose config does not load has no types to write.
      await rm(join(root, '.kay'), { recursive: true, force: true })
      await Bun.write(join(root, 'kay.config.ts'), 'export default {{\n')
      expect(() => parser.parseForESLint('', { filePath: block, projectService: true })).toThrow('src/routes/index.kay has no type information yet: run kay check, or kay dev, before linting it')

      // A root that failed is not run again for every file the process lints, so a config fixed since still needs the command the error names.
      await Bun.write(join(root, 'kay.config.ts'), 'export default {}\n')
      expect(() => parser.parseForESLint('', { filePath: block, projectService: true })).toThrow('has no type information yet')
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
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

  it('reports the parameters and the body of a snippet at their lines, and nothing at the code around them', async () => {
    const { messages } = await lint(`---
const { list } = props<{ list: Record<string, string> }>()
---
snippet row(key: string, fallback = list['x'])
  p {list['b']} {key}
{row('a')}
`)

    expect(messages.map(message => [message.ruleId, message.line])).toEqual([
      ['dot-notation', 4],
      ['dot-notation', 5],
    ])
  })

  it('reports an expression the compiler copies twice once', async () => {
    const { messages } = await lint('---\nconst values = { a: signal(\'\') }\n---\ninput(bind:value={values[\'a\']})\n')

    expect(messages.map(message => [message.ruleId, message.line, message.column])).toEqual([['dot-notation', 4, 26]])
  })

  it('reports the condition of an aliased if once, as the plain one is reported', async () => {
    const { messages } = await lint('---\nconst { n } = props<{ n: number }>()\n---\nif n == 1 as one\n  p {one}\n')

    expect(messages.map(message => [message.ruleId, message.line, message.column])).toEqual([['eqeqeq', 4, 6]])
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

    expect(messages.map(message => message.fix?.text)).toEqual(['const\n', undefined])
  })

  it('reports no rule on the generated parentheses and wrappers around an expression', async () => {
    const { messages } = await lint('---\nconst { n } = props<{ n: number }>()\n---\nif n === 1\n  p {n === 2 ? \'a\' : \'b\'}\nconst m = n\nspan {m}\n', { 'no-extra-parens': 'error', 'no-void': 'error', 'no-sequences': 'error' })

    expect(messages).toEqual([])
  })

  it('reports no ternary rule on the read of a defaulted prop, at the top level, in a function or in the template', async () => {
    const head = '---\nconst { digits = 1, flag } = props<{ digits?: number | undefined, flag: boolean }>()\n'
    const bodies = [
      'const top = flag ? 0 : digits\n---\np {top}\n',
      'const a = (x: boolean) => x ? 0 : digits\n---\np {a(true)}\n',
      'const a = (x: boolean) => {\n  const d = x ? 0 : digits\n  return d\n}\n---\np {a(true)}\n',
      '---\np {flag ? 0 : digits}\n',
    ]

    for (const body of bodies) {
      const { messages } = await lint(head + body, { 'no-nested-ternary': 'error', 'no-unneeded-ternary': 'error', 'no-extra-parens': 'error' })

      expect(messages).toEqual([])
    }
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

  it('reports no rule on a slot\'s one parameter whichever way arrow-parens asks, and no fix writes a head that does not parse', async () => {
    expect(await lint('@about(text)', { 'style/arrow-parens': ['error', 'always'] })).toEqual([])
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
  async function lint(text: string, rules: Record<string, string> = {}) {
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
        rules: { 'better-tailwindcss/no-unknown-classes': 'warn', 'better-tailwindcss/enforce-shorthand-classes': 'warn', 'better-tailwindcss/enforce-consistent-class-order': 'warn', ...rules },
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

  it('reports and fixes a class of a static class attribute written over lines at its own line', async () => {
    const text = '---\n---\ndiv(\n  class="\n    flex zz-a\n    w-4 h-4\n  "\n) x\n'
    const { fixed, messages } = await lint(text)
    const lines = text.split('\n')
    const found = messages.filter(message => message.ruleId?.startsWith('better-tailwindcss/')).map(message => `${message.line}:${lines[message.line - 1]!.slice(message.column - 1, message.endColumn! - 1)}`)

    expect(found).toContain('5:zz-a')
    expect(found).toContain('6:w-4')
    expect(fixed.output).toContain('size-4')
    expect(fixed.output).toContain('div(\n  class="')
    expect(fixed.output).toEndWith('"\n) x\n')
  })

  it('reports a class of a multi-line static class beside a shorthand at its own line, without a fix', async () => {
    const text = '---\n---\ndiv.flex(\n  class="\n    zz-a\n    w-4\n  "\n) x\n'
    const { fixed, messages } = await lint(text)
    const lines = text.split('\n')
    const found = messages.filter(message => message.ruleId?.startsWith('better-tailwindcss/')).map(message => `${message.line}:${lines[message.line - 1]!.slice(message.column - 1, message.endColumn! - 1)}`)

    expect(found).toContain('5:zz-a')
    expect(fixed.output ?? text).toBe(text)
  })

  it('removes the line of a class a fix deletes from a static class over lines, and the gap of one inside a line', async () => {
    const text = '---\n---\ndiv(\n  class="\n    flex\n    flex\n    p-2 p-2\n    underline underline\n  "\n) x\n'
    const { fixed } = await lint(text, { 'better-tailwindcss/no-duplicate-classes': 'warn' })

    expect(fixed.output).toBe('---\n---\ndiv(\n  class="\n    flex\n    p-2\n    underline\n  "\n) x\n')
  })

  it('removes the space a deleted class leaves in a one-line static class', async () => {
    const { fixed } = await lint('---\n---\ndiv(class="flex flex underline underline")\n', { 'better-tailwindcss/no-duplicate-classes': 'warn' })

    expect(fixed.output).toBe('---\n---\ndiv(class="flex underline")\n')
  })

  it('reports a class on a component call, and two strings of one element reading the same only once told apart', async () => {
    const text = '---\nconst { rest } = props<{ rest: Record<string, string> }>()\n---\nFoo.zz-a(class="zz-b")\ndiv.zz-c({...rest} class="zz-c")\n'
    const { messages } = await lint(text)
    const lines = text.split('\n')
    const found = messages.filter(message => message.ruleId === 'better-tailwindcss/no-unknown-classes').map(message => `${message.line}:${lines[message.line - 1]!.slice(message.column - 1, message.endColumn! - 1)}`)

    expect(found).toEqual(['4:zz-a', '4:zz-b'])
  })
})

describe('kay/eslint versions', () => {
  it('carries kay\'s version on the processor and the parser, so the ESLint cache drops with a kay upgrade', async () => {
    const { version } = await Bun.file(join(import.meta.dir, '..', 'package.json')).json() as { version: string }

    expect(processor.meta.version).toBe(version)
    expect(shadowParser({ parseForESLint: () => 0 }).meta).toEqual({ name: 'kay/shadow-parser', version })
  })

  it('lints a cached file again once the processor\'s version changes, and not before', async () => {
    const { ESLint } = await import('eslint')
    const root = await scratchDir('eslint-cache-')
    const file = join(root, 'a.kay')
    const cacheLocation = join(root, 'cache')
    let linted = 0
    const run = async (version: string) => {
      const counting = { ...processor, meta: { ...processor.meta, version }, preprocess(text: string, filename: string) {
        linted++

        return processor.preprocess(text, filename)
      } }
      const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{ files: ['**/*.kay'], processor: counting }] as never, cache: true, cacheLocation })

      await eslint.lintFiles([file])
    }

    await Bun.write(join(root, 'tsconfig.json'), '{}')
    await Bun.write(file, CARD)

    await run('1.0.0')
    await run('1.0.0')

    expect(linted).toBe(1)

    await run('1.0.1')

    expect(linted).toBe(2)
  })
})

describe('kay/eslint messages over template expressions', () => {
  const tsParser = import('@typescript-eslint/parser')

  async function lint(text: string, rules: Record<string, unknown>) {
    const { default: parser } = await tsParser
    const { ESLint } = await import('eslint')
    const overrideConfig = [
      { files: ['**/*.kay'], processor },
      { files: ['**/*.kay/*.tsx'], languageOptions: { parser }, rules },
    ] as never

    return (await new ESLint({ cwd: join(import.meta.dir, 'fixtures', 'lint'), overrideConfigFile: true, overrideConfig }).lintText(text, { filePath: FILE }))[0]!.messages
  }

  it('names the file\'s own identifiers in a message, and keeps the __props a file writes', async () => {
    const [implicit] = await lint('---\nconst { matching } = props<{ matching: string[] }>()\n---\np {`${matching.length}`}\n', { 'no-implicit-coercion': ['error', { disallowTemplateShorthand: true }] })

    expect(implicit!.message).toContain('String(matching.length)')
    expect(implicit!.message).not.toContain('__props')

    const [literal] = await lint('---\nconst { list } = props<{ list: number[] }>()\nconst note = `${list.length}`\n---\np x\n', { 'no-implicit-coercion': ['error', { disallowTemplateShorthand: true }] })

    expect(literal!.message).toContain('String(list.length)')

    const [fence] = await lint('---\nconst __props = { a: 1 }\nconst s = `${__props.a}`\n---\np x\n', { 'no-implicit-coercion': ['error', { disallowTemplateShorthand: true }] })

    expect(fence!.message).toContain('String(__props.a)')
  })

  it('names them in the description and the text of a suggestion and a fix', () => {
    const source = '---\nconst { list } = props<{ list: number[] }>()\n---\np {list.length}\n'
    const [block] = processor.preprocess(source, FILE)
    const tsx = block!.text
    const start = tsx.indexOf('__props.list.length') + '__props.'.length
    const range: [number, number] = [start, start + 'list'.length]
    const fix = { range, text: 'String(__props.list.length)' }
    const [message] = processor.postprocess([[at(tsx, start, { message: 'Use String(__props.list.length)', fix, suggestions: [{ desc: 'Wrap __props.list.length', fix }] })]], FILE)

    expect(message).toEqual(expect.objectContaining({ message: 'Use String(list.length)', fix: { range: [source.indexOf('list.length'), source.indexOf('list.length') + 4], text: 'String(list.length)' } }))
    expect(message!.suggestions![0]!.desc).toBe('Wrap list.length')
    expect(message!.suggestions![0]!.fix.text).toBe('String(list.length)')
  })
})

describe('kay/eslint over the indentation of a fence', () => {
  const tsParser = import('@typescript-eslint/parser')
  const stylistic = import('@stylistic/eslint-plugin')
  const INDENT = { 'style/indent': ['error', 2, { CallExpression: { arguments: 'first' } }] }

  async function lint(text: string, rules: Record<string, unknown> = INDENT) {
    const { default: parser } = await tsParser
    const { default: plugin } = await stylistic
    const { ESLint } = await import('eslint')
    const overrideConfig = [
      { files: ['**/*.kay'], processor },
      { files: ['**/*.kay/*.tsx'], languageOptions: { parser }, plugins: { style: plugin }, rules },
    ] as never
    const run = async (fix: boolean) => (await new ESLint({ cwd: join(import.meta.dir, 'fixtures', 'lint'), overrideConfigFile: true, overrideConfig, fix }).lintText(text, { filePath: FILE }))[0]!
    const fixed = await run(true)

    return { messages: (await run(false)).messages.map(message => [message.ruleId, message.line, message.column]), fixed: fixed.output ?? text, left: fixed.messages.map(message => [message.ruleId, message.line]) }
  }

  const MISINDENTED = `---
const a = 1
  const b = 2
function run() {
const c = 3
    const d = 4
  if (c) {
     go()
  }
}
---
--- server
const e = 1
 const f = 2
---
p {a}
`

  it('reports a line misindented by any amount, an over-indent of one level included, at its .kay line', async () => {
    const { messages } = await lint(MISINDENTED)

    expect(messages).toEqual([
      ['style/indent', 3, 1],
      ['style/indent', 5, 1],
      ['style/indent', 6, 1],
      ['style/indent', 8, 1],
      ['style/indent', 14, 1],
    ])
  })

  it('reindents them as in a .ts file', async () => {
    const { fixed, left } = await lint(MISINDENTED)

    expect(fixed).toBe(`---
const a = 1
const b = 2
function run() {
  const c = 3
  const d = 4
  if (c) {
    go()
  }
}
---
--- server
const e = 1
const f = 2
---
p {a}
`)
    expect(left).toEqual([])
  })

  it('reports nothing on a fence indented as a .ts file would be', async () => {
    const { messages } = await lint(`---
import {
  signal,
} from 'kay'
import { x } from './x'
export const hoisted = {
  a: 1,
}
const total = signal(0)
function run(list: number[]) {
  // note
  /* block
     more */
  const text = \`first
second\`

  return list.map((n) => {
    return n + 1
  })
}
const tabbed = {
\ta: 1,
}
---
--- server
const items = [
  1,
  2,
]
export const post = {
  a: 1,
}
---
p {total}
`)

    expect(messages).toEqual([['style/indent', 22, 1]])
  })

  it('reports a tab once, as the indent rule and not as mixed spaces and tabs', async () => {
    const { messages } = await lint('---\nconst tabbed = {\n\ta: 1,\n}\n---\np hi\n', { ...INDENT, 'style/no-mixed-spaces-and-tabs': 'error', 'style/no-tabs': 'error' })

    expect(messages).toEqual([['style/indent', 3, 1], ['style/no-tabs', 3, 1]])
  })

  it('leaves blank lines without trailing spaces', async () => {
    const { messages } = await lint('---\nconst a = 1\n\nfunction run() {\n  const b = 2\n\n  return b\n}\n---\np {a}\n', { ...INDENT, 'style/no-trailing-spaces': 'error' })

    expect(messages).toEqual([])
  })

  it('lays out the line a brace-style fix breaks, with the indent rule on', async () => {
    const { fixed, left } = await lint('--- server\ntry {\n  await Promise.resolve()\n} catch (e) {\n  console.error(e)\n}\n---\np hi\n', { ...INDENT, 'style/brace-style': ['error', 'stroustrup'] })

    expect(fixed).toBe('--- server\ntry {\n  await Promise.resolve()\n}\ncatch (e) {\n  console.error(e)\n}\n---\np hi\n')
    expect(left).toEqual([])
  })

  it('writes a fix over several lines at the indentation of the file', async () => {
    const text = '---\nfunction run() {\n  const total = 1 +\n    2\n\n  return total\n}\n---\np hi\n'
    const { fixed } = await lint(text, { ...INDENT, 'style/operator-linebreak': ['error', 'before'] })

    expect(fixed).toBe('---\nfunction run() {\n  const total = 1\n    + 2\n\n  return total\n}\n---\np hi\n')
  })

  it('judges the arguments of a call by the columns of the file, even when a name before them is rewritten', async () => {
    const aligned = '---\nconst { price } = props<{ price: number }>()\nconst total = Math.max(price,\n                       1)\n---\np {total}\n'
    const { messages } = await lint(aligned)

    expect(messages).toEqual([])
  })

  it('reports an argument not aligned to the first one of its call', async () => {
    const { messages } = await lint('---\nconst total = Math.max(1,\n                  2)\n---\np {total}\n')

    expect(messages).toEqual([['style/indent', 3, 1]])
  })

  it('reports nothing in a file that has no fence', async () => {
    expect((await lint('p hi\n')).messages).toEqual([])
  })
})

describe('kay/eslint over a line a fix breaks in a fence', () => {
  const tsParser = import('@typescript-eslint/parser')
  const stylistic = import('@stylistic/eslint-plugin')
  const SERVER = '--- server\ntry {\n  await Promise.resolve()\n} catch (e) {\n  console.error(e)\n}\n---\np hi\n'
  const NESTED = '---\nfunction run() {\n  try {\n    go()\n  } catch (e) {\n    stop(e)\n  }\n}\n---\np hi\n'

  async function fixed(text: string, rules: Record<string, unknown> = { 'style/brace-style': ['error', 'stroustrup'] }): Promise<string> {
    const { default: parser } = await tsParser
    const { default: plugin } = await stylistic
    const { ESLint } = await import('eslint')
    const overrideConfig = [
      { files: ['**/*.kay'], processor },
      { files: ['**/*.kay/*.tsx'], languageOptions: { parser }, plugins: { style: plugin }, rules },
    ] as never
    const [result] = await new ESLint({ cwd: join(import.meta.dir, 'fixtures', 'lint'), overrideConfigFile: true, overrideConfig, fix: true }).lintText(text, { filePath: FILE })

    return result!.output ?? text
  }

  it('indents the line a fix breaks as the line it breaks, at the top level and nested', async () => {
    expect(await fixed(SERVER)).toBe('--- server\ntry {\n  await Promise.resolve()\n}\ncatch (e) {\n  console.error(e)\n}\n---\np hi\n')
    expect(await fixed(NESTED)).toBe('---\nfunction run() {\n  try {\n    go()\n  }\n  catch (e) {\n    stop(e)\n  }\n}\n---\np hi\n')
  })

  it('leaves a blank line a fix inserts without indentation', async () => {
    const text = '---\nfunction run() {\n  const a = 1\n  return a\n}\n---\np hi\n'

    expect(await fixed(text, { 'style/padding-line-between-statements': ['error', { blankLine: 'always', prev: '*', next: 'return' }] })).toBe('---\nfunction run() {\n  const a = 1\n\n  return a\n}\n---\np hi\n')
  })

  it('leaves the indentation of code already broken alone', async () => {
    const broken = NESTED.replace('} catch (e) {', '}\n  catch (e) {')

    expect(await fixed(broken)).toBe(broken)
  })
})
