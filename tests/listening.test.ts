import { join } from 'node:path'
import { expect, it } from 'bun:test'
import { drainOutput, listeningPort, spawnSuiteServer, stopSuiteServer } from './listening'
import { scratchDir } from './scratch'

const LOGGING = 'const server = Bun.serve({ port: 0, fetch: () => { console.log("x".repeat(1000)); console.error("y".repeat(1000)); return new Response("ok") } }); console.log(`listening ${server.port}`)'
const REQUESTS = 200

it('keeps a server answering after it wrote more than a pipe holds', async () => {
  const child = Bun.spawn([process.execPath, '-e', LOGGING], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

  try {
    const port = await listeningPort(child)

    // 200 requests log 400 KB, over the 64 KB a pipe nobody reads holds.
    for (let request = 0; request < REQUESTS; request++)
      expect(await (await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(10_000) })).text()).toBe('ok')
  }
  finally {
    child.kill()
  }
}, 30_000)

it('drains the pipes of a child whose port line was read by the test itself', async () => {
  const child = Bun.spawn([process.execPath, '-e', LOGGING], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

  try {
    const reader = child.stdout.getReader()
    const { value } = await reader.read()
    const port = (/listening (\d+)/).exec(new TextDecoder().decode(value))![1]

    reader.releaseLock()
    drainOutput(child)

    for (let request = 0; request < REQUESTS; request++)
      expect(await (await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(10_000) })).text()).toBe('ok')
  }
  finally {
    child.kill()
  }
}, 30_000)

it('names a server that exits without listening, with what it printed', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'console.error("boom")'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })

  await expect(listeningPort(child, 'the fixture')).rejects.toThrow('the fixture exited without listening: boom')
})

const SHARED_SERVER_SUITE = `
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { listeningPort, spawnSuiteServer, stopSuiteServer } from ${JSON.stringify(join(import.meta.dir, 'listening'))}

let server: ReturnType<typeof spawnSuiteServer>
let port = ''

beforeAll(async () => {
  server = spawnSuiteServer([process.execPath, '-e', ${JSON.stringify(LOGGING)}])
  port = await listeningPort(server)
})

afterAll(async () => stopSuiteServer(server))

it('times out', async () => {
  await Bun.sleep(2000)
}, 200)

it('still reaches the server', async () => {
  expect(await (await fetch(\`http://localhost:\${port}/\`)).text()).toBe('ok')
})
`

it('keeps the server of a suite alive when one of its tests times out', async () => {
  const file = join(await scratchDir('suite-server-'), 'shared.test.ts')

  await Bun.write(file, SHARED_SERVER_SUITE)

  const run = Bun.spawn([process.execPath, 'test', file], { stdout: 'pipe', stderr: 'pipe' })
  const [output, errors] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited])
  const report = output + errors

  expect(report).toContain('(fail) times out')
  expect(report).toContain(' 1 pass')
  expect(report).toContain(' 1 fail')
}, 30_000)

it('starts a suite server that ignores SIGTERM and goes with stopSuiteServer', async () => {
  const server = spawnSuiteServer([process.execPath, '-e', LOGGING])
  const port = await listeningPort(server)

  server.kill()
  await Bun.sleep(200)
  expect(server.signalCode).toBeNull()
  expect(await (await fetch(`http://localhost:${port}/`)).text()).toBe('ok')
  await stopSuiteServer(server)
  await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow()
})
