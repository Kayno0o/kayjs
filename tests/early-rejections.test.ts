import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { fixtureCopy } from './scratch'

// `bun test` fails a test on a rejection nothing has taken yet, as a server crashes on one, so the cases run in processes of their own.
async function spawn(script: string) {
  const run = Bun.spawn(['bun', join(import.meta.dir, 'fixtures/early', script)], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

  return { stdout, stderr, code }
}

const cases = await spawn('run.ts')
const result = JSON.parse(cases.stdout.trim().split('\n').pop() ?? '{}') as { prop: string, property: string, island: string, made: string, page: string, logged: string[][] }

describe('an await block given a promise that rejected before it rendered', () => {
  it('survives the rejection of a prop, a property of one awaited twice, and a promise the component made, rendering each catch block', () => {
    expect(cases.code).toBe(0)
    expect(cases.stderr).not.toContain('kay: a promise rejected and nothing took it')
    expect(result.prop).toBe('<p class="failed">Unavailable</p><p class="now">3</p>')
    expect(result.property).toBe('<p class="failed">Unavailable</p><p class="again">Unavailable again</p>')
    expect(result.made).toBe('<p class="failed">Unavailable</p>')
  })

  it('renders the pending block of an island whose promise rejected early, and crashes nothing', () => {
    expect(result.island).toContain('<p class="waiting">Loading</p>')
    expect(result.island).not.toContain('failed')
  })

  it('streams a page whose blocks read a fence value\'s properties, one rejecting only while the stream is open, and takes the promise of a block inside a streamed one', () => {
    expect(result.page).toContain('<template data-kay-await="4"><p class="failed">Comments are down</p></template>')
    expect(result.page).toContain('<p class="again">Comments are down again</p>')
    expect(result.page).toContain('<p class="now">3</p>')
    expect(result.page).toContain('<p class="plain">x</p>')
    expect(result.page).toContain('<p class="inner">Waiting</p>')
    expect(result.page).toContain('<p class="late">Late is down</p>')
  })

  it('logs a rejection nothing took once the grace period passed, and says nothing of one a later handler took', () => {
    expect(result.logged).toEqual([['kay: a promise rejected and nothing took it', 'lost']])
  })

  it('logs what it still holds when the process ends, and exits with code 1 as an unhandled rejection would', async () => {
    const ended = await spawn('exit.ts')

    expect(ended.stderr).toContain('kay: a promise rejected and nothing took it')
    expect(ended.stderr).toContain('forgotten')
    expect(ended.code).toBe(1)
  })
})

const CLI = join(import.meta.dir, '../src/cli.ts')

async function kay(...args: string[]) {
  const run = Bun.spawn([process.execPath, CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

  return { stdout, stderr, code }
}

describe('a page whose await block meets a promise that rejected early', () => {
  it('builds a prerendered page with its catch block', async () => {
    const dir = await fixtureCopy('early-build')
    const built = await kay('build', dir, '--no-check')

    expect(built.code).toBe(0)
    expect(built.stderr).not.toContain('kay: a promise rejected and nothing took it')
    expect(await Bun.file(join(dir, '.kay/client/pages/prerendered.html')).text()).toContain('<p class="failed">Prerendered comments are down</p>')
  })

  it('serves a page reading a cached value holding one with its catch block', async () => {
    const rendered = await kay('render', '/cached', await fixtureCopy('early-build'))

    expect(rendered.code).toBe(0)
    expect(rendered.stderr).not.toContain('kay: a promise rejected and nothing took it')
    expect(rendered.stdout).toContain('<p class="failed">Cached comments are down</p>')
  })
})
