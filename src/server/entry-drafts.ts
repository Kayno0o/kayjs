// Draft entries: a machine's translation of a localized collection's entry waiting for a person, marked in the entry itself.
import type { KayConfig } from '../config'
import type { DataValue, JsonSchema } from '../content/edit'
import { link, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import process from 'node:process'
import { KayError } from '../compiler/errors'
import { collectionInfo, entries, entrySource } from '../content/edit'
import { parseEntry } from '../content/load'
import { namedCollections } from '../content/server'

const DRAFT_COMMENT = '# draft\n'
const FRONTMATTER_OPEN = /^---\r?\n/

// The default locale's entry of a localized collection, read to be translated.
export interface LocalizedEntry {
  data: Record<string, DataValue>
  body: string | undefined
  // The collection's schema as JSON Schema.
  schema: JsonSchema
  // How a translation of it is marked as a draft: the collection's boolean `draft` field set to true, or a `# draft` comment opening the entry's YAML; undefined for a JSON entry of a collection without that field, which holds no comment.
  mark: 'field' | 'comment' | undefined
}

async function localizedCollection(root: string, config: Pick<KayConfig, 'i18n' | 'content'>, collection: string): Promise<string> {
  const { i18n } = config

  if (!i18n)
    throw new KayError('locales-invalid', 'kay: a draft entry is written in a locale, and kay.config.ts sets no i18n')

  const found = (await namedCollections(root, config.content)).find(([name]) => name === collection)

  if (!found)
    throw new KayError('content-api-misuse', `kay: the content config exports no collection ${JSON.stringify(collection)}`)

  if (found[1].options.localized !== true)
    throw new KayError('content-api-misuse', `kay: ${collection} is not a localized collection, so its entries have no translation`)

  return i18n.defaultLocale
}

// The default locale's entry of the collection, as its source holds it, and how a translation of it would be marked.
export async function localizedEntry(root: string, config: Pick<KayConfig, 'i18n' | 'content'>, collection: string, slug: string): Promise<LocalizedEntry> {
  const defaultLocale = await localizedCollection(root, config, collection)
  const [entry] = await entries(collection, { locale: defaultLocale, slug })
  const info = await collectionInfo(collection, { counts: false })

  if (!entry || !info)
    throw new KayError('content-api-misuse', `kay: ${collection} holds no entry ${JSON.stringify(slug)} in ${defaultLocale}`)

  if (entry.data === undefined)
    throw new KayError('content-api-misuse', entry.problem ?? `kay: ${collection}/${slug} in ${defaultLocale} holds no fields`)

  return { data: entry.data, body: entry.body, schema: info.schema, mark: markOf(info.draftField, entry.path) }
}

// How a translation is marked: by the collection's draft field, else by a comment in a file that holds one.
function markOf(draftField: string | undefined, file: string | undefined): LocalizedEntry['mark'] {
  if (draftField !== undefined)
    return 'field'

  return extname(file ?? '.json') === '.json' ? undefined : 'comment'
}

// Writes the translation of an entry into the locale's folder, validated against the collection's schema and marked a draft, as a file that did not exist: an entry the locale already has is never overwritten. Answers the file written, relative to the project root.
export async function writeDraftEntry(root: string, config: Pick<KayConfig, 'i18n' | 'content'>, collection: string, locale: string, slug: string, entry: { data: Record<string, DataValue>, body?: string | undefined }): Promise<string> {
  const defaultLocale = await localizedCollection(root, config, collection)
  const { i18n } = config

  if (!i18n!.locales.includes(locale) || locale === defaultLocale)
    throw new KayError('locales-invalid', `kay: writeDraftEntry was given the locale ${JSON.stringify(locale)}, which is not one of those translated from ${defaultLocale}: ${i18n!.locales.filter(code => code !== defaultLocale).join(', ')}`)

  const info = await collectionInfo(collection, { counts: false })
  const data = info?.draftField === undefined ? entry.data : { ...entry.data, [info.draftField]: true }
  const placed = await entrySource(collection, slug, data, { locale, create: true, ...entry.body !== undefined && { body: entry.body } })

  if ('issues' in placed)
    throw new KayError('content-api-misuse', `kay: ${collection}/${slug} in ${locale} cannot be written: ${placed.issues.map(issue => `${issue.path === '' ? '' : `${issue.path} `}${issue.message}`).join('; ')}`)

  // The translation is written in the format of the entry it translates, which `entrySource` does not know.
  const [source] = await entries(collection, { locale: defaultLocale, slug })
  const from = extname(source?.path ?? placed.file.path)
  const same = from === extname(placed.file.path)

  if (!same && (entry.body !== undefined || (from !== '.yaml' && from !== '.yml')))
    throw new KayError('content-api-misuse', `kay: ${collection}/${slug} is written as ${from} in ${defaultLocale}, a format a translation cannot be created in`)

  const swapped = (file: string) => file.slice(0, file.length - extname(file).length) + from
  const absolute = same ? placed.file.absolute : swapped(placed.file.absolute)
  const path = same ? placed.file.path : swapped(placed.file.path)
  const text = same ? placed.file.text : `${Bun.YAML.stringify(data, null, 2).trimEnd()}\n`
  const marked = info?.draftField === undefined ? withDraftComment(path, text) : text

  if (marked === undefined)
    throw new KayError('content-api-misuse', `kay: ${path} is JSON, which holds no comment to mark a draft with: give ${collection} a boolean field and \`draft: 'field'\``)

  const kept = parseEntry(path, marked)

  if (!Bun.deepEquals(kept.data, data) || kept.body !== parseEntry(path, text).body)
    throw new KayError('content-api-misuse', `kay: ${path} would not read back as written once marked a draft`)

  await createWhole(absolute, marked)

  return path
}

// The entry's text with `# draft` as the first line of its YAML, or nothing for JSON.
function withDraftComment(path: string, text: string): string | undefined {
  if (path.endsWith('.json'))
    return undefined

  if (!path.endsWith('.md'))
    return `${DRAFT_COMMENT}${text}`

  const open = FRONTMATTER_OPEN.exec(text)

  return open ? `${open[0]}${DRAFT_COMMENT}${text.slice(open[0].length)}` : `---\n${DRAFT_COMMENT}---\n${text}`
}

// Creates a file whole or not at all: written aside, then linked into place, which fails when the file exists.
export async function createWhole(file: string, text: string): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  const exists = () => new KayError('content-api-misuse', `kay: ${file} exists already, and a translation never overwrites an entry`)

  await mkdir(dirname(file), { recursive: true })

  try {
    await Bun.write(temporary, text)
    await link(temporary, file)
  }
  catch (error) {
    const { code } = error as NodeJS.ErrnoException

    if (code === 'EEXIST')
      throw exists()

    // A filesystem without hard links creates the file exclusively, at the cost of a window where it is half written.
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV')
      throw error

    try {
      await writeFile(file, text, { flag: 'wx' })
    }
    catch (again) {
      throw (again as NodeJS.ErrnoException).code === 'EEXIST' ? exists() : again
    }
  }
  finally {
    await rm(temporary, { force: true })
  }
}
