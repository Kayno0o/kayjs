import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Kept apart from the library scan, which brings the compiler's parser: the server resolves extension directories through it.

// The packages the project links into its `node_modules`, by their real directory, read once per project.
const linkedPackages = new Map<string, [string, string][]>()

// A file of a package the project links, such as a library under development, as the project reaches it under `node_modules`, where Bun hands its real path, so its islands are named as an installed copy's; any other file as it is.
export function throughLinks(root: string, file: string): string {
  if (!relative(root, file).startsWith(`..${sep}`))
    return file

  let links = linkedPackages.get(root)

  if (!links)
    linkedPackages.set(root, links = packageLinks(join(root, 'node_modules')))

  const found = links.find(([real]) => file.startsWith(real + sep))

  return found ? join(found[1], relative(found[0], file)) : file
}

function packageLinks(modules: string): [string, string][] {
  const links: [string, string][] = []
  const visit = (dir: string, scoped: boolean) => {
    for (const entry of existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []) {
      const path = join(dir, entry.name)

      // A link whose target is gone, a library since moved, links nothing.
      if (entry.isSymbolicLink() && existsSync(path))
        links.push([realpathSync(path), path])
      else if (!scoped && entry.isDirectory() && entry.name.startsWith('@'))
        visit(path, true)
    }
  }

  visit(modules, false)

  return links
}
