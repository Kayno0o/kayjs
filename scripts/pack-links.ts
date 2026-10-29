import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, posix } from 'node:path'
import process from 'node:process'

// The repo keeps kay and its libraries side by side (`llms/` and `packages/ui/llms/`), where an installed app has `@kaynooo/kayjs/` beside `@kaynooo/kayjs-ui/`.
// `bun scripts/pack-links.ts rewrite [root]` (prepack) points every link between the two at the installed layout, `restore [root]` (postpack) puts the files back, so the repo reads as it does on the forge and the tarball as it does in node_modules.
const BACKUP = join('node_modules', '.cache', 'pack-links')
// A Markdown link target that is a relative path: not a URL, an absolute path or a bare anchor.
const LINK = /\]\((?!\w+:|\/|#)([^)\s#]+)(#[^)\s]*)?\)/g

// The folder each package holds in node_modules/@kaynooo, by the folder it lives in: `` for kay, `packages/ui` for kayjs-ui.
async function installedFolders(root: string): Promise<Map<string, string>> {
  const folders = new Map([['', 'kayjs']])

  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    const manifest = join(root, 'packages', entry.name, 'package.json')

    if (entry.isDirectory() && existsSync(manifest))
      folders.set(`packages/${entry.name}`, ((await Bun.file(manifest).json()) as { name: string }).name.replace(/^@kaynooo\//, ''))
  }

  return folders
}

const packageOf = (path: string) => /^packages\/[^/]+/.exec(path)?.[0] ?? ''

// `markdown`, the text of the repo file `file`, with each link into another package written as it resolves from node_modules/@kaynooo.
export function rewriteLinks(file: string, markdown: string, folders: ReadonlyMap<string, string>): string {
  const own = packageOf(file)

  return markdown.replace(LINK, (whole, target: string, anchor: string | undefined) => {
    const destination = posix.normalize(posix.join(posix.dirname(file), target))
    const other = packageOf(destination)

    if (destination.startsWith('../') || other === own || !folders.has(other))
      return whole

    const installed = (path: string) => posix.join(folders.get(packageOf(path))!, posix.relative(packageOf(path), path))

    return `](${posix.relative(posix.dirname(installed(file)), installed(destination))}${anchor ?? ''})`
  })
}

// The Markdown a package ships and links from: its llms.txt and llms/, and a library's README.
async function shipped(root: string): Promise<string[]> {
  const files = ['llms.txt', ...(await readdir(join(root, 'llms'))).map(name => `llms/${name}`)]

  for (const folder of (await installedFolders(root)).keys()) {
    if (folder === '')
      continue

    files.push(`${folder}/README.md`, `${folder}/llms.txt`)

    if (existsSync(join(root, folder, 'llms')))
      files.push(...(await readdir(join(root, folder, 'llms'))).map(name => `${folder}/llms/${name}`))
  }

  return files.filter(file => file.endsWith('.md') || file.endsWith('.txt')).filter(file => existsSync(join(root, file)))
}

export async function rewrite(root: string): Promise<void> {
  await restore(root)

  const folders = await installedFolders(root)

  for (const file of await shipped(root)) {
    const text = await readFile(join(root, file), 'utf8')
    const next = rewriteLinks(file, text, folders)

    if (next === text)
      continue

    await mkdir(dirname(join(root, BACKUP, file)), { recursive: true })
    await writeFile(join(root, BACKUP, file), text)
    await writeFile(join(root, file), next)
  }
}

export async function restore(root: string): Promise<void> {
  const backup = join(root, BACKUP)

  if (!existsSync(backup))
    return

  await cp(backup, root, { recursive: true, force: true })
  await rm(backup, { recursive: true, force: true })
}

if (import.meta.main) {
  const [command, root = process.cwd()] = process.argv.slice(2)

  if (command === 'rewrite')
    await rewrite(normalize(root))
  else if (command === 'restore')
    await restore(normalize(root))
  else
    throw new Error('usage: bun scripts/pack-links.ts rewrite|restore [root]')
}

