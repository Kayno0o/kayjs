import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Never source at any depth: dependencies, kay's own output and version control.
const ALWAYS_IGNORED = new Set(['node_modules', '.kay', '.git'])
// The output a build leaves at the project root; anywhere deeper `dist` is an ordinary directory, `src/routes/dist` a page directory.
const ROOT_IGNORED = new Set(['dist'])

export const TSCONFIG = 'tsconfig.json'

export const IGNORED_DIRS = new Set([...ALWAYS_IGNORED, ...ROOT_IGNORED])

export interface FindOptions {
  // Whether `root` is a project's, whose build output `dist` is then skipped rather than searched.
  project?: boolean
  // Whether a directory holding its own tsconfig.json, another project, is left out.
  ownOnly?: boolean
}

// Every .kay file under `root`, skipping dependencies and generated output without walking into them.
export async function findKayFiles(root: string, { project = false, ownOnly = false }: FindOptions = {}): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true })

    if (ownOnly && dir !== root && entries.some(entry => entry.isFile() && entry.name === TSCONFIG))
      return

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!ALWAYS_IGNORED.has(entry.name) && !(project && dir === root && ROOT_IGNORED.has(entry.name)))
          await walk(path)
      }
      else if (entry.name.endsWith('.kay')) {
        files.push(path)
      }
    }))
  }

  await walk(root)

  return files.sort()
}

// Leaves an unchanged file alone, so watchers and editors reading it see no change.
export async function writeIfChanged(path: string, content: string) {
  const file = Bun.file(path)

  if (await file.exists() && await file.text() === content)
    return

  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, content)
}
