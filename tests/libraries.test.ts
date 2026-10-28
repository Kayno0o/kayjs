import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { libraryFolders, runLibraries } from '../scripts/libraries'
import { scratchDir } from './scratch'

// A library whose `check` and `test` run `run.ts` with the script's name, `run.ts` being the given body.
async function fakeLibrary(root: string, name: string, body: string) {
  const folder = join(root, 'packages', name)

  await Bun.write(join(folder, 'package.json'), JSON.stringify({ name, scripts: { check: '$npm_execpath run.ts check', test: '$npm_execpath run.ts test' } }))
  await Bun.write(join(folder, 'run.ts'), `const step = process.argv[2]\n${body}\n`)

  return folder
}

async function run(folders: string[], options: Parameters<typeof runLibraries>[1] = {}) {
  const written: string[] = []
  const results = await runLibraries(folders, { ...options, write: text => written.push(text) })

  return { results, written }
}

describe('scripts/libraries.ts', () => {
  it('orders the slowest libraries first, then by name, leaving out a folder with no manifest', async () => {
    const root = await scratchDir('libraries-')

    for (const name of ['mail', 'ui', 'ai', 'cms'])
      await fakeLibrary(root, name, '')

    await mkdir(join(root, 'packages', 'notes'), { recursive: true })

    expect((await libraryFolders(root)).map(folder => folder.slice(root.length + '/packages/'.length))).toEqual(['cms', 'ui', 'ai', 'mail'])
  })

  it('prints each library\'s check and test output whole, a failed one\'s after the libraries that passed', async () => {
    const root = await scratchDir('libraries-')
    const failing = await fakeLibrary(root, 'failing', 'console.log(`${step} out`)\nconsole.error(`${step} err`)\nif (step === \'test\') process.exit(1)')
    const passing = await fakeLibrary(root, 'passing', 'console.log(`${step} ok`)')
    const { results, written } = await run([failing, passing], { jobs: 2 })

    expect(results).toEqual([{ folder: failing, passed: false }, { folder: passing, passed: true }])
    expect(written).toHaveLength(2)
    expect(written[0]).toMatch(/passing\/\n.*check ok\n.*test ok\n.*passing: passed in \d+ s\n$/s)
    expect(written[1]).toMatch(/failing\/\n.*check out\ncheck err\n.*test out\ntest err\n.*failing: test failed after \d+ s\n$/s)
  })

  it('answers once every output was written, one write at a time', async () => {
    const root = await scratchDir('libraries-')
    const folders = await Promise.all(['first', 'second', 'third'].map(async name => fakeLibrary(root, name, '')))
    const events: string[] = []
    // A pipe that takes its time, as CI's did when the script exited with the libraries' output still unwritten.
    const results = await runLibraries(folders, { jobs: 3, write: async () => {
      events.push('start')
      await Bun.sleep(200)
      events.push('end')
    } })

    expect(results.map(result => result.passed)).toEqual([true, true, true])
    expect(events).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
  })

  it('skips the test of a library whose check failed', async () => {
    const root = await scratchDir('libraries-')
    const folder = await fakeLibrary(root, 'unchecked', 'console.log(`${step} ran`)\nif (step === \'check\') process.exit(2)')
    const { results, written } = await run([folder])

    expect(results).toEqual([{ folder, passed: false }])
    expect(written[0]).toContain('check ran')
    expect(written[0]).not.toContain('test ran')
    expect(written[0]).toMatch(/unchecked: check failed after \d+ s\n$/)
  })

  it('interrupts a test running past its limit, keeping what it printed', async () => {
    const root = await scratchDir('libraries-')
    const folder = await fakeLibrary(root, 'stuck', 'if (step === \'test\') {\n  process.on(\'SIGINT\', () => {\n    console.log(\'interrupted\')\n    process.exit(130)\n  })\n  console.log(\'started\')\n  setInterval(() => {}, 1000)\n}')
    const { results, written } = await run([folder], { limitMs: 6000, graceMs: 2000 })

    expect(results).toEqual([{ folder, passed: false }])
    expect(written[0]).toContain('started')
    expect(written[0]).toMatch(/stuck: test interrupted after 6 s\n$/)
  })

  it('interrupts a check running past its limit, leaving its test unstarted', async () => {
    const root = await scratchDir('libraries-')
    const folder = await fakeLibrary(root, 'unchecked', 'console.log(`${step} started`)\nif (step === \'check\') {\n  process.on(\'SIGINT\', () => process.exit(130))\n  setInterval(() => {}, 1000)\n}')
    const { results, written } = await run([folder], { limitMs: 4000, graceMs: 2000 })

    expect(results).toEqual([{ folder, passed: false }])
    expect(written[0]).toContain('check started')
    expect(written[0]).not.toContain('test started')
    expect(written[0]).toMatch(/unchecked: check interrupted after 4 s\n$/)
  })

  it('holds a library\'s check and test to one limit together', async () => {
    const root = await scratchDir('libraries-')
    const folder = await fakeLibrary(root, 'slow', 'if (step === \'check\')\n  await Bun.sleep(3000)\nelse {\n  process.on(\'SIGINT\', () => process.exit(130))\n  setInterval(() => {}, 1000)\n}')
    const started = performance.now()
    const { results, written } = await run([folder], { limitMs: 5000, graceMs: 2000 })

    // A test given the whole limit again would end past 8 s.
    expect(performance.now() - started).toBeLessThan(7000)
    expect(results).toEqual([{ folder, passed: false }])
    expect(written[0]).toMatch(/slow: test interrupted after 5 s\n$/)
  })

  it('fails alone a library whose log cannot be opened', async () => {
    const root = await scratchDir('libraries-')
    const tmp = join(root, 'tmp')
    // The first library's check puts a folder where the second's log goes, under the temporary folder this test points TMPDIR at.
    const blocker = await fakeLibrary(root, 'blocker', `import { mkdirSync, readdirSync } from 'node:fs'\nimport { join } from 'node:path'\nif (step === 'check') {\n  const logs = readdirSync(${JSON.stringify(tmp)}).find(name => name.startsWith('kay-libraries-'))!\n  mkdirSync(join(${JSON.stringify(tmp)}, logs, '1.log'))\n}`)
    const unopened = await fakeLibrary(root, 'unopened', '')
    const after = await fakeLibrary(root, 'after', '')
    const previous = process.env.TMPDIR

    await mkdir(tmp)
    process.env.TMPDIR = tmp

    try {
      const { results, written } = await run([blocker, unopened, after], { jobs: 1 })

      expect(results).toEqual([{ folder: blocker, passed: true }, { folder: unopened, passed: false }, { folder: after, passed: true }])
      expect(written[2]).toMatch(/unopened\/\n\S*unopened: could not run: EISDIR/)
    }
    finally {
      if (previous === undefined)
        delete process.env.TMPDIR
      else
        process.env.TMPDIR = previous
    }
  })

  it('fails alone a library it cannot start', async () => {
    const root = await scratchDir('libraries-')
    const missing = join(root, 'packages', 'missing')
    const present = await fakeLibrary(root, 'present', '')
    const { results, written } = await run([missing, present])

    expect(results).toEqual([{ folder: missing, passed: false }, { folder: present, passed: true }])
    expect(written[1]).toMatch(/missing: could not run: ENOENT/)
  })

  it('runs as many libraries side by side as it has jobs', async () => {
    const root = await scratchDir('libraries-')
    const signal = join(root, 'second-started')
    // The first library's test passes only once the second's has started, which a run one library at a time reaches only after the first ended.
    const first = await fakeLibrary(root, 'first', `if (step === 'test') {\n  const until = Date.now() + 15_000\n  while (!await Bun.file(${JSON.stringify(signal)}).exists()) {\n    if (Date.now() > until) process.exit(1)\n    await Bun.sleep(50)\n  }\n}`)
    const second = await fakeLibrary(root, 'second', `if (step === 'test') await Bun.write(${JSON.stringify(signal)}, '')`)

    expect((await run([first, second], { jobs: 2 })).results.map(result => result.passed)).toEqual([true, true])
  })
})
