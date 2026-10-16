import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

// `bun test` fails a test on a rejection nothing has taken yet, as a server crashes on one, so the cases run in processes of their own.
async function spawn(script: string) {
  const run = Bun.spawn(['bun', join(import.meta.dir, 'fixtures/early', script)], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
  const [stdout, stderr, code] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])

  return { stdout, stderr, code }
}

const cases = await spawn('run.ts')
const result = JSON.parse(cases.stdout.trim().split('\n').pop() ?? '{}') as { prop: string, property: string, made: string, page: string, logged: string[][] }

describe('an await block given a promise that rejected before it rendered', () => {
  it('survives the rejection of a prop, a property of one awaited twice, and a promise the component made, rendering each catch block', () => {
    expect(cases.code).toBe(0)
    expect(cases.stderr).not.toContain('kay:')
    expect(result.prop).toBe('<p class="failed">Unavailable</p><p class="now">3</p>')
    expect(result.property).toBe('<p class="failed">Unavailable</p><p class="again">Unavailable again</p>')
    expect(result.made).toBe('<p class="failed">Unavailable</p>')
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
