import { join } from 'node:path'

const ROOT = join(import.meta.dir, '../../..')
const RAW = 'https://raw.githubusercontent.com/Kayno0o/kayjs/main/'
const DOC_LINK = /\]\((llms\/[\w-]+\.md)/g

// llms.txt for agents, its links made absolute on the forge since the site serves the docs it lists as pages.
export async function GET() {
  return (await Bun.file(join(ROOT, 'llms.txt')).text()).replace(DOC_LINK, (_link, path: string) => `](${RAW}${path}`)
}
