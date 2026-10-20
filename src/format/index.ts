import type { Diagnostic } from '../compiler'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { findKayFiles } from '../build/files'
import { formatKay } from '../compiler/format'
import { projectRootOf } from '../project'
import { tailwindSorter } from './tailwind'

export { formatKay } from '../compiler/format'

export interface FormatFilesResult {
  // Files whose formatting differs: rewritten, or only listed when `write` is false.
  changed: string[]
  errors: { file: string, source: string, diagnostics: Diagnostic[] }[]
}

async function statIfExists(path: string) {
  try {
    return await stat(path)
  }
  catch {
    return undefined
  }
}

// Formats the .kay files at `paths`, each a .kay file or a directory searched recursively; throws before writing anything when one is neither.
export async function formatFiles(paths: string[], options: { write: boolean }): Promise<FormatFilesResult> {
  const files = (await Promise.all(paths.map(async (path) => {
    const info = await statIfExists(path)

    if (!info)
      throw new Error(`${path} does not exist`)

    if (info.isDirectory())
      return findKayFiles(resolve(path), { project: existsSync(join(path, 'package.json')) })

    if (!path.endsWith('.kay'))
      throw new Error(`${path} is not a .kay file`)

    return [resolve(path)]
  }))).flat()
  const result: FormatFilesResult = { changed: [], errors: [] }

  const sorters = new Map<string, ReturnType<typeof tailwindSorter>>()

  // Overlapping paths, such as `src src/page.kay`, name a file once.
  await Promise.all([...new Set(files)].map(async (file) => {
    const source = await Bun.file(file).text()
    const root = projectRootOf(file)
    const sorter = sorters.get(root) ?? tailwindSorter(root)

    sorters.set(root, sorter)

    const { code, diagnostics } = formatKay(source, { sortClasses: await sorter })

    if (diagnostics.length > 0)
      result.errors.push({ file, source, diagnostics })
    else if (code !== source)
      result.changed.push(file)

    if (options.write && code !== source)
      await Bun.write(file, code)
  }))

  result.changed.sort()
  result.errors.sort((a, b) => a.file.localeCompare(b.file))

  return result
}
