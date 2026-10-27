import type { ErrorName } from '../src/compiler/errors'
import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { ERRORS, explainError } from '../src/compiler/errors'
import { docFiles, excerpt, findLabel, searchDocs } from '../src/docs-search'
import { scratchDir } from './scratch'

const cli = join(import.meta.dir, '../src/cli.ts')
const checkout = join(import.meta.dir, '..')
// A reference section past the length a search prints whole, one item of it naming the word searched.
const longReference = `## Reference\n\n${Array.from({ length: 60 }, (_, index) => `- Item ${index} says something about the widget at length, ${'padding words '.repeat(6)}`).join('\n')}\n- The quokka option turns the widget around.\n\n\`\`\`ts\nquokka()\n\`\`\`\n`
let root: string

beforeAll(async () => {
  root = await scratchDir('docs-command-')
  const library = join(root, 'library')

  await Bun.write(join(library, 'llms.txt'), '# kayjs-fake\n\n> A fake library.\n\n## Topics\n\n- [Widgets](llms/widgets.md): the widget\n- [Gadgets](llms/gadgets.md): the gadget\n')
  await Bun.write(join(library, 'llms/widgets.md'), `# Widgets\n\n## Common tasks\n\n### Spin a widget\n\nA Widget spins.\n\n\`\`\`sh\n# not a heading\n\`\`\`\n\n### Spin a widget\n\nThe same heading twice.\n\n${longReference}`)
  await Bun.write(join(library, 'llms/gadgets.md'), '# Gadgets\n\n## Spin a widget\n\nA gadget spins a widget too.\n\n## Object shapes\n\nAn object of s fields, the object kind.\n\n## Validate a post\n\nThe handler checks the post with `s.Object({ name })` first.\n')
  // A library installed nearer than the checkout's, which wins its name.
  await Bun.write(join(root, 'node_modules/@kaynooo/kayjs-ui/llms.txt'), '# kayjs-ui nearer\n\nThe nearest copy.\n')
  await Bun.write(join(root, 'node_modules/@kaynooo/kayjs-bare/package.json'), '{}')
  await mkdir(join(root, 'node_modules/@kaynooo'), { recursive: true })
  await symlink(library, join(root, 'node_modules/@kaynooo/kayjs-fake'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

async function kay(args: string[], cwd = checkout) {
  const child = Bun.spawn([process.execPath, cli, 'docs', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  return { stdout, stderr, code }
}

describe('the llms files', () => {
  it('reads kay\'s and each installed library\'s, a linked one included, and leaves out a package with no llms.txt', () => {
    const labels = docFiles(root).map(file => file.label)

    expect(labels).toContain('kay/llms.txt')
    expect(labels).toContain('kay/actions.md')
    expect(labels).toContain('kayjs-ai/asking.md')
    expect(labels).toContain('kayjs-fake/widgets.md')
    expect(labels.some(label => label.startsWith('kayjs-bare/'))).toBe(false)
  })

  it('takes a library from the nearest node_modules holding it', () => {
    const ui = docFiles(root).filter(file => file.label.startsWith('kayjs-ui/'))

    expect(ui.map(file => [file.label, file.path])).toEqual([['kayjs-ui/llms.txt', join(root, 'node_modules/@kaynooo/kayjs-ui/llms.txt')]])
  })

  it('splits a file on its headings, none read inside a code fence, a repeated heading numbered as GitHub anchors it', () => {
    const widgets = docFiles(root).find(file => file.label === 'kayjs-fake/widgets.md')!

    expect(widgets.title).toBe('Widgets')
    expect(widgets.sections.map(section => section.label)).toEqual(['kayjs-fake/widgets.md#widgets', 'kayjs-fake/widgets.md#common-tasks', 'kayjs-fake/widgets.md#spin-a-widget', 'kayjs-fake/widgets.md#spin-a-widget-1', 'kayjs-fake/widgets.md#reference'])
    expect(widgets.sections[1]!.children).toEqual(['kayjs-fake/widgets.md#spin-a-widget', 'kayjs-fake/widgets.md#spin-a-widget-1'])
  })

  it('finds a file or a section by its label, `.md`, `@kaynooo/` and the heading\'s case optional', () => {
    const files = docFiles(root)

    expect(findLabel(files, 'kayjs-fake/widgets')?.section).toBeUndefined()
    expect(findLabel(files, '@kaynooo/kayjs-fake/widgets.md#Spin a widget')?.section?.label).toBe('kayjs-fake/widgets.md#spin-a-widget')
    expect(findLabel(files, 'kayjs-fake/widgets#nope')).toBeUndefined()
  })
})

describe('a search', () => {
  it('lands a name on the section documenting it', () => {
    const files = docFiles(checkout)

    expect(searchDocs(files, 'Steps')[0]!.section.label).toStartWith('kayjs-ui/forms-and-steps.md#')
    expect(searchDocs(files, 'FormDialog')[0]!.section.file.label).toBe('kayjs-ui/forms-and-steps.md')
    expect(searchDocs(files, 'ask')[0]!.section.label).toBe('kayjs-ai/asking.md#ask')
  })

  it('finds a dotted name as one word, not by its parts', () => {
    expect(searchDocs(docFiles(root).filter(file => file.label.startsWith('kayjs-fake/')), 's.Object')[0]!.section.label).toBe('kayjs-fake/gadgets.md#validate-a-post')
    expect(searchDocs(docFiles(checkout), 'ctx.fail')[0]!.section.file.label).toBe('kay/actions.md')
  })

  it('finds a heading repeated in two files in both', () => {
    const labels = searchDocs(docFiles(root), 'spin widget').map(match => match.section.label)

    expect(labels).toContain('kayjs-fake/gadgets.md#spin-a-widget')
    expect(labels).toContain('kayjs-fake/widgets.md#spin-a-widget')
  })

  it('prints only the blocks of a long section the words match, saying how many it left out', () => {
    const [match] = searchDocs(docFiles(root), 'quokka')

    expect(match!.section.label).toBe('kayjs-fake/widgets.md#reference')
    expect(excerpt(match!).text).toBe('## Reference\n\n- The quokka option turns the widget around.\n\n```ts\nquokka()\n```')
    expect(excerpt(match!).omitted).toBe(60)
  })

  it('leaves out the release notes and a section that only lists links', () => {
    const files = searchDocs(docFiles(root), 'gadget').map(match => match.section.label)

    expect(files).not.toContain('kayjs-fake/llms.txt#topics')
    expect(searchDocs(docFiles(checkout), 'release minor unreleased').every(match => !match.section.file.label.startsWith('kay/whats-new'))).toBe(true)
  })
})

describe('kay docs', () => {
  it('lists the files, then prints a file\'s headings', async () => {
    const list = await kay([], root)
    const outline = await kay(['kayjs-fake/widgets'], root)

    expect(list.stdout).toContain('kayjs-fake/widgets.md  Widgets\n')
    expect(outline.stdout).toBe('kayjs-fake/widgets.md (node_modules/@kaynooo/kayjs-fake/llms/widgets.md)\nkayjs-fake/widgets.md#widgets  Widgets\n  kayjs-fake/widgets.md#common-tasks  Common tasks\n    kayjs-fake/widgets.md#spin-a-widget  Spin a widget\n    kayjs-fake/widgets.md#spin-a-widget-1  Spin a widget\n  kayjs-fake/widgets.md#reference  Reference\n')
  })

  it('prints the best section with where it is, what is under it and the next matches', async () => {
    const { stdout, code } = await kay(['widget'], root)

    expect(code).toBe(0)
    expect(stdout).toStartWith('kayjs-fake/widgets.md#spin-a-widget (node_modules/@kaynooo/kayjs-fake/llms/widgets.md:5)\n\n### Spin a widget\n\nA Widget spins.')
    expect(stdout).toContain('\nAlso:\n  kayjs-fake/')
  })

  it('prints a section a label names whole, the sections under it included', async () => {
    const { stdout } = await kay(['kayjs-fake/widgets#common-tasks'], root)

    expect(stdout).toContain('## Common tasks\n\n### Spin a widget\n\nA Widget spins.')
    expect(stdout).toContain('The same heading twice.')
    expect(stdout).not.toContain('## Reference')
  })

  it('fails on a label naming a file its package lacks or a package not installed', async () => {
    expect(await kay(['kayjs-fake/nope.md'], root)).toMatchObject({ code: 1, stderr: 'kay docs: `kayjs-fake/nope.md` names no file of `kayjs-fake`; `kay docs` lists them\n' })
    expect(await kay(['kayjs-cms-not-here/setup.md#use'], root)).toMatchObject({ code: 1, stderr: 'kay docs: `kayjs-cms-not-here` is no package installed here with docs; `kay docs` lists the files of those that are\n' })
  })

  it('answers the list, a file\'s headings and a section in JSON, and reads words after `--`', async () => {
    const list = JSON.parse((await kay(['--format', 'json'], root)).stdout) as { files: { label: string, title: string, path: string }[] }
    const outline = JSON.parse((await kay(['kayjs-fake/gadgets', '--format', 'json'], root)).stdout) as { files: { headings: { label: string, level: number }[] }[] }
    const section = JSON.parse((await kay(['--format', 'json', '--', 'kayjs-fake/gadgets#object-shapes'], root)).stdout) as { sections: unknown[], others: unknown[] }

    expect(list.files).toContainEqual({ label: 'kayjs-fake/gadgets.md', title: 'Gadgets', path: 'node_modules/@kaynooo/kayjs-fake/llms/gadgets.md' })
    expect(outline.files[0]!.headings.map(heading => [heading.label, heading.level])).toEqual([['kayjs-fake/gadgets.md#gadgets', 1], ['kayjs-fake/gadgets.md#spin-a-widget', 2], ['kayjs-fake/gadgets.md#object-shapes', 2], ['kayjs-fake/gadgets.md#validate-a-post', 2]])
    expect(section).toEqual({ sections: [{ label: 'kayjs-fake/gadgets.md#object-shapes', path: 'node_modules/@kaynooo/kayjs-fake/llms/gadgets.md', line: 7, heading: 'Object shapes', text: '## Object shapes\n\nAn object of s fields, the object kind.' }], others: [] })
  })

  it('explains a lint, the sections naming it after', async () => {
    const { stdout } = await kay(['missing-alt'])

    expect(stdout).toStartWith('kay explain missing-alt\n\nmissing-alt: deny by default, in a11y')
    expect(stdout).toContain('\nAlso:\n')
  })

  it('explains an error code', async () => {
    const [code] = Object.keys(ERRORS)
    const { stdout } = await kay([code!])

    expect(stdout).toStartWith(`kay explain ${code}\n\n${explainError(code as ErrorName)}`)
  })

  it('answers a search in JSON, and fails on words nothing matches or a heading a file lacks', async () => {
    const found = JSON.parse((await kay(['quokka', '--format', 'json'], root)).stdout) as { sections: { label: string, path: string, line: number, omitted: number }[], others: unknown[] }
    const none = await kay(['zzqqxx'], root)
    const heading = await kay(['kayjs-fake/widgets#nope'], root)

    expect(found.sections).toEqual([expect.objectContaining({ label: 'kayjs-fake/widgets.md#reference', path: 'node_modules/@kaynooo/kayjs-fake/llms/widgets.md', omitted: 60 })])
    expect(none).toMatchObject({ code: 1, stderr: 'kay docs: nothing matches `zzqqxx`; `kay docs` lists the files\n' })
    expect(heading).toMatchObject({ code: 1, stderr: 'kay docs: `kayjs-fake/widgets#nope` names no heading of `kayjs-fake/widgets`; `kay docs kayjs-fake/widgets` lists them\n' })
  })
})
