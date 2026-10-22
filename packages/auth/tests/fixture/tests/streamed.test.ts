import { join } from 'node:path'
import { expect, test } from 'bun:test'

test('with viewer left off, the components stream in after the page, nested ones included, the response is private, and the account header still shows its sign-out', async () => {
  const run = Bun.spawn([process.execPath, join(import.meta.dir, 'streamed.ts')], { env: { ...process.env, FIXTURE_NO_VIEWER: '1' }, stdout: 'pipe', stderr: 'pipe' })

  try {
    const [printed, errors] = [await new Response(run.stdout).text(), await new Response(run.stderr).text()]

    expect(await run.exited).toBe(0)
    expect(errors).not.toContain('Error')
    expect(JSON.parse(printed.split('\n').findLast(line => line.startsWith('{'))!)).toMatchObject({ anonymous: 0, member: 'Member', name: 'streamed@example.com', signOut: ['Sign out'], cache: 'private, no-cache' })
  }
  finally {
    run.kill()
  }
}, 60_000)
