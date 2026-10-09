import type { Prop } from './ui-props'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { renderMarkdown } from 'kay/content'
import { propsOf } from './ui-props'

export interface LibraryPage {
  slug: string
  data: { title: string, order: number, version: string }
  body: string
}

export interface ComponentPage {
  slug: string
  data: { title: string, order: number, section?: string, anchor?: string, example?: string, props: Prop[] }
  body: string
}

const ROOT = join(import.meta.dir, '../..')
const PACKAGES = join(ROOT, 'node_modules/@kaynooo')
// Each example is a page of its own, which the component's page shows in a frame, so its Tailwind and kayjs-ui's theme stay out of the docs' styles.
const EXAMPLES = join(import.meta.dir, 'routes/(demo)/ui-demo')
const LIBRARIES = ['kayjs-auth', 'kayjs-mail', 'kayjs-ui']
const TITLE = /^# (.+)\n+/
const QUOTED = /^> /gm
const HEADING = /^(#{2,3}) (.+)$/gm
const NAMES = /\s*(?:,|\band\b)\s*/
const KEBAB = /-(\w)/g

// Each library's llms.txt, from the package installed at the root: the version the docs describe is the one published.
export async function loadLibraries(): Promise<LibraryPage[]> {
  return Promise.all(LIBRARIES.map(async (name, order) => {
    const text = await Bun.file(join(PACKAGES, name, 'llms.txt')).text()
    const { version } = await Bun.file(join(PACKAGES, name, 'package.json')).json() as { version: string }

    return { slug: name, data: { title: name, order, version }, body: text.replace(TITLE, '').replace(QUOTED, '') }
  }))
}

interface Section {
  heading: string
  depth: number
  names: string[]
  text: string
}

// The `##` and `###` sections of kayjs-ui's llms.txt, a `###` heading under Components naming the components it covers: `Icon, Button, IconButton`, `Drag and drop: Sortable, Board`.
function sectionsOf(text: string): Section[] {
  const found = [...text.matchAll(HEADING)]

  return found.map((match, index) => {
    const heading = match[2]!
    const end = found[index + 1]?.index ?? text.length

    return { heading, depth: match[1]!.length, names: heading.replace(/^[^:]*:/, '').split(NAMES), text: text.slice(match.index + match[0].length, end).trim() }
  })
}

// One page per component kayjs-ui ships: the part of its docs covering it, its props read from its source, and its example page when there is one.
export async function loadComponents(): Promise<ComponentPage[]> {
  const source = join(PACKAGES, 'kayjs-ui/src')
  const files = [...new Bun.Glob('*.kay').scanSync(source)].sort()
  const props = propsOf(files.map(file => join(source, file)))
  const sections = sectionsOf(await Bun.file(join(PACKAGES, 'kayjs-ui/llms.txt')).text())

  return Promise.all(files.map(async (file, order) => {
    const slug = file.replace(/\.kay$/, '')
    const title = slug.replace(/^\w/, letter => letter.toUpperCase()).replace(KEBAB, (_dash, letter: string) => letter.toUpperCase())
    const section = sections.find(candidate => candidate.depth === 3 && candidate.names.includes(title)) ?? sections.find(candidate => candidate.text.includes(`\`${title}(`) || candidate.text.includes(`${title} `))
    const example = join(EXAMPLES, file)
    const data: ComponentPage['data'] = { title, order, props: props.get(join(source, file)) ?? [] }

    if (section !== undefined) {
      data.section = section.heading
      data.anchor = (await renderMarkdown(`## ${section.heading}`)).headings[0]!.id
    }

    if (existsSync(example))
      data.example = await Bun.file(example).text()

    return { slug, data, body: section?.text ?? '' }
  }))
}
