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

  it('names else if once for elif', async () => {
    const found = await report('---\nconst a = true\n---\nif a\n  p a\nelif a\n  p b\n')

    expect(errors(found)).toEqual([[6, 1, 'TS2339', 'kay writes it as two words, `else if condition`']])
  })

  it('tells kay writes class and for', async () => {
    const found = await report('---\n---\nbutton(className="x") go\nbutton(class="x" htmlFor="y") go\n')

    expect(errors(found).map(error => error[3])).toEqual(['kay writes the HTML attribute, `class`, not `className`', 'kay writes the HTML attribute, `for`, not `htmlFor`'])
  })

  it('keeps every unknown element and reports each elif once, nested or beside siblings', async () => {
    const typos = errors(await report('---\n---\ndiv\n  p a\n  lii b\n  p c\n  spann d\n'))

    expect(typos.map(error => [error[2], error[3]])).toEqual(Array.from({ length: 4 }, () => ['TS2339', undefined]))

    const nested = errors(await report('---\nconst a = true\n---\ndiv\n  if a\n    p a\n  elif a\n    p b\n  elif a\n    p c\n  span x\n'))

    expect(nested.map(error => [error[0], error[3]])).toEqual([[7, 'kay writes it as two words, `else if condition`'], [9, 'kay writes it as two words, `else if condition`']])
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
})
