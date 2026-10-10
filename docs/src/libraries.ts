import type { Prop } from './ui-props'
import { join } from 'node:path'
import { propsOf } from './ui-props'

export interface LibraryReference {
  slug: string
  data: { title: string, order: number, version: string }
  body: string
}

export interface ComponentPage {
  slug: string
  data: { title: string, order: number, description: string, props: Prop[] }
  body: string
}

const ROOT = join(import.meta.dir, '../..')
const PACKAGES = join(ROOT, 'node_modules/@kaynooo')
const USAGE = join(import.meta.dir, 'content/ui')
const LIBRARIES = ['kayjs-auth', 'kayjs-mail', 'kayjs-ui']
const TITLE = /^# (.+)\n+/
// The summary under the title, a quote in llms.txt, is the page's first paragraph.
const INTRO = /^> /
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n+/
const KEBAB = /-(\w)/g
const FIRST = /^\w/
const KAY_FILE = /\.kay$/

// Each library's llms.txt, from the package installed at the root, listed after kay's own reference: the version it describes is the one published.
export async function loadLibraries(): Promise<LibraryReference[]> {
  return Promise.all(LIBRARIES.map(async (name, order) => {
    const text = await Bun.file(join(PACKAGES, name, 'llms.txt')).text()
    const { version } = await Bun.file(join(PACKAGES, name, 'package.json')).json() as { version: string }

    return { slug: name, data: { title: name, order: 100 + order, version }, body: text.replace(TITLE, '').replace(INTRO, '') }
  }))
}

// One page per component kayjs-ui ships: its usage from src/content/ui/<slug>.md, and its props read from its source.
export async function loadComponents(): Promise<ComponentPage[]> {
  const source = join(PACKAGES, 'kayjs-ui/src')
  const files = [...new Bun.Glob('*.kay').scanSync(source)].sort()
  const props = propsOf(files.map(file => join(source, file)))

  return Promise.all(files.map(async (file, order) => {
    const slug = file.replace(KAY_FILE, '')
    const title = slug.replace(FIRST, letter => letter.toUpperCase()).replace(KEBAB, (_dash, letter: string) => letter.toUpperCase())
    const usage = Bun.file(join(USAGE, `${slug}.md`))
    const text = await usage.exists() ? await usage.text() : ''
    const { description = '' } = Bun.YAML.parse(FRONTMATTER.exec(text)?.[1] ?? '') as { description?: string } | null ?? {}

    return { slug, data: { title, order, description, props: props.get(join(source, file)) ?? [] }, body: text.replace(FRONTMATTER, '') }
  }))
}
