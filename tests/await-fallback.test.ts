import type { JSX } from '../src/runtime/jsx'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
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
    Bun.write(join(dir, 'routes/bare.kay'), '--- server\nconst slow = (async () => {\n  await Bun.sleep(10)\n  throw new Error(\'Bare\')\n})()\nconst plain = (async () => {\n  await Bun.sleep(10)\n  throw \'text only\'\n})()\n---\n// kay-allow uncaught-await\nawait slow\n  p.pending Loading\nthen text\n  p.text {text}\n// kay-allow uncaught-await\nawait plain then text\n  p.text {text}\n'),
    Bun.write(join(dir, 'routes/shell.kay'), '--- server\nconst slow = Promise.reject(new Error(\'Early\'))\n---\ntry\n  p.sync Shell\n  await slow\n    p.pending Loading\n  then text\n    p.text {text}\ncatch\n  p.failed Failed\n'),
  ])
  app = await pages({ routes: join(dir, 'routes'), prebuilt: false, security: false, onError: error => void reported.push(error) })
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
