import { existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

// The package's store entry, its id and the file's path in it, under the entry's `node_modules`.
const STORE_FILE = /^(.*[\\/]node_modules[\\/]\.bun[\\/]([^\\/]+))[\\/](node_modules[\\/].+)$/

// Kept apart from the library scan, which brings the compiler's parser: the server resolves extension directories through it.

// The packages the project links into its `node_modules`, then the project itself when its root is a link, by their real directory, read again when a directory that holds the links changed.
const linkedPackages = new Map<string, { links: [string, string][], stamp: string, watched: string[] }>()

// A file of a package the project links, such as a library under development, as the project reaches it under `node_modules`, where Bun hands its real path, so its islands are named as an installed copy's; a file under a linked root as the root names it; any other file as it is.
export function throughLinks(root: string, file: string): string {
  if (!relative(root, file).startsWith(`..${sep}`))
    return file

  let known = linkedPackages.get(root)

  // Linking a package changes the modified time of the directory that holds the link, so a kept process meets one linked since with a stat or two.
  if (!known || known.stamp !== stamp(known.watched))
    linkedPackages.set(root, known = readLinks(root))

  const { links } = known

  // The deepest: a library repository linking itself into an example app holds that app's real root too.
  const found = links.reduce<[string, string] | undefined>((best, link) => file.startsWith(link[0] + sep) && link[0].length > (best?.[0].length ?? -1) ? link : best, undefined)

  return found ? join(found[1], relative(found[0], file)) : file
}

// A file Bun's isolated linker keeps in its store, `node_modules/.bun/<id>/node_modules/<name>/...`, through a link to its store entry kept in `dir`, whose path holds no `.bun`; the file as it is outside the store.
// The path keeps the entry's `node_modules` above the file, where the linker puts the package's own dependencies, so a bare `@import` in it resolves as from the store.
export function outOfStore(dir: string, file: string): string {
  const [, entry, id, rest] = STORE_FILE.exec(file) ?? []

  if (entry === undefined || id === undefined || rest === undefined)
    return file

  // Two stores, a workspace's and the app's own, may hold the same id.
  const link = join(dir, `${id}-${Bun.hash(entry).toString(36)}`)

  if (linksTo(link, entry))
    return join(link, rest)

  const temporary = `${link}.${crypto.randomUUID()}.tmp`

  // A cache that cannot be written leaves the file to Bun's own parser.
  try {
    mkdirSync(dir, { recursive: true })
    symlinkSync(entry, temporary, 'junction')
  }
  catch {
    return file
  }

  // Renamed into place, so two builds linking the same entry never meet a half-made link.
  try {
    renameSync(temporary, link)
  }
  catch {
    rmSync(temporary, { force: true })

    // Another build may have linked it meanwhile.
    if (!linksTo(link, entry))
      return file
  }

  return join(link, rest)
}

// Windows may read a junction back in another form than it was written.
function linksTo(link: string, target: string): boolean {
  try {
    return resolve(readlinkSync(link)) === resolve(target)
  }
  catch {
    return false
  }
}

function readLinks(root: string) {
  const modules = join(root, 'node_modules')
  const watched = [modules]
  const links = [...packageLinks(modules, watched), ...rootLink(root)]

  return { links, stamp: stamp(watched), watched }
}

function stamp(dirs: string[]): string {
  return dirs.map(dir => statSync(dir, { bigint: true, throwIfNoEntry: false })?.mtimeNs ?? '').join()
}

function rootLink(root: string): [string, string][] {
  const real = existsSync(root) ? realpathSync(root) : root

  return real === root ? [] : [[real, root]]
}

function packageLinks(modules: string, watched: string[]): [string, string][] {
  const links: [string, string][] = []
  const visit = (dir: string, scoped: boolean) => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, entry.name)

      // A link whose target is gone, a library since moved, links nothing.
      if (entry.isSymbolicLink() && existsSync(path)) {
        links.push([realpathSync(path), path])
      }
      else if (!scoped && entry.isDirectory() && entry.name.startsWith('@')) {
        watched.push(path)
        visit(path, true)
      }
    }
  }

  visit(modules, false)

  return links
}
