import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, setDefaultTimeout } from 'bun:test'
import { check as checkProject } from '../src/check'
import { limiter } from '../src/server/limit'
import { scratchDir } from './scratch'

const turn = limiter(4)

setDefaultTimeout(90_000)

const tsconfig = JSON.stringify({
  compilerOptions: { target: 'ESNext', jsx: 'preserve', jsxImportSource: 'kay', lib: ['ESNext', 'DOM'], rootDirs: ['.', '.kay/types'], module: 'Preserve', moduleResolution: 'bundler', strict: true, noEmit: true, skipLibCheck: true },
  include: ['src', '.kay/types'],
})

async function report(page: string, extra: Record<string, string> = {}): Promise<{ line: number, code: string | undefined, message: string, help: string | undefined, column: number | undefined }[]> {
  const root = await scratchDir('hints-')

  try {
    await Promise.all(Object.entries({ 'tsconfig.json': tsconfig, 'src/routes/index.kay': page, ...extra }).map(async ([path, content]) => Bun.write(join(root, path), content)))

    return (await turn(async () => checkProject(root))).map(d => ({ line: d.line, code: d.code, message: d.message, help: d.help, column: (d as { column?: number }).column }))
  }
  finally {
    await rm(root, { recursive: true, force: true })
  }
}

const card = '---\nconst { title } = props<{ title: number }>()\n---\np {title}\n'
const signals = '---\nimport { signal } from "kay"\nconst n = signal(0)\nconst open = signal(false)\n---\n'

function errors(found: Awaited<ReturnType<typeof report>>) {
  return found.filter(d => d.code !== 'missing-label').map(d => [d.line, d.column, d.code, d.help])
}

describe('hints for the first template mistakes', () => {
  it('tells to pass the function or wrap the call for a handler written as a call', async () => {
    const found = await report('---\nconst bump = () => {}\nconst add = (n: number) => {}\n---\nbutton(onClick={bump()}) go\nbutton(onClick={add(2)}) go\n')

    expect(errors(found)).toEqual([
      [5, 8, 'TS2322', '`bump()` runs as the page renders and hands its result over: pass the function, `onClick={bump}`, or wrap the call, `onClick={() => bump()}`'],
      [6, 8, 'TS2322', '`add(2)` runs as the page renders and hands its result over: wrap the call so it runs on the event, `onClick={() => add(2)}`'],
    ])
  })

  it('reports a mistyped bind at the bind attribute and names the fix', async () => {
    const found = await report(`${signals}input(type="text" bind:value={n})\ninput(type="checkbox" bind:value={open})\n`)

    expect(errors(found)).toEqual([
      [6, 19, 'TS2345', '`bind:value` writes a string; for an input give it `type="number"` or `type="range"` for a signal holding a number, or make the signal a string'],
      [7, 23, 'TS2345', 'a checkbox is bound with `bind:checked={...}`, which holds a boolean; `bind:value` holds the checkbox\'s `value` string'],
    ])
  })

  it('takes any iterable in a for and reports a non-iterable once, at its expression', async () => {
    const found = errors(await report('---\nconst tags = new Set(["a"])\nconst pairs = new Map([["a", 1]])\nfunction* count() { yield 1 }\n---\nfor tag of tags\n  p {tag.length}\nfor [name, n] of pairs\n  p {name}{n.toFixed()}\nfor n of count()\n  p {n}\nfor key of pairs.keys()\n  p {key.length}\nfor bad of 5\n  p {bad}\n'))

    expect(found.map(error => [error[0], error[1]])).toEqual([[14, 12]])
  })

  it('names else if once for elif', async () => {
    const found = await report('---\nconst a = true\n---\nif a\n  p a\nelif a\n  p b\n')

    expect(errors(found)).toEqual([[6, 1, 'TS2339', 'kay writes it as two words, `else if condition`']])
  })

  it('tells kay writes class and for', async () => {
    const found = await report('---\n---\nbutton(className="x") go\nbutton(class="x" htmlFor="y") go\n')

    expect(errors(found).map(error => error[3])).toEqual(['kay writes the HTML attribute, `class`, not `className`', 'kay writes the HTML attribute, `for`, not `htmlFor`'])
  })

  it('names data-tooltip for a tooltip attribute', async () => {
    const found = await report('---\n---\na(href="/" tooltip="Home") go\n')

    expect(errors(found).map(error => error[3])).toEqual([expect.stringContaining('`data-tooltip="..."`')])
  })

  it('reports each unknown element once, nearest HTML element suggested', async () => {
    const typos = errors(await report('---\n---\ndiv\n  p a\n  lii b\n  p c\n  spann d\n  zzzzz e\n'))

    expect(typos.map(error => [error[0], error[2], error[3]])).toEqual([
      [5, 'TS2339', '`lii` is no HTML element, snippet or component in scope: did you mean `li`?'],
      [7, 'TS2339', '`spann` is no HTML element, snippet or component in scope: did you mean `span`?'],
      [8, 'TS2339', '`zzzzz` is no HTML element, snippet or component in scope'],
    ])
  })

  it('says a snippet is rendered in braces and an imported lowercase name is a component to capitalise', async () => {
    const found = errors(await report('---\nimport card from "../card.kay"\n---\nsnippet foo()\n  p hi\nfoo() text\ncard(title="a") text\n', { 'src/card.kay': card }))

    expect(found.filter(error => error[2] === 'TS2339').map(error => [error[0], error[3]])).toEqual([
      [6, '`foo` is a snippet, which is rendered in braces: `{foo(...)}`'],
      [7, 'components are capitalised: import it as `Card` and call `Card(...)`'],
    ])
  })

  it('recognises an import written over several lines', async () => {
    const found = errors(await report('---\nimport {\n  card,\n} from "../card.kay"\n---\ncard(title="a") text\n', { 'src/card.kay': card }))

    expect(found.filter(error => error[2] === 'TS2339').map(error => error[3])).toEqual(['components are capitalised: import it as `Card` and call `Card(...)`'])
  })

  it('names the component without its props when they are a named type', async () => {
    const found = await report('---\nimport Card from "../card.kay"\n---\nCard(title="a" nope={1})\n', { 'src/card.kay': '---\ninterface CardProps {\n  title: string\n}\nconst { title } = props<CardProps>()\n---\np {title}\n' })

    expect(found.filter(d => d.code === 'TS2322').map(d => [d.message, d.help])).toEqual([['`Card` does not take `nope`', '`Card` has no `nope` prop: declare it in its `props<{ ... }>()`']])
  })

  it('names the component and the props it takes when a call gives one it does not declare', async () => {
    const found = await report('---\nimport Card from "../card.kay"\n---\nCard(title="a" class="x")\nCard(title="a" nope={1})\nCard(title="a")\n  @foo\n    p x\nCard(title="a")\n  p child\n', { 'src/card.kay': '---\nimport type { Snippet } from "kay"\nconst { title } = props<{ title: string, actions?: Snippet, v?: "a" | "b" }>()\n---\np {title}\nslot actions\n' })
    const props = found.filter(d => d.code === 'TS2322')

    expect(props.map(d => [d.line, d.message, d.help])).toEqual([
      [4, '`Card` does not take `class`', '`Card` takes no `class`: put `part="root"` on the element it should reach (or `part="name"` for an inner one), or declare `class?: string` in its props'],
      [5, '`Card` does not take `nope`', '`Card` has no `nope` prop, it takes `title`, `actions`, `v`: declare it in its `props<{ ... }>()`'],
      [7, '`Card` does not take a `foo` block', '`Card` has no `foo` block, its blocks are `@actions`: a block is a prop typed `Snippet`, read with `slot foo`'],
      [9, '`Card` does not take children', '`Card` has no `slot`, so it takes no children: add a `slot` line where they go, or leave them out'],
    ])
  })

  it('reports each elif once, nested or beside siblings', async () => {
    const nested = errors(await report('---\nconst a = true\n---\ndiv\n  if a\n    p a\n  elif a\n    p b\n  elif a\n    p c\n  span x\n'))

    expect(nested.map(error => [error[0], error[3]])).toEqual([[7, 'kay writes it as two words, `else if condition`'], [9, 'kay writes it as two words, `else if condition`']])
  })

  it('counts an elif tag by its whole name, a longer tag opening the same way not shifting the ordinal', async () => {
    const found = errors(await report('---\nconst a = true\n---\ndiv\n  elifx\n  if a\n    p a\n  elif a\n    p b\n'))

    expect(found.filter(error => String(error[3]).includes('two words')).map(error => error[0])).toEqual([8])
  })

  it('ends a handler\'s braces past a regular expression, a comment and a template holding a quote or a brace', async () => {
    const found = await report('---\nconst bump = (value: unknown) => {}\n---\nbutton(onClick={bump(/\'/)}) go\nbutton(onClick={bump(`a ${\'}\'} b`)}) go\nbutton(onClick={bump(1 /* \' */)}) go\n')

    expect(found.filter(d => d.help !== undefined).map(d => [d.line, d.help!.slice(0, d.help!.indexOf(' runs as'))])).toEqual([[4, '`bump(/\'/)`'], [5, '`bump(`a ${\'}\'} b`)`'], [6, '`bump(1 /* \' */)`']])
  })

  it('adds no help to valid handlers and binds', async () => {
    const found = await report('---\nimport { signal } from "kay"\nconst text = signal("")\nconst bump = () => {}\n---\nbutton(onClick={() => bump()}) go\nbutton(onClick={bump}) go\nlabel Name\n  input(type="text" bind:value={text})\n')

    expect(errors(found).every(error => error[3] === undefined)).toBe(true)
  })

  it('reports an unquoted attribute value once with its braces', async () => {
    const found = await report('---\nimport Card from "../card.kay"\n---\nCard(title=3)\n', { 'src/card.kay': card })

    expect(found.map(d => [d.code, d.help])).toEqual([['template-syntax', '`title={3}`']])
  })

  it('lets a kay-allow comment pass a deliberate clock read in an island and fails one without it', async () => {
    const page = (above: string) => `---\nimport { signal } from "kay"\nconst n = signal(0)\n${above}const stamp = new Date().getFullYear()\n---\nbutton(onClick={() => n++}) {n()} {stamp}\n`

    expect((await report(page('// kay-allow hydration-mismatch\n'))).map(d => d.code)).toEqual([])
    expect((await report(page(''))).map(d => d.code)).toEqual(['hydration-mismatch'])
  })

  it('lets a kay-allow comment above a clock read chained over several lines cover it, and one inside a template expression', async () => {
    const chained = (above: string) => `---\nimport { signal } from "kay"\nconst n = signal(0)\n${above}const stamp = new Date()\n  .toLocaleDateString()\n---\nbutton(onClick={() => n++}) {n()} {stamp}\n`
    const inline = (above: string) => `---\nimport { signal } from "kay"\nconst n = signal(0)\n---\n${above}button(onClick={() => n++}) {n()} {new Date().getFullYear()}\n`

    expect((await report(chained('// kay-allow hydration-mismatch\n'))).map(d => d.code)).toEqual([])
    expect((await report(chained(''))).map(d => d.code).toSorted()).toEqual(['hydration-mismatch', 'hydration-mismatch'])
    expect((await report(inline('// kay-allow hydration-mismatch\n'))).map(d => d.code)).toEqual([])
    expect((await report(inline(''))).map(d => d.code)).toEqual(['hydration-mismatch'])
  })
})
