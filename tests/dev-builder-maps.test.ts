import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { devBuilder } from '../src/dev/builder'
import { scratchDir } from './scratch'

interface Bundle {
  sources: string[]
  sourcesContent?: (string | null)[]
}

const ISLAND = (label: string) => `---\nconst count = signal(0)\n---\nbutton(onClick={() => count.set(count() + 1)}) ${label} {count()}\n`

// The source text each chunk's map carries for a `.kay` file, by file name; a map no one pointed at `.kay` lines carries none.
async function kayTexts(project: string): Promise<Map<string, string>> {
  const dir = clientDir(project)
  const found = new Map<string, string>()

  for (const file of (await readdir(dir)).filter(name => name.endsWith('.js.map'))) {
    const bundle = await Bun.file(join(dir, file)).json() as Bundle

    for (const [index, source] of bundle.sources.entries()) {
      const text = bundle.sourcesContent?.[index]

      if (source.endsWith('.kay') && text !== undefined && text !== null && text !== '')
        found.set(source.split('/').pop()!, text)
    }
  }

  return found
}

async function pointedAt(project: string, expected: Record<string, string>): Promise<void> {
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    const texts = await kayTexts(project)

    if (Object.entries(expected).every(([file, text]) => texts.get(file) === text))
      return

    await Bun.sleep(25)
  }

  expect(await kayTexts(project)).toEqual(new Map(Object.entries(expected)))
}

async function scratchProject(): Promise<string> {
  const project = await scratchDir('kay-dev-maps-')
  const files = {
    'src/one.kay': ISLAND('one'),
    'src/two.kay': ISLAND('two'),
    'src/routes/index.kay': '---\nimport One from \'../one.kay\'\nimport Two from \'../two.kay\'\n---\nOne\nTwo\n',
  }

  await Promise.all(Object.entries(files).map(async ([file, content]) => Bun.write(join(project, file), content)))

  return project
}

it('points an island chunk\'s map at its .kay source after each rebuild, putting back the ones of chunks an edit left alone', async () => {
  const project = await scratchProject()
  const build = devBuilder(project, { hot: true, sourcemap: true })
  const cwd = process.cwd()

  try {
    process.chdir(project)
    expect((await build(null)).failed).toBe(false)
    await pointedAt(project, { 'one.kay': ISLAND('one'), 'two.kay': ISLAND('two') })

    // One more line before the template moves its lines: the map has to follow.
    const edited = ISLAND('one').replace('---\nbutton', '---\n// moved\nbutton')

    await Bun.write(join(project, 'src/one.kay'), edited)
    expect((await build(['src/one.kay'])).failed).toBe(false)

    // The chunk of the island the edit left alone answers for the finished build at once.
    expect((await kayTexts(project)).get('two.kay')).toBe(ISLAND('two'))
    await pointedAt(project, { 'one.kay': edited, 'two.kay': ISLAND('two') })
  }
  finally {
    process.chdir(cwd)
    await rm(project, { recursive: true, force: true })
  }
})

it('never lets a rewrite of an earlier build land over the maps of the next one', async () => {
  const project = await scratchProject()
  const build = devBuilder(project, { hot: true, sourcemap: true })
  const cwd = process.cwd()

  try {
    process.chdir(project)
    expect((await build(null)).failed).toBe(false)

    // Rebuilt at once, while the first build's maps are still being pointed.
    const edited = ISLAND('one').replace('---\nbutton', '---\n// moved\nbutton')

    await Bun.write(join(project, 'src/one.kay'), edited)
    expect((await build(['src/one.kay'])).failed).toBe(false)
    await pointedAt(project, { 'one.kay': edited, 'two.kay': ISLAND('two') })
    await Bun.sleep(300)
    expect((await kayTexts(project)).get('one.kay')).toBe(edited)
  }
  finally {
    process.chdir(cwd)
    await rm(project, { recursive: true, force: true })
  }
})
