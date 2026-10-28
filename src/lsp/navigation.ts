import type { Document, LspHost, Target } from './host'
import type { DocumentHighlight, Hover, InlayHint, Location, LocationLink, Position, Range, TextDocumentIdentifier, TextDocumentPositionParams, TsgoInlayHint } from './protocol'
import { sourceSpan } from '../check/shadow'
import { clientUri, packageDeclaration, shadowOf, targetOf, toShadow } from './bridge'
import { filePath, positionKey, rangeKey, sourceEdits, toSourceRange, uniqueBy, zeroRange } from './mapping'
import { toOffset, toPosition } from './positions'

const PARAMETER_HINT = 2
// How far a question follows names through generated code.
const MAX_HOPS = 16

export async function hover(host: LspHost, params: TextDocumentPositionParams): Promise<Hover | null> {
  const target = toShadow(host, params)

  if (!target)
    return null

  const hover = await host.server.request<Hover | null>('textDocument/hover', target.params)

  return !hover ? null : { contents: hover.contents, range: hover.range && toSourceRange(target.document, hover.range) }
}

export async function definition(host: LspHost, params: TextDocumentPositionParams): Promise<LocationLink[] | null> {
  const target = toShadow(host, params)

  if (!target)
    return null

  const links = await sourceLinks(host, target.document, await definitionsAt(host, target.params), new Set([positionKey(target.params.textDocument.uri, target.params.position)]))

  return uniqueBy(links, link => `${link.targetUri} ${rangeKey(link.targetSelectionRange)}`)
}

export async function definitionsAt(host: LspHost, at: TextDocumentPositionParams): Promise<(Location | LocationLink)[]> {
  const result = await host.server.request<Location | Location[] | LocationLink[] | null>('textDocument/definition', at)

  if (result === null)
    return []

  return Array.isArray(result) ? result : [result]
}

// Definitions inside another component land in its shadow TSX; this points them back at the .kay file.
// One that lands in generated glue, such as the `return { srv }` handing a server value to the template, is asked again from there, to reach the declaration it stands for.
export async function sourceLinks(host: LspHost, origin: Document, locations: (Location | LocationLink)[], asked: Set<string>): Promise<LocationLink[]> {
  const links = await Promise.all(locations.map(async (location) => {
    const link = 'targetUri' in location ? location : { targetUri: location.uri, targetRange: location.range, targetSelectionRange: location.range }
    const shadow = await shadowOf(host, link.targetUri)
    const originSelectionRange = link.originSelectionRange && toSourceRange(origin, link.originSelectionRange)
    const declared = shadow ? undefined : await packageDeclaration(link.targetUri, link.targetSelectionRange.start.line)

    // A library component's declaration stands for its shadow file, which leads on to its `.kay` source.
    if (declared) {
      const key = positionKey(declared.textDocument.uri, declared.position)

      if (!asked.has(key) && asked.size <= MAX_HOPS) {
        asked.add(key)

        const followed = await sourceLinks(host, origin, await definitionsAt(host, declared), asked)

        if (followed.length > 0)
          return followed.map(found => ({ ...found, originSelectionRange }))
      }
    }

    if (!shadow)
      return [{ ...link, targetUri: clientUri(host, filePath(link.targetUri)), originSelectionRange }]

    const targetUri = clientUri(host, shadow.file)
    const selection = toSourceRange(shadow, link.targetSelectionRange)

    if (selection)
      return [{ originSelectionRange, targetUri, targetRange: toSourceRange(shadow, link.targetRange, 'loose') ?? selection, targetSelectionRange: selection }]

    const key = positionKey(link.targetUri, link.targetSelectionRange.start)

    if (!asked.has(key) && asked.size <= MAX_HOPS) {
      asked.add(key)

      const followed = await sourceLinks(host, origin, await definitionsAt(host, { textDocument: { uri: link.targetUri }, position: link.targetSelectionRange.start }), asked)

      if (followed.length > 0)
        return followed.map(found => ({ ...found, originSelectionRange }))
    }

    return [{ originSelectionRange, targetUri, targetRange: toSourceRange(shadow, link.targetRange, 'loose') ?? zeroRange(), targetSelectionRange: toSourceRange(shadow, link.targetSelectionRange, 'loose') ?? zeroRange() }]
  }))

  return links.flat()
}

export async function references(host: LspHost, params: TextDocumentPositionParams & { context: unknown }): Promise<Location[] | null> {
  const target = toShadow(host, params)

  if (!target)
    return null

  const { found } = await across(host, target.params, async at => await host.server.request<Location[] | null>('textDocument/references', { ...at, context: params.context }) ?? [])

  return uniqueBy(found.map(({ file, range }) => ({ uri: file.uri, range })), location => `${location.uri} ${rangeKey(location.range)}`)
}

export async function highlights(host: LspHost, params: TextDocumentPositionParams): Promise<DocumentHighlight[] | null> {
  const target = toShadow(host, params)

  if (!target)
    return null

  const { found } = await across(host, target.params, async (at) => {
    const highlights = await host.server.request<DocumentHighlight[] | null>('textDocument/documentHighlight', at) ?? []

    return highlights.map(highlight => ({ ...highlight, uri: at.textDocument.uri }))
  })

  return uniqueBy(found.map(({ spot, range }) => ({ range, kind: spot.kind })), highlight => rangeKey(highlight.range))
}

// Signatures carry no positions, so they pass through as they are.
export async function signatureHelp(host: LspHost, params: TextDocumentPositionParams & { context?: unknown }): Promise<unknown> {
  const target = toShadow(host, params)

  return target ? host.server.request('textDocument/signatureHelp', { ...target.params, context: params.context }) : null
}

// Generated code joins names TypeScript sees apart, such as a server value and the template's reads of it through `__props`: wherever an answer lands in generated code, the question is asked again from there.
// Not `complete` once it gave up following them, past `MAX_HOPS`.
export async function across<Spot extends { uri: string, range: Range }>(host: LspHost, start: TextDocumentPositionParams, ask: (at: TextDocumentPositionParams) => Promise<Spot[]>): Promise<{ found: { spot: Spot, file: Target, range: Range }[], complete: boolean }> {
  const files = new Map<string, Promise<Target | undefined>>()
  const known = new Set<string>([positionKey(start.textDocument.uri, start.position)])
  const queue = [start]
  const found: { spot: Spot, file: Target, range: Range }[] = []
  let hops = 0
  const visit = (uri: string, position: Position) => {
    const key = positionKey(uri, position)

    if (known.has(key))
      return

    known.add(key)

    if (++hops <= MAX_HOPS)
      queue.push({ textDocument: { uri }, position })
  }

  for (let at = queue.pop(); at; at = queue.pop()) {
    for (const spot of await ask(at)) {
      let pending = files.get(spot.uri)

      if (!pending)
        files.set(spot.uri, pending = targetOf(host, spot.uri))

      const file = await pending

      if (!file)
        continue

      const range = file.shadow ? toSourceRange(file.shadow, spot.range) : spot.range

      if (!range) {
        visit(spot.uri, spot.range.start)

        continue
      }

      found.push({ spot, file, range })
      known.add(positionKey(spot.uri, spot.range.start))
      // Every other copy of the name in generated code is asked about too.
      for (const generated of file.shadow?.map.toGeneratedAll(toOffset(file.shadow.source, range.start)) ?? [])
        visit(spot.uri, toPosition(file.shadow!.tsx, generated))
    }
  }

  return { found, complete: hops <= MAX_HOPS }
}

// tsgo's hints for the types it infers and the names of the parameters a call fills, where the code they follow is the author's own: those of generated code have nowhere to show.
export async function inlayHints(host: LspHost, params: { textDocument: TextDocumentIdentifier, range: Range }): Promise<InlayHint[]> {
  const document = host.documents.get(params.textDocument.uri)

  if (!document)
    return []

  const wanted = { start: toOffset(document.source, params.range.start), end: toOffset(document.source, params.range.end) }
  // The generated code of the range, with a character of slack.
  const generated = document.map.generatedHull(wanted.start, wanted.end)

  if (!generated)
    return []

  const range = { start: toPosition(document.tsx, generated.start), end: toPosition(document.tsx, Math.min(generated.end + 1, document.tsx.length)) }
  const found = await host.server.request<TsgoInlayHint[] | null>('textDocument/inlayHint', { textDocument: { uri: document.shadowUri }, range })

  return (found ?? []).flatMap((hint) => {
    const at = toOffset(document.tsx, hint.position)
    // A type follows the code it is of, a parameter's name precedes the argument it names.
    const span = hint.kind === PARAMETER_HINT ? sourceSpan(document, at, at + 1, 'code') : sourceSpan(document, at - 1, at, 'code')
    const offset = span && (hint.kind === PARAMETER_HINT ? span.start : span.start + 1)

    if (offset === undefined || offset < wanted.start || offset > wanted.end)
      return []

    const { label, textEdits, ...rest } = hint
    const edits = textEdits && sourceEdits(document, textEdits, offset)

    return [{ ...rest, position: toPosition(document.source, offset), label: typeof label === 'string' ? label : label.map(part => part.value).join(''), ...edits && { textEdits: edits } }]
  })
}
