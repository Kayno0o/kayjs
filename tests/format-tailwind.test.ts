import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { formatFiles, formatKay, formatSource } from '../src/format'
import { installed, tailwindSorter } from '../src/format/tailwind'
import { scratchDir } from './scratch'

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })))
})

async function project(files: Record<string, string>): Promise<string> {
  const dir = await scratchDir('format-tailwind-')

  dirs.push(dir)
  await Promise.all(Object.entries({ 'tsconfig.json': '{}', ...files }).map(async ([path, content]) => Bun.write(join(dir, path), content)))

  return dir
}

const alphabetical = (classes: string[]) => classes.toSorted()

describe('kay fmt with a class order', () => {
  it('puts the shorthand classes of an element in the order, around the id and the attributes', () => {
    const format = (source: string) => formatKay(source, { sortClasses: alphabetical }).code

    expect(format('div.b.a x\n')).toBe('div.a.b x\n')
    expect(format('div.c.a#id.b(title="t") x\n')).toBe('div.a.b#id.c(title="t") x\n')
    expect(format('div.a.b x\n')).toBe('div.a.b x\n')
  })

  it('keeps a decimal, a variant and a bracket group whole as the class it is', () => {
    expect(formatKay('div.p-1.5.md:flex.w-[calc(100%-2rem)].gap-0.5 x\n', { sortClasses: alphabetical }).code).toBe('div.gap-0.5.md:flex.p-1.5.w-[calc(100%-2rem)] x\n')
  })

  it('moves the sorted classes into a class attribute when the line is long', () => {
    const classes = Array.from({ length: 24 }, (_, index) => `utility-${String.fromCharCode(122 - index)}`)
    const { code } = formatKay(`div.${classes.join('.')} x\n`, { sortClasses: alphabetical })

    expect(code.startsWith('div(\n  class="\n')).toBe(true)
    expect(code.replaceAll(/\s+/g, ' ')).toContain(classes.toSorted().join(' '))
  })

  it('formats a file unsorted when sorting would join two classes into one', () => {
    const source = 'div.5.w-1 x\n'

    expect(formatKay(source, { sortClasses: classes => classes.toReversed() }).code).toBe(source)
  })

  it('is stable once sorted', () => {
    const once = formatKay('ul.b.a\n  li.z.y x\n', { sortClasses: alphabetical }).code

    expect(formatKay(once, { sortClasses: alphabetical }).code).toBe(once)
  })
})

describe('Tailwind\'s order', () => {
  const entry = '@import \'tailwindcss\';\n'
  const page = 'div.hover:bg-red-500.md:flex.unknown-class.p-4.flex.w-[10px] x\n'

  it('sorts an app applying a kui utility with ui() and no reference', async () => {
    const root = await project({ 'kay.config.ts': 'import { ui } from \'../../../packages/ui/src/extension\'\n\nexport default { extensions: [ui()] }\n', 'src/app.css': `${entry}.card { @apply bg-kui-mantle; }\n`, 'src/routes/index.kay': page })

    expect((await tailwindSorter(root))?.(['p-4', 'flex'])).toEqual(['flex', 'p-4'])
  })

  it('sorts as Tailwind does for an app importing it: unknown classes first as written, then by its index', async () => {
    const root = await project({ 'src/app.css': entry, 'src/routes/index.kay': page })
    const sorter = (await tailwindSorter(root))!

    expect(sorter(['p-4', 'flex', 'unknown-class', 'md:flex', 'hover:bg-red-500', 'w-[10px]'])).toEqual(['unknown-class', 'flex', 'w-[10px]', 'p-4', 'hover:bg-red-500', 'md:flex'])

    await formatFiles([join(root, 'src/routes')], { write: true })
    expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toBe('div.unknown-class.flex.w-[10px].p-4.hover:bg-red-500.md:flex x\n')
  })

  it('takes the entry stylesheet wherever it is, and its @theme', async () => {
    const root = await project({ 'src/styles/site.css': `${entry}@theme { --spacing-gap: 3px; }\n`, 'src/routes/index.kay': 'div.gap-gap.flex x\n' })

    expect((await tailwindSorter(root))!(['gap-gap', 'flex'])).toEqual(['flex', 'gap-gap'])
  })

  it('leaves the classes of an app without Tailwind as written', async () => {
    const root = await project({ 'src/app.css': 'body { margin: 0 }\n', 'src/routes/index.kay': page })

    expect(await tailwindSorter(root)).toBeUndefined()
    await formatFiles([join(root, 'src/routes')], { write: true })
    expect(await Bun.file(join(root, 'src/routes/index.kay')).text()).toBe(page)
  })

  it('leaves them as written when the stylesheet does not load', async () => {
    const root = await project({ 'src/app.css': `${entry}@import './missing-plugin.css';\n@plugin './missing.js';\n`, 'src/routes/index.kay': page })

    expect(await tailwindSorter(root)).toBeUndefined()
  })

  it('sorts again when a stylesheet the entry imports changes', async () => {
    const root = await project({ 'src/app.css': `${entry}@import './theme.css';\n`, 'src/theme.css': '@theme { --color-brand: red; }\n' })

    expect((await tailwindSorter(root))!(['gap-gap', 'flex'])).toEqual(['gap-gap', 'flex'])

    await Bun.write(join(root, 'src/theme.css'), '@theme { --spacing-gap: 3px; }\n')
    await utimes(join(root, 'src/theme.css'), new Date(Date.now() + 5000), new Date(Date.now() + 5000))

    expect((await tailwindSorter(root))!(['gap-gap', 'flex'])).toEqual(['flex', 'gap-gap'])
  })

  it('tries a design system that did not load again, rather than keeping the failure', async () => {
    const root = await project({ 'src/app.css': `${entry}@import './later.css';\n` })

    expect(await tailwindSorter(root)).toBeUndefined()

    await Bun.write(join(root, 'src/later.css'), '@theme { --spacing-gap: 3px; }\n')

    expect((await tailwindSorter(root))!(['gap-gap', 'flex'])).toEqual(['flex', 'gap-gap'])
  })

  it('leaves a stylesheet or plugin package that is not installed unresolved, so nothing is fetched', async () => {
    const root = await project({ 'src/app.css': `${entry}@plugin 'kay-not-installed-plugin';\n` })
    const stylesheet = await project({ 'src/app.css': `${entry}@import '@kay-test/not-installed';\n` })

    expect(await tailwindSorter(root)).toBeUndefined()
    expect(await tailwindSorter(stylesheet)).toBeUndefined()
  })

  it('reaches no network for an app that is not installed: no node_modules above it, no sorting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kay-fmt-tailwind-'))

    dirs.push(root)
    await Bun.write(join(root, 'src/app.css'), entry)

    expect(installed('tailwindcss', root)).toBe(false)
    expect(await tailwindSorter(root)).toBeUndefined()
    expect(installed('tailwindcss', await project({}))).toBe(true)
  })
})

describe('kay fmt --stdin', () => {
  const CLI = join(import.meta.dir, '../src/cli.ts')

  async function run(args: string[], stdin: string, cwd?: string): Promise<{ out: string, err: string, status: number }> {
    const child = Bun.spawn(['bun', CLI, 'fmt', ...args], { cwd: cwd ?? process.cwd(), stdin: new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

    return { out, err, status }
  }

  it('formats a source for the project of the path it is given, a file that does not exist yet too, and leaves every file alone', async () => {
    const root = await project({ 'src/app.css': '@import \'tailwindcss\';\n' })
    const unsorted = 'div.p-4.flex x\n'
    const file = join(root, 'src/routes/new.kay')

    expect((await formatSource(unsorted, file)).code).toBe('div.flex.p-4 x\n')
    expect(await run(['--stdin', file], unsorted)).toEqual({ out: 'div.flex.p-4 x\n', err: '', status: 0 })
    // Without a path, the project is the working directory's.
    expect((await run(['--stdin'], unsorted, root)).out).toBe('div.flex.p-4 x\n')
    expect(await Bun.file(file).exists()).toBe(false)
  })

  it('prints a formatted source as it is, and fails with nothing on stdout when it does not compile', async () => {
    expect(await run(['--stdin', 'a.kay'], 'p hi\n')).toEqual({ out: 'p hi\n', err: '', status: 0 })

    const broken = await run(['--stdin', 'a.kay'], 'else\n  p no\n')

    expect(broken.out).toBe('')
    expect(broken.err).toContain('`else` must directly follow')
    expect(broken.status).toBe(1)
  })

  it('refuses --check, --from-html, --format json and several paths', async () => {
    for (const args of [['--check'], ['--from-html'], ['--format', 'json'], ['a.kay', 'b.kay']]) {
      const { out, status } = await run(['--stdin', ...args], 'p hi\n')

      expect(out).not.toContain('p hi')
      expect(status).toBe(1)
    }
  })
})
