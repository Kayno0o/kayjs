import type { ComponentInterface } from './component-props'
import type { Document, LspHost, Project } from './host'
import type { CompletionItem, CompletionList, TextDocumentPositionParams } from './protocol'
import type { TemplateData, Wanted } from './template-completion'
import type { UiData } from './ui-completion'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realPath, resolveFrom } from '../build/files'
import { styleInfo, styleInfos, themeTokens } from '../build/ui-info'
import { messageKeys } from '../check/messages'
import { servedPathsOf } from '../check/shadow-types'
import { HTML_ELEMENTS, LINTS } from '../compiler/lints'
import { GENERATED_NAME } from '../compiler/names'
import { parseKay } from '../compiler/parser'
import { analyzeScript } from '../compiler/script'
import { projectRootOf } from '../project'
import { toShadow } from './bridge'
import { componentInterface } from './component-props'
import { remembered } from './host'
import { mapCompletionItem, mapInsertReplace, toSourceRange } from './mapping'
import { toOffset, toPosition } from './positions'
import { templateContext, templateItems } from './template-completion'
import { typedLength, uiFileCursor, uiItems } from './ui-completion'

const CAPITALIZED = /^[A-Z]/
const WORD_AFTER = /^[\w-]*/
const PLAIN_FORMAT = 1
const SNIPPET_FORMAT = 2
const OPTIONAL_MARK = /\?$/
const KIND_FIELD = 5
const KIND_PROPERTY = 10

export async function completion(host: LspHost, params: TextDocumentPositionParams & { context?: unknown }): Promise<CompletionList | null> {
  const ui = host.uiFiles.get(params.textDocument.uri)

  if (ui !== undefined)
    return uiFileCompletion(host, ui, params)

  const own = await templateCompletion(host, params)

  if (own)
    return own

  const target = toShadow(host, params)

  if (!target)
    return null

  const result = await host.server.request<CompletionList | CompletionItem[] | null>('textDocument/completion', { ...target.params, context: params.context })

  if (!result)
    return null

  const list = Array.isArray(result) ? { isIncomplete: false, items: result } : result
  const editRange = list.itemDefaults?.editRange
  const itemDefaults = list.itemDefaults && { ...list.itemDefaults, editRange: editRange && ('start' in editRange ? toSourceRange(target.document, editRange) : mapInsertReplace(target.document, editRange)) }

  return {
    ...list,
    itemDefaults,
    items: list.items.filter(item => !GENERATED_NAME.test(item.label)).map(item => ({ ...mapCompletionItem(target.document, item, target.offset), data: { uri: target.document.uri, offset: target.offset, data: item.data } })),
  }
}

// Kay's own completions, where TypeScript sees no code: element, attribute and block names, route paths, message keys and lint names.
export async function templateCompletion(host: LspHost, { textDocument, position }: TextDocumentPositionParams): Promise<CompletionList | undefined> {
  const document = host.documents.get(textDocument.uri)

  if (!document)
    return undefined

  const context = templateContext(document.source, toOffset(document.source, position), parseKay(document.source).templateStart)

  if (!context)
    return undefined

  const range = { start: toPosition(document.source, context.replace.start), end: toPosition(document.source, context.replace.end) }
  const items = templateItems(context.wanted, await templateData(host, document, context.wanted), (label, text, snippet) => ({ textEdit: { range, newText: text }, filterText: label, insertTextFormat: snippet ? SNIPPET_FORMAT : PLAIN_FORMAT }))

  // A class object with nothing to offer stays empty rather than fall to TypeScript, which would list every global there.
  return items.length > 0 || context.wanted.kind === 'ui' ? { isIncomplete: false, items } : undefined
}

// The parts, variants and tokens src/ui.ts and a `class={{ }}` complete from, read from the component files and the theme.
export async function uiData(project: Project, document?: Document, tag?: string): Promise<UiData> {
  const tokens = themeTokens(project.root)

  if (document === undefined || tag === undefined)
    return { components: await styleInfos(project.root, project.libraries), tokens }

  const parsed = parseKay(document.source)
  const { imports } = analyzeScript(document.source, parsed.script, [], [], parsed.module)
  const binding = imports.find(candidate => candidate.local === tag && !candidate.typeOnly)
  const file = binding && resolveFrom(binding.source, document.file)
  const info = file === undefined ? undefined : styleInfo(realPath(file))

  return { components: info === undefined ? [] : [{ ...info, name: tag }], tokens }
}

export async function uiFileCompletion(host: LspHost, source: string, { textDocument, position }: TextDocumentPositionParams): Promise<CompletionList | null> {
  const offset = toOffset(source, position)
  const cursor = uiFileCursor(source, offset)

  if (cursor === undefined)
    return null

  const length = typedLength(cursor)
  const range = { start: toPosition(source, offset - length), end: toPosition(source, offset + WORD_AFTER.exec(source.slice(offset))![0].length) }
  const project = host.projectAt(projectRootOf(fileURLToPath(textDocument.uri), host.root))
  const items = uiItems(cursor, undefined, await uiData(project)).map(item => ({ ...item, textEdit: { range, newText: item.label }, filterText: item.label }))

  return items.length > 0 ? { isIncomplete: false, items } : null
}

export async function templateData(host: LspHost, document: Document, wanted: Wanted): Promise<TemplateData> {
  const project = host.projectAt(projectRootOf(document.file, host.root))
  const data: TemplateData = { lints: [], paths: [], messages: [], components: [], elements: [] }

  if (wanted.kind === 'ui') {
    data.ui = await uiData(project, document, wanted.tag)
  }
  else if (wanted.kind === 'lint') {
    data.lints = Object.entries(LINTS).filter(([, lint]) => !('site' in lint)).map(([name]) => name)
  }
  else if (wanted.kind === 'path') {
    data.paths = await remembered(project.lookups, 'paths', async () => servedRoutes(project))
  }
  else if (wanted.kind === 'message') {
    data.messages = await remembered(project.lookups, 'messages', async () => project.options.i18n ? messageKeys(project.root, project.options.i18n, project.options.extensions) : [])
  }
  else {
    data.elements = [...HTML_ELEMENTS]
    data.components = await importedComponents(host, document, project, wanted.kind === 'attribute' ? wanted.tag : undefined)
  }

  return data
}

export async function servedRoutes(project: Project): Promise<string[]> {
  const paths = await servedPathsOf(project.root, project.options)

  return [...new Set(paths.filter(path => path.startsWith('/')))].sort()
}

// The components a file imports; a local `.kay` one is read for the props and blocks it takes, and the props of `tag` come from TypeScript when the file alone does not say them: a package's component, or a props type declared elsewhere.
export async function importedComponents(host: LspHost, document: Document, project: Project, tag?: string): Promise<TemplateData['components']> {
  const parsed = parseKay(document.source)
  const { imports } = analyzeScript(document.source, parsed.script, [], [], parsed.module)
  const found: TemplateData['components'] = []

  for (const binding of imports.filter(candidate => CAPITALIZED.test(candidate.local) && !candidate.typeOnly)) {
    const known = await localInterface(host, document, project, binding.source)
    const typed = binding.local === tag && (known === undefined || known.typed) ? await typedProps(host, document, project, tag, binding.source) : undefined

    found.push({ name: binding.local, from: binding.source, props: typed !== undefined && typed.length > 0 ? typed : known?.props ?? [], blocks: known?.blocks ?? [] })
  }

  return found
}

// The interface of the `.kay` file an import names, written with its extension or without: the open text, or the file as of the last save.
export async function localInterface(host: LspHost, document: Document, project: Project, specifier: string): Promise<ComponentInterface | undefined> {
  if (!specifier.startsWith('.'))
    return undefined

  const path = resolve(dirname(document.file), specifier.endsWith('.kay') ? specifier : `${specifier}.kay`)
  const open = [...host.documents.values()].find(candidate => candidate.file === path)

  if (open)
    return componentInterface(open.source)

  const { interfaces } = project.lookups

  if (!interfaces.has(path))
    interfaces.set(path, existsSync(path) ? componentInterface(await Bun.file(path).text()) : undefined)

  return interfaces.get(path)
}

// The props TypeScript gives a tag, asked of a copy of the file's shadow with the tag written once more at its end, since the cursor of a completion is not in the shadow itself.
export async function typedProps(host: LspHost, document: Document, project: Project, tag: string, from: string): Promise<ComponentInterface['props'] | undefined> {
  const key = `${document.file}\0${tag}\0${from}`
  const cached = project.lookups.typedProps.get(key)

  if (cached)
    return cached

  const { typedProps } = project.lookups
  const asked = askProps(host, document, tag)

  typedProps.set(key, asked)

  const props = await asked

  // A failed probe is asked again, unless a newer one took its key.
  if (props === undefined && typedProps.get(key) === asked)
    typedProps.delete(key)

  return props
}

export async function askProps(host: LspHost, document: Document, tag: string): Promise<ComponentInterface['props'] | undefined> {
  const call = `void (<${tag}  />)`
  const text = `${document.tsx}\n${call}\n`
  const uri = `${document.shadowUri}.props${host.nextProbe()}.tsx`
  const position = toPosition(text, text.length - call.length - 1 + call.indexOf('  ') + 1)

  host.server.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'typescriptreact', version: 1, text } })

  try {
    const result = await host.server.request<CompletionList | CompletionItem[] | null>('textDocument/completion', { textDocument: { uri }, position })
    const items = (Array.isArray(result) ? result : result?.items ?? []).filter(item => (item.kind === KIND_PROPERTY || item.kind === KIND_FIELD) && item.label !== 'key' && !GENERATED_NAME.test(item.label))

    return items.map(item => ({ name: item.label.replace(OPTIONAL_MARK, ''), optional: item.label.endsWith('?') }))
  }
  catch {
    return undefined
  }
  finally {
    host.server.notify('textDocument/didClose', { textDocument: { uri } })
  }
}

// Items carry the document they were listed for, since the editor may resolve one after another file asked for completions.
export async function resolveCompletion(host: LspHost, item: CompletionItem): Promise<CompletionItem> {
  const { uri, offset, data } = item.data as { uri: string, offset: number, data: unknown }
  const document = host.documents.get(uri)
  const resolved = await host.server.request<CompletionItem>('completionItem/resolve', { ...item, data })

  return { ...(document ? mapCompletionItem(document, resolved, offset) : resolved), data: item.data }
}
