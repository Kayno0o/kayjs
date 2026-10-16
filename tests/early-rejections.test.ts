import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

// `bun test` fails a test on a rejection nothing has taken yet, as a server crashes on one, so the cases run in a process of their own.
const run = Bun.spawn(['bun', join(import.meta.dir, 'fixtures/early/run.ts')], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'production' } })
const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
const result = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { prop: string, property: string, made: string, page: string, logged: string[][], alive: boolean }

describe('an await block given a promise that rejected before it rendered', () => {
  it('survives the rejection of a prop, a property of one awaited twice, and a promise the component made, rendering each catch block', () => {
    expect(stderr).not.toContain('error:')
    expect(result.prop).toBe('<p class="failed">Unavailable</p><p class="now">3</p>')
    expect(result.property).toBe('<p class="failed">Unavailable</p><p class="again">Unavailable again</p>')
    expect(result.made).toBe('<p class="failed">Unavailable</p>')
  })

  it('streams a page whose blocks read a fence value\'s properties, one rejecting only while the stream is open', () => {
    expect(result.page).toContain('<template data-kay-await="4"><p class="failed">Comments are down</p></template>')
    expect(result.page).toContain('<p class="again">Comments are down again</p>')
    expect(result.page).toContain('<p class="now">3</p>')
    expect(result.page).toContain('<p class="plain">x</p>')
    expect(result.page).toContain('<p class="late">Late is down</p>')
  })

  it('logs a rejection nothing took once the grace period passed, and says nothing of one a later handler took', () => {
    expect(result.logged).toEqual([['kay: a promise rejected and nothing took it', 'lost']])
    expect(result.alive).toBe(true)
  })
})
