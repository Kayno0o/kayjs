import type { ShadowFile } from '../check/shadow'
import type { Document, LspHost, Target } from './host'
import type { TextDocumentPositionParams } from './protocol'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compileShadow, shadowOptionsFor, shadowSource } from '../check/shadow'
import { SHADOW_DIR } from '../project'
import { shadowSettingsOf } from './host'
import { filePath, vscodeUri } from './mapping'
import { toOffset, toPosition } from './positions'

const PACKAGE_TYPES = join(SHADOW_DIR, 'kay-packages.d.ts')
const DEFAULT_MEMBER = '.default'

// The URI the editor knows a file by: the one of its open document, else written like the editor writes them.
export function clientUri(host: LspHost, path: string): string {
  return [...host.documents.values()].find(document => document.file === path)?.uri ?? (host.nodeUris ? pathToFileURL(path).href : vscodeUri(path))
}

// Undefined for the declarations kay generates beside the shadow files.
export async function targetOf(host: LspHost, uri: string): Promise<Target | undefined> {
  const shadow = await shadowOf(host, uri)

  if (shadow)
    return { uri: clientUri(host, shadow.file), shadow }

  return host.shadowProject(filePath(uri)) ? undefined : { uri: clientUri(host, filePath(uri)) }
}

export async function shadowOf(host: LspHost, uri: string): Promise<ShadowFile | undefined> {
  const path = filePath(uri)
  const open = [...host.documents.values()].find(document => filePath(document.shadowUri) === path)

  if (open)
    return open

  const project = host.shadowProject(path)

  if (!project || !path.endsWith('.kay.tsx'))
    return undefined

  const placed = host.placed(project, shadowSource(project.root, path))
  const source = Bun.file(placed.file)

  return await source.exists() ? compileShadow(project.root, placed.file, await source.text(), { ...shadowOptionsFor(shadowSettingsOf(project), placed.file), shadowOf: placed.shadowOf }).shadow : undefined
}

// `offset` is the position in the .kay source.
export function toShadow(host: LspHost, params: TextDocumentPositionParams): { document: Document, offset: number, params: TextDocumentPositionParams } | undefined {
  const document = host.documents.get(params.textDocument.uri)

  if (!document)
    return undefined

  const offset = toOffset(document.source, params.position)
  const generated = document.map.toGenerated(offset)

  if (generated === undefined)
    return undefined

  return { document, offset, params: { textDocument: { uri: document.shadowUri }, position: toPosition(document.tsx, generated) } }
}

// A file a rename may change besides .kay files: one of the project's own.
export function editable(host: LspHost, uri: string): boolean {
  const path = filePath(uri)

  return path.startsWith(`${host.root}/`) && !path.includes('/node_modules/')
}

// Where the `.default` a line of `kay-packages.d.ts` reads sits, which tsgo takes on to the component's shadow file.
export async function packageDeclaration(uri: string, line: number): Promise<TextDocumentPositionParams | undefined> {
  if (!filePath(uri).endsWith(PACKAGE_TYPES))
    return undefined

  const text = (await Bun.file(filePath(uri)).text()).split('\n')[line] ?? ''
  const at = text.lastIndexOf(DEFAULT_MEMBER)

  return at === -1 ? undefined : { textDocument: { uri }, position: { line, character: at + 1 } }
}
