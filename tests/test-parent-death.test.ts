import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'bun:test'
import { scratchDir } from './scratch'

const listen = join(import.meta.dir, '../src/server/auto-listen')

const ZOMBIE = /^\d+ \(.*\) Z/s

// An orphan that exited stays a zombie where nothing reaps it (pid 1 of a CI container), which `kill(pid, 0)` still finds.
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  }
  catch {
    return false
  }

  try {
    return !ZOMBIE.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  }
  catch {
    return true
  }
}

it('ends a kay server a test process started when that process is killed outright', async () => {
  const dir = await scratchDir('parent-death-')
  // The child registers an app for kay to listen on as an entry does; its parent, which names itself as the test process, is killed with SIGKILL.
  const child = `import { Elysia } from 'elysia'\nimport { listenWhenIdle } from ${JSON.stringify(listen)}\nlistenWhenIdle(new Elysia())\nsetInterval(() => {}, 1000)\n`
  const parent = `const child = Bun.spawn([process.execPath, ${JSON.stringify(join(dir, 'child.ts'))}], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env, KAY_TEST_PARENT: String(process.pid), PORT: '0' } })\nconsole.log(child.pid)\nsetInterval(() => {}, 1000)\n`

  await Bun.write(join(dir, 'child.ts'), child)
  await Bun.write(join(dir, 'parent.ts'), parent)

  const run = Bun.spawn([process.execPath, join(dir, 'parent.ts')], { cwd: process.cwd(), stdout: 'pipe', stderr: 'ignore' })
  const reader = run.stdout.getReader()
  const pid = Number(new TextDecoder().decode((await reader.read()).value).trim())

  expect(alive(pid)).toBe(true)
  run.kill('SIGKILL')
  await run.exited

  for (let wait = 0; wait < 60 && alive(pid); wait++)
    await Bun.sleep(100)

  const gone = !alive(pid)

  if (!gone)
    process.kill(pid, 'SIGKILL')

  expect(gone).toBe(true)
}, 20_000)
