import { mkdir, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const IGNORED_DIRS = new Set(['node_modules', '.kay', '.git', 'dist'])

// Every .kay file under `root`, skipping dependencies and generated output without walking into them.
export async function findKayFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true })

    await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name))
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
