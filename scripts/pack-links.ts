import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, posix, relative, sep } from 'node:path'
import process from 'node:process'

// The repo keeps kay and its libraries side by side (`llms/` and `packages/ui/llms/`), where an installed app has `@kaynooo/kayjs/` beside `@kaynooo/kayjs-ui/`.
// `bun scripts/pack-links.ts rewrite [root]` (prepack) points every link between the two at the installed layout, `restore [root]` (postpack) puts the files back, so the repo reads as it does on the forge and the tarball as it does in node_modules.
const BACKUP = join('node_modules', '.cache', 'pack-links')
// A Markdown link target that is a relative path: not a URL, an absolute path or a bare anchor, with an optional title after it.
const LINK = /\]\((?!\w+:|\/|#)([^)\s#]+)(#[^)\s]*)?(\s+(?:"[^"]*"|'[^']*'))?\)/g
// A reference definition, `[x]: path "title"`, on a line of its own.
const DEFINITION = /^( {0,3}\[[^\]]+\]:[ \t]*)(?!\w+:|\/|#)([^\s#]+)(#\S*)?(\s.*)?$/
const FENCE = /^ {0,3}(`{3,}|~{3,})/
const CODE_SPAN = /(`+)[^`]*\1/g
const SCOPE = /^@kaynooo\//
const PACKAGE_FOLDER = /^packages\/[^/]+/

// The folder each package holds in node_modules/@kaynooo, by the folder it lives in: `` for kay, `packages/ui` for kayjs-ui.
async function installedFolders(root: string): Promise<Map<string, string>> {
  const folders = new Map([['', 'kayjs']])

  for (const entry of await readdir(join(root, 'packages'), { withFileTypes: true })) {
    const manifest = join(root, 'packages', entry.name, 'package.json')

    if (entry.isDirectory() && existsSync(manifest))
      folders.set(`packages/${entry.name}`, ((await Bun.file(manifest).json()) as { name: string }).name.replace(SCOPE, ''))
  }

  return folders
}

const packageOf = (path: string) => PACKAGE_FOLDER.exec(path)?.[0] ?? ''

// The package folder a pack of `folder` ships: its own files alone, or every package's when none is named.
function owns(folder: string | undefined, file: string): boolean {
  return folder === undefined || packageOf(file) === folder
}

// `markdown`, the text of the repo file `file`, with each link into another package written as it resolves from node_modules/@kaynooo. Fenced code, code spans and what is not a link are left as written.
export function rewriteLinks(file: string, markdown: string, folders: ReadonlyMap<string, string>): string {
  const own = packageOf(file)
  const retarget = (target: string): string => {
    const destination = posix.normalize(posix.join(posix.dirname(file), target))
    const other = packageOf(destination)

    if (destination.startsWith('../') || other === own || !folders.has(other))
      return target

    const installed = (path: string) => posix.join(folders.get(packageOf(path))!, posix.relative(packageOf(path), path))

    return posix.relative(posix.dirname(installed(file)), installed(destination))
  }
  const inline = (text: string): string => text.replace(LINK, (_whole, target: string, anchor: string | undefined, title: string | undefined) => `](${retarget(target)}${anchor ?? ''}${title ?? ''})`)
  let fence: string | undefined

  return markdown.split('\n').map((line) => {
    const opening = FENCE.exec(line)?.[1]

    if (fence !== undefined) {
      if (opening !== undefined && opening[0] === fence[0] && opening.length >= fence.length && line.trim() === opening)
        fence = undefined

      return line
    }

    if (opening !== undefined) {
      fence = opening

      return line
    }

    const definition = DEFINITION.exec(line)

    if (definition)
      return `${definition[1]}${retarget(definition[2]!)}${definition[3] ?? ''}${definition[4] ?? ''}`

    // The text between code spans only.
    const spans = [...line.matchAll(CODE_SPAN)]
    let result = ''
    let at = 0

    for (const span of spans) {
      result += inline(line.slice(at, span.index)) + span[0]
      at = span.index + span[0].length
    }

    return result + inline(line.slice(at))
  }).join('\n')
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

// Where the files a pack rewrote wait to be put back: a folder of its own per package, so two packs of different packages in one checkout never meet.
function backupOf(root: string, folder: string | undefined): string {
  if (folder === undefined)
    return join(root, BACKUP, '(all)')

  return join(root, BACKUP, folder === '' ? '(kay)' : folder.replaceAll('/', '__'))
}

const OWNER = '.owner'
// Stands for no package folder on the command line of the process that waits for a pack.
const ALL = '*'

// Rewrites the shipped links of the package in `folder` (every package's when it is undefined) and keeps the originals in a backup `restore` puts back. A failure half way puts back what it had rewritten.
// `owner` is the pid of the pack that asked, which `restore` called with it only restores a backup that pack made.
export async function rewrite(root: string, folder?: string, owner?: number): Promise<void> {
  await restore(root, folder)

  const folders = await installedFolders(root)
  const backup = backupOf(root, folder)

  try {
    for (const file of (await shipped(root)).filter(file => owns(folder, file))) {
      const text = await readFile(join(root, file), 'utf8')
      const next = rewriteLinks(file, text, folders)

      if (next === text)
        continue

      await mkdir(dirname(join(backup, 'files', file)), { recursive: true })
      await writeFile(join(backup, 'files', file), text)
      await writeFile(join(root, file), next)
    }

    if (existsSync(backup))
      await writeFile(join(backup, OWNER), String(owner ?? ''))
  }
  catch (error) {
    await restore(root, folder)

    throw error
  }
}

async function ownerOf(backup: string): Promise<string> {
  try {
    return await Bun.file(join(backup, OWNER)).text()
  }
  catch {
    return ''
  }
}

// Puts the files back. With `owner`, only a backup that pack made: another pack's, or none, is left alone.
export async function restore(root: string, folder?: string, owner?: number): Promise<void> {
  const backup = backupOf(root, folder)

  if (!existsSync(backup))
    return

  if (owner !== undefined && await ownerOf(backup) !== String(owner))
    return

  if (existsSync(join(backup, 'files')))
    await cp(join(backup, 'files'), root, { recursive: true, force: true })

  await rm(backup, { recursive: true, force: true })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)

    return true
  }
  catch {
    return false
  }
}

// A pack that fails between prepack and postpack never runs the postpack: this puts the files back once the pack process is gone, whichever way it ended.
export async function restoreAfter(pid: number, root: string, folder?: string): Promise<void> {
  while (alive(pid))
    await Bun.sleep(200)

  await restore(root, folder, pid)
}

const PACKERS = /^(?:bun|npm|pnpm|yarn)$/

// The process of the pack that runs this script: the nearest ancestor that is a package manager asked to pack or publish. Only where /proc tells.
function packOf(pid: number): number | undefined {
  for (let at = pid, depth = 0; at > 1 && depth < 8; depth++) {
    try {
      const [command = '', ...args] = readFileSync(`/proc/${at}/cmdline`, 'utf8').split('\0')
      const name = command.split('/').pop() ?? ''

      if (PACKERS.test(name) && args.some(arg => arg === 'pack' || arg === 'publish'))
        return at

      const stat = readFileSync(`/proc/${at}/stat`, 'utf8')

      // After the command in parentheses come the state and the parent pid.
      at = Number.parseInt(stat.slice(stat.lastIndexOf(')') + 4), 10)
    }
    catch {
      return undefined
    }
  }

  return undefined
}

// The folder the pack is of, from where the script runs: `` for kay at the root, `packages/ui` for a library, none when the script runs elsewhere.
function packageFolder(root: string): string | undefined {
  const folder = relative(root, process.cwd()).split(sep).join('/')

  return folder.startsWith('..') ? undefined : folder
}

if (import.meta.main) {
  const [command, root = process.cwd(), pid] = process.argv.slice(2)
  const base = normalize(root)

  if (command === 'rewrite') {
    const packer = packOf(process.ppid)

    await rewrite(base, packageFolder(base), packer)

    if (packer !== undefined)
      Bun.spawn([process.execPath, import.meta.path, 'restore-after', base, String(packer), packageFolder(base) ?? ALL], { stdio: ['ignore', 'ignore', 'ignore'], detached: true }).unref()
  }
  else if (command === 'restore') {
    await restore(base, packageFolder(base))
  }
  else if (command === 'restore-after') {
    await restoreAfter(Number(pid), base, process.argv[5] === ALL ? undefined : process.argv[5])
  }
  else {
    throw new Error('usage: bun scripts/pack-links.ts rewrite|restore [root]')
  }
}
