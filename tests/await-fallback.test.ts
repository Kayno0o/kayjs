import type { JSX } from '../src/runtime/jsx'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { describeThrown } from '../src/build/sourcemap'
import { compileKay } from '../src/compiler'
import { renderToString } from '../src/server'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

let dir = ''
let cases = 0
const reported: unknown[] = []
let app: Awaited<ReturnType<typeof pages>>

const FENCE = '--- server\nconst { value } = props<{ value: Promise<string> }>()\n---\n'

async function load<P extends object = object>(source: string): Promise<(props: P) => JSX.Element> {
  const file = join(dir, `case-${cases++}.kay`)

  await Bun.write(file, source)

  return (await import(file) as { default: (props: P) => JSX.Element }).default
}

beforeAll(async () => {
  dir = await scratchDir('await-fallback-')
  await Promise.all([
    Bun.write(join(dir, 'routes/guarded.kay'), '--- server\nconst slow = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'Down\')\n})()\n---\nh1 Page\ntry\n  await slow\n    p.pending Loading\n  then text\n    p.text {text}\ncatch error\n  p.failed Unavailable: {(error as Error).message}\n'),
    Bun.write(join(dir, 'routes/silent.kay'), '--- server\nconst slow = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'Down\')\n})()\n---\ntry\n  await slow\n    p.pending Loading\n  then text\n    p.text {text}\np.after After\n'),
    Bun.write(join(dir, 'routes/nested.kay'), '--- server\nconst outer = Promise.resolve(\'ok\')\nconst inner = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'Inner\')\n})()\n---\ntry\n  await outer then first\n    p.first {first}\n    await inner then second\n      p.second {second}\ncatch\n  p.failed Outer\n'),
    Bun.write(join(dir, 'routes/own.kay'), '--- server\nconst slow = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'Own\')\n})()\n---\ntry\n  await slow then text\n    p.text {text}\n  catch\n    p.own Own\ncatch\n  p.failed Outer\n'),
    Bun.write(join(dir, 'routes/outside.kay'), '--- server\nconst slow = (globalThis as { outside?: () => Promise<string> }).outside!()\n---\nh1 Page\n// kay-allow uncaught-await\nawait slow then text\n  p.text {text}\n'),
    Bun.write(join(dir, 'routes/snippet.kay'), '--- server\nconst second = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'Second\')\n})()\nconst items = [1, 2]\n---\ntry\n  snippet row(n: number)\n    await second then text\n      p.row {n} {text}\n  for item of items key={item}\n    {row(item)}\ncatch\n  p.failed Failed\n'),
    Bun.write(join(dir, 'routes/in-catch.kay'), '--- server\nconst first = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'First\')\n})()\nfunction broken(): string {\n  throw new Error(\'Broken\')\n}\n---\ntry\n  try\n    p {broken()}\n  catch\n    await first then text\n      p.in-catch {text}\ncatch\n  p.outer Outer\n'),
    Bun.write(join(dir, 'routes/in-bare-catch.kay'), '--- server\nconst first = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'First\')\n})()\nfunction broken(): string {\n  throw new Error(\'Broken\')\n}\n---\ntry\n  p {broken()}\ncatch\n  // kay-allow uncaught-await\n  await first then text\n    p.in-catch {text}\n'),
    Bun.write(join(dir, 'routes/bare.kay'), '--- server\nconst slow = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'Bare\')\n})()\nconst plain = (async () => {\n  await Bun.sleep(10)\n  throw \'text only\'\n})()\n---\n// kay-allow uncaught-await\nawait slow\n  p.pending Loading\nthen text\n  p.text {text}\n// kay-allow uncaught-await\nawait plain then text\n  p.text {text}\n'),
    Bun.write(join(dir, 'routes/shell.kay'), '--- server\nconst slow = Promise.reject(new Error(\'Early\'))\n---\ntry\n  p.sync Shell\n  await slow\n    p.pending Loading\n  then text\n    p.text {text}\ncatch\n  p.failed Failed\n'),
  ])
  app = await pages({ root: dir, routes: 'routes', prebuilt: false, security: false, onError: error => void reported.push(error) })
})

afterAll(async () => rm(dir, { recursive: true, force: true }))

async function page(path: string): Promise<string> {
  reported.length = 0

  return (await app.handle(new Request(`http://localhost${path}`))).text()
}

// The template a streamed block swapped in.
function swaps(html: string): string[] {
  return [...html.matchAll(/<template data-kay-await="\w+">(.*?)<\/template>/g)].map(match => match[1]!)
}

describe('an await block with no catch, inside a try, on a page', () => {
  it('streams the catch block of the try in place of the pending block, reporting the error once', async () => {
    const html = await page('/guarded')

    expect(html).toContain('<p class="pending">Loading</p>')
    expect(swaps(html)).toEqual(['<p class="failed">Unavailable: Down</p>'])
    expect(reported.map(error => (error as Error).message)).toEqual(['Down'])
  })

  it('shows nothing for a try with no catch block, and leaves the rest of the page', async () => {
    const html = await page('/silent')

    expect(swaps(html)).toEqual([''])
    expect(html).toContain('<p class="after">After</p>')
    expect(reported).toHaveLength(1)
  })

  it('takes the try around an await nested in a then block, which streams in its own turn', async () => {
    const html = await page('/nested')

    expect(swaps(html)).toEqual(['<p class="first">ok</p><!--kay-await:0_0--><!--/kay-await:0_0-->', '<p class="failed">Outer</p>'])
    expect(reported).toHaveLength(1)
  })

  it('leaves an await block with a catch block of its own to it, reporting nothing', async () => {
    const html = await page('/own')

    expect(swaps(html)).toEqual(['<p class="own">Own</p>'])
    expect(reported).toEqual([])
  })

  it('renders the catch block of a block that rejected before the page went out', async () => {
    const html = await page('/shell')

    expect(html).toContain('<p class="sync">Shell</p>')
    expect(swaps(html)).toEqual(['<p class="failed">Failed</p>'])
    expect(reported).toHaveLength(1)
  })
})

describe('an await block with no catch and no try', () => {
  it('reports a rejection made outside the page at the line of its await block, once however often the promise is shared', async () => {
    const failure = new Error('Out')
    const shared = Promise.reject(failure)

    void Promise.allSettled([shared])
    Object.assign(globalThis, { outside: async () => shared })
    await page('/outside')
    await page('/outside')

    const lines = describeThrown(failure).match(/outside\.kay:\d+/g) ?? []

    expect(reported).toHaveLength(1)
    expect(lines).toEqual(['outside.kay:6'])
  })

  it('reports a frozen error as it is', async () => {
    const failure = Object.freeze(new Error('Frozen'))

    Object.assign(globalThis, { outside: async () => Promise.reject(failure) })
    await page('/outside')
    expect(reported).toEqual([failure])
  })

  it('removes the pending block and reports the error with the line of its await block, a rejection that is no error wrapped', async () => {
    const html = await page('/bare')

    expect(swaps(html)).toEqual(['', ''])

    const stacks = reported.map(error => (error as Error).stack)

    expect(reported).toHaveLength(2)
    expect(stacks.every(stack => stack?.includes('bare.kay'))).toBe(true)
    expect(reported.some(error => (error as Error).message === 'Bare')).toBe(true)

    const wrapped = reported.find(error => (error as Error).message !== 'Bare') as Error

    expect(wrapped.message).toContain('text only')
    expect(wrapped.cause).toBe('text only')
  })
})

describe('an await block in a snippet and in a catch block', () => {
  it('takes the try a snippet is declared in', async () => {
    const html = await page('/snippet')

    expect(swaps(html).filter(swapped => swapped === '<p class="failed">Failed</p>')).toHaveLength(2)
    expect(reported).toHaveLength(1)
  })

  it('takes the try around a try whose catch block holds it, and none when no try is left', async () => {
    expect(swaps(await page('/in-catch'))).toEqual(['<p class="outer">Outer</p>'])
    expect(swaps(await page('/in-bare-catch'))).toEqual([''])
  })
})

// The catch each await block is handed, in source order.
function fallbacks(code: string): string[] {
  return [...code.matchAll(/fallback: \(error\) => KayHtml\((KayCatch\d+)\(error\)\)|, (KayCatch\d+)\); \}/g)].map(match => match[1] ?? match[2]!)
}

describe('compiling an await block with no catch', () => {
  it('hands each block the catch of the nearest try above it, an await in a catch block taking the try around that one', () => {
    const source = '---\nconst a = Promise.resolve(1)\n---\ntry\n  try\n    await a then x\n      p {x}\n  catch\n    await a then y\n      p {y}\ncatch\n  p Outer\n'

    for (const output of ['html', 'dom'] as const) {
      const code = compileKay(source, 'nest.kay', { output }).tsx

      // Two tries name their catch apart, the inner await using the inner one and the one in its catch block the outer.
      expect(fallbacks(code)).toEqual(['KayCatch1', 'KayCatch0'])
    }
  })
})

describe('renderToString with an await block with no catch', () => {
  it('renders the catch block of the try around it, and still rejects with none', async () => {
    const guarded = await load<{ value: Promise<string> }>(`${FENCE}try\n  await value then text\n    p {text}\ncatch\n  p Unavailable`)
    const silent = await load<{ value: Promise<string> }>(`${FENCE}try\n  await value then text\n    p {text}\np after`)
    const bare = await load<{ value: Promise<string> }>(`${FENCE}// kay-allow uncaught-await\nawait value then text\n  p {text}`)

    expect(await renderToString(guarded, { value: Promise.reject(new Error('down')) })).toBe('<p>Unavailable</p>')
    expect(await renderToString(silent, { value: Promise.reject(new Error('down')) })).toBe('<p>after</p>')
    await expect(renderToString(bare, { value: Promise.reject(new Error('down')) })).rejects.toThrow('down')
  })

  it('renders the catch block of the try around an await nested in a then block', async () => {
    const view = await load<{ value: Promise<string> }>(`${FENCE}try\n  await Promise.resolve('a') then first\n    p {first}\n    await value then second\n      p {second}\ncatch\n  p Unavailable`)

    expect(await renderToString(view, { value: Promise.reject(new Error('down')) })).toBe('<p>a</p><p>Unavailable</p>')
  })
})
