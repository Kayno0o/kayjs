import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, test } from 'bun:test'
import { scratchDir } from './scratch'

// Runs a test file of its own in a nested `bun test`, as the suite does, and answers how it ended.
async function run(source: string) {
  const dir = await scratchDir('leaks-')
  const file = join(dir, 'case.test.ts')

  await writeFile(file, `import { test } from 'bun:test'\n${source}`)

  const child = Bun.spawn([process.execPath, 'test', file], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])

  return { code: await child.exited, output: out + err }
}

test('a file that leaves a process running fails, naming its command', async () => {
  const { code, output } = await run(`test('leaks', () => { Bun.spawn(['sleep', '4711']) })`)

  expect(code).not.toBe(0)
  expect(output).toContain('this file left 1 process running')
  expect(output).toContain('sleep 4711')
}, 30_000)

test('a detached process, one started with its own env and one nested deeper are found', async () => {
  const { code, output } = await run(`test('leaks', () => {
    Bun.spawn(['sh', '-c', 'setsid sleep 4712 >/dev/null 2>&1 &'])
    Bun.spawn({ cmd: ['sh', '-c', 'setsid sleep 4713 >/dev/null 2>&1 &'], env: { PATH: process.env.PATH } })
    Bun.spawn(['sh', '-c', 'sh -c "setsid sleep 4714 >/dev/null 2>&1 &" & wait'])
  })`)

  expect(code).not.toBe(0)

  for (const seconds of ['4712', '4713', '4714'])
    expect(output).toContain(`sleep ${seconds}`)
}, 30_000)

test('a file whose processes ended, or end as it does, passes', async () => {
  const { code, output } = await run(`test('clean', async () => {
    await Bun.spawn(['true']).exited
    const slow = Bun.spawn(['sh', '-c', 'sleep 0.5'])

    slow.unref()
  })`)

  expect(output).not.toContain('this file left')
  expect(code).toBe(0)
}, 30_000)

test('a process outside the run is left alone', async () => {
  const { code, output } = await run(`test('outside', () => {})`)
  const unrelated = Bun.spawn(['sleep', '5'], { env: { PATH: process.env.PATH ?? '' } })

  try {
    expect(code).toBe(0)
    expect(output).not.toContain('this file left')
    expect(unrelated.killed).toBe(false)
  }
  finally {
    unrelated.kill()
  }
}, 30_000)

test('a spawn with no env does not see a change made to process.env after the run started', async () => {
  const { code, output } = await run(`test('env', async () => {
    process.env.LEAKS_LATE = 'late'

    const child = Bun.spawn(['sh', '-c', 'echo "[$LEAKS_LATE]"'], { stdout: 'pipe' })

    console.log('seen', (await new Response(child.stdout).text()).trim())
  })`)

  expect(code).toBe(0)
  expect(output).toContain('seen []')
}, 30_000)
