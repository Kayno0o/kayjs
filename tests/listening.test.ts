import { expect, it } from 'bun:test'
import { drainOutput, listeningPort } from './listening'

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
