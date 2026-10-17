// `kay i18n translate <locale>`: fills what a locale lacks with a model's translations, saved as drafts for a person to check.
import type { DataValue, JsonSchema, KayCommand, LocalizedEntry } from 'kay/library'
import type { Unit } from './translation'
import process from 'node:process'
import { localizedEntry, missingTranslations, writeDraftEntry, writeDraftMessages } from 'kay/library'
import { estimateTokens, translateUnits } from './translation'

type Path = (string | number)[]

// Texts per request: a model keeps ids and placeholders straight in a short list.
const BATCH_UNITS = 40
const BATCH_CHARS = 8000
// The kinds of field a model translates: no kind is plain text; every other, built in (image, file, reference) or the app's own, holds data a component edits.
const TRANSLATED_KINDS = new Set(['text', 'textarea', 'markdown'])

interface MessageUnit extends Unit {
  key: string
  // The plural form the text is, or nothing for a plain message.
  form?: string
}

interface EntryPlan {
  collection: string
  slug: string
  entry: LocalizedEntry
  paths: Path[]
  units: Unit[]
}

type Message = Parameters<typeof writeDraftMessages>[3][string]

const command: KayCommand = {
  usage: 'i18n translate <locale> [--dry-run]',
  options: { 'dry-run': { type: 'boolean' } },
  positionals: 1,
  run: async ({ values, positionals: [locale] }, refuse, { root, config }) => {
    if (locale === undefined)
      return refuse('i18n translate needs the locale to translate into')

    const { i18n } = config

    if (!i18n) {
      console.error('kay i18n translate: kay.config.ts sets no i18n, so the site has no locale to translate')

      return 1
    }

    if (!i18n.locales.includes(locale) || locale === i18n.defaultLocale) {
      console.error(`kay i18n translate: ${locale} is not one of the locales translated from ${i18n.defaultLocale}: ${i18n.locales.filter(code => code !== i18n.defaultLocale).join(', ')}`)

      return 1
    }

    const stop = new AbortController()
    const interrupt = () => stop.abort()

    process.once('SIGINT', interrupt)

    try {
      return await translateLocale({ root, config, locale, from: i18n.defaultLocale, dryRun: values['dry-run'] === true, signal: stop.signal })
    }
    catch (error) {
      console.error(`kay i18n translate: ${error instanceof Error ? error.message : String(error)}`)

      return 1
    }
    finally {
      process.off('SIGINT', interrupt)
    }
  },
}

export default command

interface Run {
  root: string
  config: Parameters<typeof missingTranslations>[1]
  locale: string
  from: string
  dryRun: boolean
  signal: AbortSignal
}

async function translateLocale({ root, config, locale, from, dryRun, signal }: Run): Promise<number> {
  const missing = (await missingTranslations(root, config))[locale]
  const messages = Object.entries(missing?.messages ?? {})
  const failures: string[] = []
  const plans: EntryPlan[] = []

  for (const [collection, slugs] of Object.entries(missing?.entries ?? {})) {
    for (const slug of slugs) {
      try {
        plans.push(await planEntry(root, config, collection, slug))
      }
      catch (error) {
        failures.push(`${collection}/${slug}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const units = messageUnits(messages)

  if (messages.length === 0 && plans.length === 0 && failures.length === 0) {
    console.log(`${locale} lacks nothing`)

    return 0
  }

  if (dryRun)
    return report(locale, from, messages.map(([key]) => key), plans, units, failures)

  let written = 0
  let writtenEntries = 0

  try {
    for (const batch of batches(units)) {
      const result = await translateUnits(batch, { from, into: locale, signal })
      const ready = completeMessages(messages, batch, result.done)

      for (const [id, why] of result.failed)
        failures.push(`message ${batch.find(unit => unit.id === id)!.key} ${why}`)

      if (Object.keys(ready).length > 0)
        written += (await writeDraftMessages(root, config, locale, ready)).length
    }

    for (const plan of plans)
      writtenEntries += await translateEntry({ root, config, locale, from, signal }, plan, failures)
  }
  catch (error) {
    // What was written stays, each file whole: the summary says how far the run got.
    failures.push(error instanceof Error ? error.message : String(error))
  }

  if (written + writtenEntries > 0)
    console.log(`Translated ${written} ${written === 1 ? 'message' : 'messages'} and ${writtenEntries} ${writtenEntries === 1 ? 'entry' : 'entries'} into ${locale} as drafts: \`kay check\` lists the messages, \`kay i18n accept ${locale}\` accepts them once checked, and an entry is accepted by saving it from a CMS or removing its \`# draft\` line.`)

  for (const failure of failures)
    console.error(`kay i18n translate: ${failure}`)

  if (signal.aborted)
    return 130

  return failures.length === 0 ? 0 : 1
}

// Translates one entry and writes it; answers 1 when written, else 0 with why in `failures`.
async function translateEntry({ root, config, locale, from, signal }: Pick<Run, 'root' | 'config' | 'locale' | 'from' | 'signal'>, plan: EntryPlan, failures: string[]): Promise<number> {
  const result = await translateUnits(plan.units, { from, into: locale, signal })

  if (result.failed.size > 0) {
    failures.push(`${plan.collection}/${plan.slug} ${[...new Set(result.failed.values())].join('; ')}`)

    return 0
  }

  const body = plan.entry.body === undefined ? undefined : result.done.get('body') ?? plan.entry.body

  try {
    await writeDraftEntry(root, config, plan.collection, locale, plan.slug, { data: translatedData(plan, result.done), body })

    return 1
  }
  catch (error) {
    failures.push(`${plan.collection}/${plan.slug}: ${error instanceof Error ? error.message : String(error)}`)

    return 0
  }
}

function report(locale: string, from: string, keys: string[], plans: EntryPlan[], units: MessageUnit[], failures: string[]): number {
  const all = [...units, ...plans.flatMap(plan => plan.units)]
  const tokens = estimateTokens(all, from, locale, batches(units).length + plans.length)

  console.log(`${locale}: would translate ${keys.length} ${keys.length === 1 ? 'message' : 'messages'} and ${plans.length} ${plans.length === 1 ? 'entry' : 'entries'}, about ${tokens.input} tokens in and ${tokens.output} out`)

  if (keys.length > 0)
    console.log(`  messages: ${keys.join(', ')}`)

  const byCollection = Map.groupBy(plans, plan => plan.collection)

  for (const [collection, planned] of byCollection)
    console.log(`  ${collection}: ${planned.map(plan => plan.slug).join(', ')}`)

  for (const failure of failures)
    console.error(`kay i18n translate: ${failure}`)

  return failures.length === 0 ? 0 : 1
}

// The texts of the messages: a plural's forms are one text each, numbered so that no key is ever put in a prompt.
function messageUnits(messages: [string, Message][]): MessageUnit[] {
  const units: MessageUnit[] = []

  for (const [key, message] of messages) {
    for (const [form, text] of typeof message === 'string' ? [[undefined, message] as const] : Object.entries(message))
      units.push({ id: String(units.length + 1), text, kind: 'message', key, ...form !== undefined && { form } })
  }

  return units
}

// The messages whose every text came back checked.
function completeMessages(messages: [string, Message][], batch: MessageUnit[], done: Map<string, string>): Record<string, Message> {
  const ready: Record<string, Message> = {}
  const asked = new Set(batch.map(unit => unit.key))

  for (const [key, source] of messages) {
    if (!asked.has(key))
      continue

    const own = batch.filter(unit => unit.key === key)

    if (!own.every(unit => done.has(unit.id)))
      continue

    ready[key] = typeof source === 'string' ? done.get(own[0]!.id)! : { ...Object.fromEntries(own.map(unit => [unit.form!, done.get(unit.id)!])), other: done.get(own.find(unit => unit.form === 'other')!.id)! }
  }

  return ready
}

// Groups the units so that no request is long: a message's plural forms stay together.
function batches(units: MessageUnit[]): MessageUnit[][] {
  const groups: MessageUnit[][] = []
  let current: MessageUnit[] = []
  let size = 0

  for (const own of Map.groupBy(units, unit => unit.key).values()) {
    const chars = own.reduce((sum, unit) => sum + unit.text.length, 0)

    if (current.length > 0 && (current.length + own.length > BATCH_UNITS || size + chars > BATCH_CHARS)) {
      groups.push(current)
      current = []
      size = 0
    }

    current.push(...own)
    size += chars
  }

  if (current.length > 0)
    groups.push(current)

  return groups
}

async function planEntry(root: string, config: Run['config'], collection: string, slug: string): Promise<EntryPlan> {
  const entry = await localizedEntry(root, config, collection, slug)

  if (entry.mark === undefined)
    throw new Error(`holds JSON, which cannot be marked a draft: give ${collection} a boolean field and \`draft: 'field'\``)

  const paths: Path[] = []

  collectPaths(entry.schema, entry.data, [], paths)

  const units: Unit[] = paths.map((path, index) => ({ id: String(index + 1), text: valueAt(entry.data, path) as string, kind: schemaAt(entry.schema, path)?.['x-kay']?.kind === 'markdown' ? 'markdown' : 'text' }))

  if (entry.body !== undefined && entry.body.trim() !== '')
    units.push({ id: 'body', text: entry.body, kind: 'markdown' })

  return { collection, slug, entry, paths, units }
}

// The schema of a field, a union with null read as its other branch; nothing for a union of several.
function narrowed(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (schema?.anyOf === undefined)
    return schema

  const branches = schema.anyOf.filter(branch => branch.type !== 'null')

  return branches.length === 1 ? narrowed(branches[0]) : undefined
}

function schemaAt(schema: JsonSchema, path: Path): JsonSchema | undefined {
  let node: JsonSchema | undefined = narrowed(schema)

  for (const step of path) {
    node = typeof step === 'number' ? narrowed(Array.isArray(node?.items) ? undefined : node?.items) : narrowed(node?.properties?.[step])
  }

  return node
}

// The paths of the strings worth translating: free text, not an identifier, a date, a choice, a pattern, a file or a field of a kind the app adds.
function collectPaths(schema: JsonSchema | undefined, data: unknown, path: Path, found: Path[]): void {
  const node = narrowed(schema)

  if (node === undefined)
    return

  // A field of a kind the app adds is data its component edits, whatever shape it wraps.
  if (!TRANSLATED_KINDS.has(node['x-kay']?.kind ?? 'text'))
    return

  if (typeof data === 'string') {
    const plain = node.type === 'string' && node.format === undefined && node.enum === undefined && node.const === undefined && node.pattern === undefined

    if (plain && data.trim() !== '')
      found.push(path)

    return
  }

  if (Array.isArray(data)) {
    for (const [index, item] of data.entries())
      collectPaths(Array.isArray(node.items) ? undefined : node.items, item, [...path, index], found)

    return
  }

  if (typeof data === 'object' && data !== null && !(data instanceof Date)) {
    for (const [name, value] of Object.entries(data))
      collectPaths(node.properties?.[name], value, [...path, name], found)
  }
}

function valueAt(data: unknown, path: Path): unknown {
  return path.reduce<unknown>((value, step) => (value as Record<string | number, unknown>)[step], data)
}

// The entry's data with the translated strings put where the source's were.
function translatedData(plan: EntryPlan, done: Map<string, string>): Record<string, DataValue> {
  const data = structuredClone(plan.entry.data)

  for (const [index, path] of plan.paths.entries()) {
    const parent = valueAt(data, path.slice(0, -1)) as Record<string | number, unknown>

    parent[path.at(-1)!] = done.get(String(index + 1))!
  }

  return data
}
