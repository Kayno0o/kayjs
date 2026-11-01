import { resolve } from 'node:path'
import { expect, it } from 'bun:test'
import { logSink, setLogSink } from '../src/runtime/log'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const root = resolve(await fixtureCopy('bare'))

async function warningsOf(theme: string, page: string): Promise<string[]> {
  await Bun.write(`${root}/src/app.css`, `@import "tailwindcss" source("..");\n${theme}\n`)
  await Bun.write(`${root}/package.json`, JSON.stringify({ name: 'app', devDependencies: { 'bun-plugin-tailwind': '*' } }))
  await Bun.write(`${root}/src/routes/_layout.kay`, '---\nimport \'../app.css\'\n---\nslot\n')
  await Bun.write(`${root}/src/routes/index.kay`, page)

  const warned: string[] = []
  const previous = logSink()

  setLogSink((level, message) => void (level === 'warn' && warned.push(message)))

  try {
    const site = await testSite({ root, styles: true, islands: false })

    await site.close()
  }
  finally {
    if (previous)
      setLogSink(previous)
    else
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('kay.log')]
  }

  return warned.filter(message => message.includes('theme variable'))
}

const LANES = '@theme {\n  --color-lane-0: #111111;\n  --color-lane-1: #222222;\n}'
const BUILT = 'svg\n  circle(style={`stroke: var(--color-lane-${1})`})\n'

it('warns for a theme variable read through a built name that no utility uses', async () => {
  const [message, ...rest] = await warningsOf(LANES, BUILT)

  expect(rest).toEqual([])
  expect(message).toContain('src/routes/index.kay:2')
  expect(message).toContain('--color-lane-')
  expect(message).toContain('@theme static')
}, 60_000)

it('is silent with @theme static', async () => {
  expect(await warningsOf(LANES.replace('@theme', '@theme static'), BUILT)).toEqual([])
}, 60_000)

it('is silent when a utility uses one of the variables', async () => {
  expect(await warningsOf(LANES, `${BUILT}p.text-lane-0 Hi\n`)).toEqual([])
}, 60_000)

it('is silent when the variables sit in :root', async () => {
  expect(await warningsOf(':root {\n  --color-lane-0: #111111;\n}', BUILT)).toEqual([])
}, 60_000)
