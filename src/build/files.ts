import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const IGNORED_DIRS = new Set(['node_modules', '.kay', '.git', 'dist'])

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
