import type { Prop } from './ui-props'
import { join } from 'node:path'
import { crossLinked } from './reference'
import { propsOf } from './ui-props'

export interface LibraryReference {
  slug: string
  data: { title: string, order: number, version: string, library: string, source: string }
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
const LIBRARIES = ['kayjs-ai', 'kayjs-auth', 'kayjs-cms', 'kayjs-mail', 'kayjs-ui']
const TITLE = /^# (.+)\n+/
// The summary under the title, a quote in llms.txt, is the page's first paragraph.
const INTRO = /^> /
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n+/
const KEBAB = /-(\w)/g
const FIRST = /^\w/
const KAY_FILE = /\.kay$/

// A line of a library's llms.txt listing a topic file, `- [Setup](llms/setup.md): ...`.
const TOPIC = /^- \[[^\]]+\]\(llms\/([\w-]+)\.md\)/gm
// A link to a topic file of the same library, `llms/setup.md#sessions` from the index or `setup.md#sessions` from another topic, made a link to its page under /llms.
const TOPIC_LINK = /\]\((?:llms\/)?([\w-]+)\.md(#[\w-]+)?\)/g

// Each library's llms.txt and the topic files it lists, from its package under packages/ as the workspace links it at the root, listed after kay's own reference: they describe the version kay releases the library at.
export async function loadLibraries(): Promise<LibraryReference[]> {
  const pages = await Promise.all(LIBRARIES.map(async (name, index) => {
    const dir = join(PACKAGES, name)
    const text = await Bun.file(join(dir, 'llms.txt')).text()
    const { version } = await Bun.file(join(dir, 'package.json')).json() as { version: string }
    const linked = (markdown: string) => crossLinked(markdown).replace(TOPIC_LINK, (_link, topic: string, anchor = '') => `](/llms/${name}-${topic}${anchor})`)
    const topics = await Promise.all([...text.matchAll(TOPIC)].map(async ([, topic], position) => {
      const markdown = await Bun.file(join(dir, 'llms', `${topic}.md`)).text()

      return { slug: `${name}-${topic}`, data: { title: TITLE.exec(markdown)?.[1] ?? name, order: 100 + index * 10 + position + 1, version, library: name, source: `llms/${topic}.md` }, body: linked(markdown.replace(TITLE, '')) }
    }))

    return [{ slug: name, data: { title: name, order: 100 + index * 10, version, library: name, source: 'llms.txt' }, body: linked(text.replace(TITLE, '').replace(INTRO, '')) }, ...topics]
  }))

  return pages.flat()
}

// One page per component kayjs-ui ships: its usage from src/content/ui/<slug>.md, and its props read from its source, which `withProps: false` leaves empty for a caller that reads only the usage.
export async function loadComponents({ withProps = true } = {}): Promise<ComponentPage[]> {
  const source = join(PACKAGES, 'kayjs-ui/src')
  const files = [...new Bun.Glob('*.kay').scanSync(source)].sort()
  const props = withProps ? propsOf(files.map(file => join(source, file))) : new Map<string, Prop[]>()

  return Promise.all(files.map(async (file, order) => {
    const slug = file.replace(KAY_FILE, '')
    const title = slug.replace(FIRST, letter => letter.toUpperCase()).replace(KEBAB, (_dash, letter: string) => letter.toUpperCase())
    const usage = Bun.file(join(USAGE, `${slug}.md`))
    const text = await usage.exists() ? await usage.text() : ''
    const { description = '' } = Bun.YAML.parse(FRONTMATTER.exec(text)?.[1] ?? '') as { description?: string } | null ?? {}

    return { slug, data: { title, order, description, props: props.get(join(source, file)) ?? [] }, body: text.replace(FRONTMATTER, '') }
  }))
}
