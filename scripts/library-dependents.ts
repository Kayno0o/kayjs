import { Glob } from 'bun'

const LIBRARY = /^packages\/([^/]+)\//
const SOURCE = /^packages\/([^/]+)\/src\//
const FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

type Manifest = { name?: string } & Partial<Record<(typeof FIELDS)[number], Record<string, unknown>>>

// The libraries (folders under packages/) each library names in its manifest, by folder.
export async function libraryDependencies(root: string): Promise<Map<string, Set<string>>> {
  const manifests = new Map<string, Manifest>()
  const folders = new Map<string, string>()

  for (const path of await Array.fromAsync(new Glob('packages/*/package.json').scan({ cwd: root }))) {
    const folder = LIBRARY.exec(path)![1]!
    const manifest = await Bun.file(`${root}/${path}`).json() as Manifest

    manifests.set(folder, manifest)

    if (manifest.name !== undefined)
      folders.set(manifest.name, folder)
  }

  const dependencies = new Map<string, Set<string>>()

  for (const [folder, manifest] of manifests) {
    const used = new Set<string>()

    for (const field of FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        const library = folders.get(name)

        if (library !== undefined && library !== folder)
          used.add(library)
      }
    }

    dependencies.set(folder, used)
  }

  return dependencies
}

// The libraries whose suites a change reaches: the ones it touches, and each depending on one whose src/ changed, as kayjs-ui reaches cms and ai. A change to a library's tests or docs reaches no other, and a dependent's own dependents follow.
export function librariesToTest(changed: string[], dependencies: Map<string, Set<string>>): string[] {
  const reached = new Set(changed.map(path => LIBRARY.exec(path)?.[1]).filter(name => name !== undefined))
  const sources = new Set(changed.map(path => SOURCE.exec(path)?.[1]).filter(name => name !== undefined))
  let grown = true

  while (grown) {
    grown = false

    for (const [library, used] of dependencies) {
      if (!reached.has(library) && [...used].some(name => sources.has(name))) {
        reached.add(library)
        sources.add(library)
        grown = true
      }
    }
  }

  return [...reached]
}
