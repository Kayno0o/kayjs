import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
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

  it('runs as many libraries side by side as it has jobs', async () => {
    const root = await scratchDir('libraries-')
    const signal = join(root, 'second-started')
    // The first library's test passes only once the second's has started, which a run one library at a time reaches only after the first ended.
    const first = await fakeLibrary(root, 'first', `if (step === 'test') {\n  const until = Date.now() + 15_000\n  while (!await Bun.file(${JSON.stringify(signal)}).exists()) {\n    if (Date.now() > until) process.exit(1)\n    await Bun.sleep(50)\n  }\n}`)
    const second = await fakeLibrary(root, 'second', `if (step === 'test') await Bun.write(${JSON.stringify(signal)}, '')`)

    expect((await run([first, second], { jobs: 2 })).results.map(result => result.passed)).toEqual([true, true])
  })
})
