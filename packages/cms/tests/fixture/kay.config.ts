import type { CollectionInfo, SourceEntry } from '../../src/kay/contract'
import { guard } from 'kay'
import { defineConfig } from 'kay/server'
import { cms } from '../../src/extension'
import { stubContent } from '../../src/kay/content'

// Until kay lists collections (kaynooo/kayjs#262), the fixture gives the screens content of its own.
const COLLECTIONS: CollectionInfo[] = [
  {
    name: 'posts',
    kind: 'folder',
    schema: { type: 'object', properties: { title: { type: 'string' }, draft: { type: 'boolean' } }, required: ['title'] },
    body: { type: 'string' },
    localized: false,
    draftField: 'draft',
  },
  { name: 'pages', kind: 'folder', schema: { type: 'object', properties: { title: { type: 'string' } } }, localized: true },
]
const ENTRIES: Record<string, SourceEntry[]> = {
  posts: [
    { slug: 'hello', url: '/blog/hello', data: { title: 'Hello world', draft: false }, body: '# Hello', draft: false },
    { slug: 'notes/garden', data: { title: 'Spring garden', draft: true }, draft: true },
  ],
  pages: [],
}

stubContent({
  collections: async () => COLLECTIONS,
  entries: async collection => ENTRIES[collection] ?? [],
})

// The fixture lets everyone into the screens.
export default defineConfig({ extensions: [cms({ guard: guard(() => undefined) })] })
