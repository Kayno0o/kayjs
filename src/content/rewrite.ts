import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { writeAtomically } from '../build/files'
import { loadConfig } from '../config'
import { projectPaths } from '../project'
import { draftCommentLine, entryFiles, parseEntry } from './load'
import { splitFrontmatter } from './markdown'
import { migrateData } from './migrate'
import { namedCollections } from './server'

const LEADING_INDENT = /^[\t ]+(?=")/m
const DRAFT_HEAD_BYTES = 256

// What an entry file holds once its data is `data`, in the format it had: JSON with its indentation, YAML, or Markdown with its frontmatter replaced and every byte of the body kept. A `# draft` mark and the file's line endings stay.
export function rewrittenSource(file: string, source: string, data: unknown): string {
  const crlf = source.includes('\r\n')
  const lines = (text: string) => crlf ? text.replaceAll('\n', '\r\n') : text

  if (file.endsWith('.json'))
    return lines(`${JSON.stringify(data, null, LEADING_INDENT.exec(source)?.[0] ?? 2)}${source.endsWith('\n') ? '\n' : ''}`)

  const mark = draftCommentLine(file, source.slice(0, DRAFT_HEAD_BYTES)) === undefined ? '' : '# draft\n'
  const yaml = lines(`${mark}${Bun.YAML.stringify(data, null, 2).trimEnd()}\n`)

  if (!file.endsWith('.md'))
    return yaml

  const { frontmatter, body } = splitFrontmatter(source)

  // A file with no frontmatter gets one, a blank line before its body.
  return `${lines('---\n')}${yaml}${lines('---\n')}${frontmatter === undefined ? lines('\n') : ''}${body}`
}

export interface RewrittenCollection {
  collection: string
  // Relative to the project root.
  rewritten: string[]
  failed: { file: string, message: string }[]
}

// Rewrites the files of every folder collection that declares `migrations`, in the entries a step carried to the shape the schema accepts; an entry the schema accepts or no step helps is left as it is. With `write` false the files are only listed. A loader's collection writes its entries back through its `save` when it is read.
export async function migrateFolders(root: string, write = true): Promise<{ collections: RewrittenCollection[], declared: number }> {
  const content = (await loadConfig(root)).content
  const collections: RewrittenCollection[] = []
  let declared = 0

  for (const [exported, collection] of await namedCollections(root, content)) {
    const { migrations } = collection.options

    if (collection.dir === undefined || migrations === undefined || migrations.length === 0)
      continue

    const dir = resolve(dirname(projectPaths(root, { content }).content), collection.dir)

    if (!existsSync(dir))
      continue

    declared++

    const result: RewrittenCollection = { collection: exported, rewritten: [], failed: [] }

    for (const name of await entryFiles(dir)) {
      const path = resolve(dir, name)
      const file = relative(root, path)

      try {
        const source = await readFile(path, 'utf8')
        const { data, changed, error } = migrateData(collection.options.schema, migrations, parseEntry(name, source).data)

        if (error !== undefined)
          throw error instanceof Error ? error : new Error(String(error))

        if (!changed)
          continue

        const text = rewrittenSource(name, source, data)

        // A value the format cannot hold, such as a Date in YAML, would damage the file: it is left as it was.
        if (JSON.stringify(parseEntry(name, text).data) !== JSON.stringify(data))
          throw new Error('holds a value its format cannot write back as it is')

        if (write)
          await writeAtomically(path, text)

        result.rewritten.push(file)
      }
      catch (error) {
        result.failed.push({ file, message: error instanceof Error ? error.message : String(error) })
      }
    }

    collections.push(result)
  }

  return { collections, declared }
}
