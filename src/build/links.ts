import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

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
