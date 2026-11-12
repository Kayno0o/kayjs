import type { ErrorPageContext } from '../runtime'
import type { Outcome } from '../runtime/action'
import type { PendingBlock } from '../runtime/await.server'
import type { EditorProps } from '../runtime/edit'
import type { EntryRef, FieldMarks } from '../runtime/fields'
import type { HeadOptions, HeadTag, RenderedHead } from '../runtime/head'
import type { Seed } from '../runtime/live-resource.server'
import type { QueryRules } from '../runtime/query-param'
import type { ClientBuild } from './client'
import type { BodyPieces, FixedText } from './compress'
import type { DevRequest } from './dev'
import type { PageModule, Rendering, RenderOptions } from './render'
import { relative } from 'node:path'
import process from 'node:process'
import { apiPrefixOf } from '../config-shape'
import { collectForms, OUTCOME_SCRIPT } from '../runtime/action'
import { durationMs } from '../runtime/duration'
import { escapeAttribute } from '../runtime/escape'
import { editMarks, entriesInPageOrder, placeFieldMarks, unclickableFields, withFieldMarks } from '../runtime/fields'
import { filledBy, inFillChain, newFillChain } from '../runtime/fills'
import { collectHead, head as setHead } from '../runtime/head'
import { child, component, html, newServerIslands, withinComponent, withServerIslands } from '../runtime/html'
import { localePath, textDirection } from '../runtime/i18n'
import { DEFAULT_MAX_DENSITY, RESOLVED_META } from '../runtime/image'
import { unrevivableAction } from '../runtime/island.server'
import { resourcesUsed, resourcesWanted, withSeeds } from '../runtime/live-resource.server'
import { localeState } from '../runtime/locale-state'
import { kayLog } from '../runtime/log'
import { NAVIGATION_ENTRY } from '../runtime/navigation-entry'
import { BUILD_META } from '../runtime/swap'
import { LINK_SCHEMES_META } from '../runtime/url'
import { encodeValue, unsendable } from '../runtime/wire'
import { INLINE_LIMIT, islandChunks } from './client'
import { STYLE_TAG } from './compress'
import { A11Y_SCRIPT, DEV_BOOT, devToolScripts, liveReload, problemsBlock, STYLES_SCRIPT, typeProblemsBlock } from './dev'
import { formsScript } from './forms'
import { historyScript } from './history'
import { hydrationScript } from './hydration'
import { DEFAULT_LANG, invalidKeys, messagesScript } from './i18n'
import { followsCaches, liveScript, noteStreams } from './live'
import { newTabRule } from './new-tab'
import { INSTALL_OFFER, registerScript } from './offline'
import { chainSetting } from './page-settings'
import { noteEditedEntries, noteProbedEntries } from './preview'
import { requestId } from './protection'
import { chainQuery, queryRules, queryScript } from './query'
import { reportServerError } from './report'
import { ResourcesPendingError, resourcesScript } from './resources'
import { inServerScope } from './scope'
import { prefetchMeta, speculationRules } from './speculation'
import { renderStatic, streamDocument } from './stream'
import { typographyFor } from './typography'
import { workScript } from './work'

const GUARDED_META = '<meta name="kay-guarded">'
const DATA_PREFETCH = /data-prefetch/i
const CHARSET = '<meta charset="utf-8">'

const VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1">'

const islandScriptsOf = perOwner<ClientBuild>()
const stylesheetsOf = perOwner<ClientBuild['styles']>()

export function projectPath(file: string): string {
  return relative(process.cwd(), file)
}

function htmlOpen(lang: string, attributes: string): string {
  return `<!doctype html><html lang="${escapeAttribute(lang)}"${textDirection(lang) === 'rtl' ? ' dir="rtl"' : ''}${attributes}>`
}

// The charset and viewport kay gives a page that sets neither, around what must come first in the head.
function headStart(head: RenderedHead): string {
  return `${head.charset ? '' : CHARSET}${head.prelude}${head.viewport ? '' : VIEWPORT}${head.styles}`
}

// What the islands read off the page: the mount point, where the API is when `apiPath` moved it (for a script that imports no API module, as a library's loader), and the image settings that are not the default.
function kayMetas(options: RenderOptions, hasIslands: boolean): string {
  const apiAt = apiPrefixOf(options.serve)
  const base = (options.base !== undefined && options.base !== '' ? `<meta name="kay-base" content="${escapeAttribute(options.base)}">` : '') + (apiAt !== undefined && apiAt !== '/api' ? `<meta name="kay-api" content="${escapeAttribute(apiAt)}">` : '') + (options.client?.saveData === false ? '<meta name="kay-save-data" content="off">' : '') + (options.client?.pageTimeout === undefined ? '' : `<meta name="kay-page-timeout" content="${durationMs(options.client.pageTimeout)}">`) + (options.sameTabLinks === true ? '<meta name="kay-same-tab-links">' : '') + (options.linkSchemes !== undefined && options.linkSchemes.length > 0 ? `<meta name="${LINK_SCHEMES_META}" content="${escapeAttribute(options.linkSchemes.join(','))}">` : '')

  if (!hasIslands)
    return base

  return `${base}${options.maxDensity !== undefined && options.maxDensity !== DEFAULT_MAX_DENSITY ? `<meta name="kay-max-density" content="${options.maxDensity}">` : ''}${options.imageWidths === undefined ? '' : `<meta name="kay-image-widths" content="${options.imageWidths.join(',')}">`}${options.resolvedImages === true ? `<meta name="${RESOLVED_META}">` : ''}`
}

function devScripts(client: ClientBuild, files: string[], late: boolean): string {
  return problemsBlock(client.problems) + typeProblemsBlock() + liveReload() + DEV_BOOT + devToolScripts() + A11Y_SCRIPT + (late ? '' : pageClassesBlock(client, files) + STYLES_SCRIPT)
}

// The classes the page's own files name, which production writes the rules of, for the dev page to check what it sets against.
function pageClassesBlock(client: ClientBuild, files: string[]): string {
  const uses = client.styleUses

  if (uses === undefined)
    return ''

  const names = new Set<string>()

  for (const file of files) {
    const own = uses.entries.get(file)

    // A file with no names makes production link the whole sheet, so nothing is missing from the page: the check skips it.
    if (own === true || own === undefined)
      return ''

    for (const index of own)
      names.add(uses.classes[index]!)
  }

  return `<script type="application/json" data-kay-page-classes>${JSON.stringify([...names]).replaceAll('<', '\\u003c')}</script>`
}

// What the dev tool's Request tab shows: the route matched, the files that rendered, the params, the status, and how long each load took, the matched route's when another page shows its error.
function requestBlock(files: string[], rendering: Rendering, base: string): string {
  const { loads } = rendering
  const state = localeState()
  // A host of its own is a protocol-relative address, which the base does not prefix.
  const locales = state === undefined || state.implicit === true || state.settings.locales.length < 2
    ? undefined
    : state.settings.locales.map((locale) => {
      const href = localePath(state.settings, state.path, locale, state.host)

      return { locale, href: href.startsWith('//') ? href : base + href }
    })
  const request: DevRequest = {
    route: rendering.matched,
    page: projectPath(files.at(-1)!),
    layouts: files.slice(0, -1).map(projectPath),
    params: rendering.ctx.params,
    id: requestId(rendering.ctx.request),
    guards: rendering.guards ?? [],
    prerender: rendering.prerender,
    slow: rendering.slow,
    locale: rendering.ctx.locale,
    locales,
    status: rendering.status,
    error: (rendering.ctx as Partial<ErrorPageContext>).error?.message,
    loads: loads ? loads.files.flatMap((file, index) => loads.modules[index]!.load ? [{ file: projectPath(file), ms: loads.timings?.[index] }] : []) : [],
  }
  // A matcher may give a param any value, which shows as its text when JSON has none.
  const json = JSON.stringify(request, (_, value: unknown) => typeof value === 'bigint' || typeof value === 'symbol' ? String(value) : value)

  return `<script type="application/json" id="kay-dev-request">${json.replaceAll('<', '\\u003c')}</script>`
}

// The post the page answers, for its islands to render what the server did as they hydrate, then read through the action.
// What the post sent stays out: a field the server cannot tell is a secret, such as a password field named `confirm`, or the honeypot's text, would show in the page's source.
function outcomeScript(outcome: Outcome | null): string {
  if (!outcome)
    return ''

  let text: string

  try {
    text = encodeValue(outcome.succeeded ? outcome : { ...outcome, values: {} })
  }
  catch (error) {
    kayLog('warn', `what ${outcome.action} ${outcome.succeeded ? 'returned' : 'passed to ctx.fail'} cannot reach the page's islands: ${unsendable(error) ?? String(error)}`)

    return ''
  }

  return `<script type="application/json" ${OUTCOME_SCRIPT}>${text.replaceAll('<', '\\u003c')}</script>`
}

// The sheets of a chain cut at the fixed texts they hold, with the text cut, which the same chain keeps writing as one string.
interface SheetSplit { sheets: string, strings: string[], texts: FixedText[] }

const splitSheets = new WeakMap<FixedText[], Map<string, SheetSplit>>()

function splitAtFixed(sheets: string, fixed: FixedText[]): SheetSplit {
  const split: SheetSplit = { sheets, strings: [], texts: [] }
  // Read back from the bytes only while cutting, so no second copy of a stylesheet stays held.
  const written = fixed.map(one => ({ one, string: one.bytes.toString() }))
  let cursor = 0

  for (let at = sheets.indexOf(STYLE_TAG); at >= 0; at = sheets.indexOf(STYLE_TAG, at + 1)) {
    const found = at < cursor ? undefined : written.find(({ string }) => sheets.startsWith(string, at))

    if (found) {
      split.strings.push(sheets.slice(cursor, at))
      split.texts.push(found.one)
      cursor = at + found.string.length
    }
  }

  split.strings.push(sheets.slice(cursor))

  return split
}

// A page's body in pieces around the fixed texts its stylesheets hold, or undefined when it holds none: the sheets are cut once, as a chain writes the same text every time.
export function piecesOf(fixed: FixedText[] | undefined, files: string[], sheets: string, opening: string, closing: string): BodyPieces | undefined {
  if (!fixed || fixed.length === 0)
    return undefined

  let cached = splitSheets.get(fixed)

  if (!cached)
    splitSheets.set(fixed, cached = new Map<string, SheetSplit>())

  const key = files.join('\n')
  let split = cached.get(key)

  if (split?.sheets !== sheets) {
    split = splitAtFixed(sheets, fixed)
    cached.set(key, split)
  }

  if (split.texts.length === 0)
    return undefined

  const { strings, texts } = split

  return { strings: [`${opening}${strings[0]}`, ...strings.slice(1, -1), `${strings.at(-1)}${closing}`], texts }
}

// The stylesheets of the layouts, outermost first, then the page's.
function stylesheets(client: ClientBuild, files: string[]): string {
  if (client.styles.size === 0)
    return ''

  return stylesheetsOf(client.styles, files.join('\n'), () => {
    const own = client.pageStyles?.get(files.join('\n'))

    if (own !== undefined)
      return own.html

    const urls = [...new Set(files.map(file => client.styles.get(file)))].filter(url => url !== undefined)
    // Unset, the page inlines its stylesheets only while together they stay within the limit.
    const inline = client.inlineStyles !== undefined && (client.inlineSizes === undefined || urls.reduce((sum, url) => sum + (client.inlineSizes!.get(url) ?? Infinity), 0) <= INLINE_LIMIT)

    return urls.map((url) => {
      const css = inline ? client.inlineStyles!.get(url) : undefined

      return css === undefined ? `<link rel="stylesheet" href="${url}">` : `<style>${css}</style>`
    }).join('')
  })
}

// Marked, so a page running the islands' entry that swaps this page in neither runs nor preloads it.
function navigationScripts(client: ClientBuild): string {
  return `${client.navEntryImports!.map(chunk => `<link rel="modulepreload" href="${chunk}" ${NAVIGATION_ENTRY}>`).join('')}<script type="module" src="${client.navEntry}" ${NAVIGATION_ENTRY}></script>`
}

// Preloads every chunk the page's eager islands need, and the code waiting for a `visible` or `idle` island or a deferred server island when it holds any, so the browser fetches them alongside the entry instead of one round trip after another. A streamed page loads the entry after its first part instead.
// A page without islands needs no hydration script, only the entry swapping pages.
// `saving` is set where a page drops island-only preloads for a visitor saving data. The chunks of the islands hydrating at once, `immediate`, that page keeps: they are marked `data-load`, which the dropping no longer matches.
// One also needed by an island that waits for that visitor, `waiting`, is marked `data-wait` too, where the code waiting for the viewport is preloaded for that visitor even though no link was dropped.
function islandScripts(client: ClientBuild, islands: Set<string>, streamed: boolean, hydration: boolean, lazy: boolean, saving?: { immediate: Set<string>, waiting: Set<string> }): string {
  const immediate = saving?.immediate
  const waiting = saving?.waiting

  return islandScriptsOf(client, `${streamed}\n${hydration}\n${lazy}\n${[...islands].sort().join('\n')}\n\0${immediate === undefined ? '-' : [...immediate].sort().join('\n')}\n\0${waiting === undefined ? '-' : [...waiting].sort().join('\n')}`, () => {
    const chunks = new Set(client.entryImports)

    // Waiting for an island to be visible or idle, or a deferred server island to near the viewport, needs its own chunk, which the entry would ask for only once it ran.
    if (lazy) {
      for (const chunk of client.hydrateWhen ?? [])
        chunks.add(chunk)
    }

    const now = new Set<string>()
    const waits = new Set<string>()

    for (const id of islands) {
      for (const chunk of client.islands[id] ?? []) {
        chunks.add(chunk)

        if (immediate?.has(id) === true)
          now.add(chunk)

        if (waiting?.has(id) === true)
          waits.add(chunk)
      }
    }

    return `${[...chunks].map(chunk => `<link rel="modulepreload" href="${chunk}"${now.has(chunk) ? ` data-load${waits.has(chunk) ? ' data-wait' : ''}` : ''}>`).join('')}${hydration ? hydrationScript : ''}${streamed ? '' : `<script type="module" src="${client.entry}"></script>`}`
  })
}

// One text per key and owner, made the first time it is asked for.
// Per set of islands and per chain of layouts: few exist, and they never change for a build. The stylesheets go by their map, which a server under `kay dev` swaps whole for a stylesheet edit.
function perOwner<Owner extends object>(): (owner: Owner, key: string, make: () => string) => string {
  const caches = new WeakMap<Owner, Map<string, string>>()

  return (owner, key, make) => {
    let cached = caches.get(owner)

    if (!cached)
      caches.set(owner, cached = new Map<string, string>())

    let text = cached.get(key)

    if (text === undefined)
      cached.set(key, text = make())

    return text
  }
}

// An island's module, whose `persist` keeps it alive across the page swap.
export interface EditorModule {
  default: (props: EditorProps & { persist: true }) => unknown
}

// The editor's module by its file, imported before a page in edit mode renders, which does not wait.
export const editors = new Map<string, EditorModule>()

// The head a page starts from, a page or a layout above it saying `noindex` asking search engines to leave it out; a layout or the page may still set its own `robots`.
function pageHead(modules: PageModule[], head: HeadOptions | undefined): HeadOptions | undefined {
  if (chainSetting(modules, 'noindex') !== true)
    return head

  return { ...head, defaults: [...head?.defaults ?? [], { tag: 'meta', props: { name: 'robots', content: 'noindex' } }] }
}

// The last module is the page, the others its layouts, outermost first. A page with pending `await` blocks streams.
export function renderDocument(files: string[], modules: PageModule[], data: Record<string, unknown>[], client: ClientBuild, rendering: Rendering, options: RenderOptions, entry?: HeadTag[]): string | Pieced | ReadableStream<Uint8Array> {
  const rules = queryRules(chainQuery(files, modules))

  // A page a persisted signal's cookie shaped is told apart by it in any cache.
  return inServerScope(rendering.ctx.request, error => reportServerError(error, rendering.ctx.request, options.observe?.onError), () => documentOf(files, modules, data, client, rendering, options, rules, entry), () => rendering.headers.append('vary', 'cookie'), rules)
}

// The page inside its layouts, each through `component`, so what a layout provides reaches its page.
// A layout's named slot is read off its page: reading one renders the page first, once, which hands the layout the blocks it wrote.
export function viewOf(modules: PageModule[], data: Record<string, unknown>[], entry?: HeadTag[]): () => unknown {
  const page = modules.length - 1
  const chain = newFillChain(modules.length)
  const declared = modules.map(module => module.slots)

  // Set after its layouts' heads and before its own, which each replace what the entry gave.
  let view = () => {
    chain.at = page

    if (entry !== undefined)
      setHead(entry)

    return component(modules[page]!.default, data[page]!)
  }

  for (let index = page - 1; index >= 0; index--) {
    const inner = view

    view = () => {
      let below: { value: unknown } | undefined
      // The page and the layouts under this one register their blocks as they render, each as the module it is.
      const rendered = () => {
        if (below === undefined) {
          below = { value: inner() }
          chain.at = index
        }

        return below.value
      }
      const props = { ...data[index], get children() {
        return rendered()
      } }

      for (const name of declared[index] ?? []) {
        Object.defineProperty(props, name, { enumerable: true, get() {
          rendered()

          const found = filledBy(chain, declared, index, name)

          return found && withinComponent(modules[found.at]!.default, found.block)
        } })
      }

      chain.at = index

      return component(modules[index]!.default, props)
    }
  }

  const outer = view

  return () => inFillChain(chain, outer)
}

// The entries the editor opens are the only ones its edit cookie may read through a CMS's API.
function noted(request: Request, entries: EntryRef[]): EntryRef[] {
  noteEditedEntries(request, entries)

  return entries
}

// The page the editor renders once the page did, given each entry the page read.
function withEditor(view: () => unknown, marks: FieldMarks, editor: EditorModule, request: Request): () => unknown {
  return () => {
    const page = child(view())
    const entries = noted(request, entriesInPageOrder(marks, page))
    // Placed here for the editor to be told what the markers left out; the page is placed again with the head, finding nothing more to place in this part.
    const placed = placeFieldMarks(page, marks)

    return html(placed + child(editor.default({ entries, unclickable: unclickableFields(marks, placed), persist: true })))
  }
}

// Each deferred block reads the values the page's resources held, as the pass it was made in is gone when it settles.
function seedBlocks(deferred: PendingBlock[], seeds: ReadonlyMap<string, Seed>): void {
  for (const block of deferred) {
    const { ready, failed, fallback } = block

    block.ready = value => withSeeds(seeds, () => ready(value))

    if (failed)
      block.failed = error => withSeeds(seeds, () => failed(error))

    if (fallback)
      block.fallback = error => withSeeds(seeds, () => fallback(error))
  }
}

function documentOf(files: string[], modules: PageModule[], data: Record<string, unknown>[], client: ClientBuild, rendering: Rendering, options: RenderOptions, rules: QueryRules | undefined, entry?: HeadTag[]): string | Pieced | ReadableStream<Uint8Array> {
  const view = viewOf(modules, data, entry)
  const chunks = islandChunks(client)
  // A prerendered page holds each server island between marks the server splits it at.
  const scan = options.prerendering ? Object.assign(newServerIslands(true), { awaits: options.awaits }) : undefined
  // In edit mode the page's markup is marked with the fields of the entries it renders, once whole.
  const marks = editMarks()
  const file = marks === undefined ? undefined : options.editor
  const editor = file === undefined ? undefined : editors.get(file)
  // The editor renders once the page did, given each entry the page read, kept alive by the page swap, which hands it the next page's.
  const shown = marks === undefined || editor === undefined ? view : withEditor(view, marks, editor, rendering.ctx.request)
  // Its stylesheet comes last, after the page's.
  const styled = file === undefined || editor === undefined ? files : [...files, file]
  const { result: { result: { html: markup, islands, deferred }, head }, forms } = withFieldMarks(marks, () => collectForms(() => collectHead(() => scan ? withServerIslands(scan, () => renderStatic(shown, undefined, chunks)) : renderStatic(shown, undefined, chunks), pageHead(modules, options.head?.(rendering.ctx.url, rendering.status)))))
  const wanted = resourcesWanted()

  if (wanted !== undefined) {
    // The pass is thrown away, so a promise its `await` blocks started must not report a rejection nothing will take.
    for (const block of deferred)
      void held(block.value)

    throw new ResourcesPendingError(wanted)
  }

  const seeded = resourcesUsed()

  if (seeded !== undefined && seeded.size > 0)
    seedBlocks(deferred, new Map(seeded))

  const streamed = deferred.length > 0

  if (streamed)
    noteStreams()

  if (marks)
    noteProbedEntries(rendering.ctx.request, marks.entries.values())

  const hasIslands = client.entry !== undefined && islands.count > 0

  const unrevivable = unrevivableAction(islands, client)

  if (unrevivable)
    throw unrevivable

  // A page posting forms to actions loads the entry too, which sends them without a reload; a page with neither ships only `historyScript`, and links from it load pages, losing no state.
  const posts = client.entry !== undefined && client.navigation === true && forms.size > 0
  // The entry fetches a deferred server island as it nears the viewport.
  const liveText = liveScript()
  // A page following cached values loads the entry too, which opens the connection telling it they changed.
  const follows = client.entry !== undefined && followsCaches()
  const defers = client.entry !== undefined && scan?.modes.includes('defer') === true
  const shipsEntry = hasIslands || posts || follows || defers
  // A production page only posting forms loads navigation alone; a streamed one, or a prerendered one holding a server island, may still render islands or forms per request, which the islands' entry runs.
  const navigates = posts && !hasIslands && !follows && !defers && !streamed && (scan?.modes.length ?? 0) === 0 && client.navEntry !== undefined
  const checked = posts ? formsScript(forms, options.dev) : ''
  const scripts = shipsEntry ? (navigates ? navigationScripts(client) : islandScripts(client, islands.eager, streamed, hasIslands, islands.lazy > 0 || defers, options.islandPreloads === undefined ? undefined : islands)) + checked + workScript(forms, options.prerendering === true) : ''
  const state = localeState()
  // Without `i18n` the page may say its own language; with it, the locale decides.
  const lang = (state === undefined || state.implicit ? head.lang : undefined) ?? state?.locale ?? options.lang ?? DEFAULT_LANG
  const polish = typographyFor(state?.locale ?? options.lang ?? DEFAULT_LANG, options.client?.typography)
  const body = polish ? polish(markup) : markup
  const headHtml = polish ? polish(head.html) : head.html
  // The browser's form check words a refusal as the server does, so a page with a checked form sends the `kay.invalid.*` messages too.
  const words = checked === '' ? islands.messages : new Set([...islands.messages, ...invalidKeys()])
  const islandData = (hasIslands || (checked !== '' && words.size > 0) ? messagesScript(words, true, hasIslands && lang !== state?.locale) : '') + (hasIslands ? outcomeScript(rendering.carried()) + queryScript(rules) + resourcesScript(resourcesUsed()) : '') + liveText
  // A page rendering an island that uses `installPrompt` keeps the browser's install offer from the first moment, unless the worker's registration script already does. A streamed block or deferred server island renders after the head, so such a page carries it whenever the app has one.
  const keepsInstallOffer = client.installs?.some(id => streamed || defers || islands.used.has(id)) === true && !(options.offline && options.installOffer)
  const opening = `${htmlOpen(lang, head.root)}<head>${headStart(head)}`
  const sheets = stylesheets(client, styled)
  // The nearest-`data-prefetch` selector is needed once the page holds the attribute or may gain it later: a streamed part, an island, or a server island spliced into a prerendered page.
  const mayPrefetchPerLink = shipsEntry || streamed || (scan?.modes.length ?? 0) > 0 || [markup, head.html, head.root].some(html => DATA_PREFETCH.test(html))
  const closing = `${headHtml}${scripts}${islandData}${kayMetas(options, hasIslands)}${newTabRule(markup, hasIslands || streamed, options.sameTabLinks === true)}${shipsEntry && client.build !== undefined ? `<meta name="${BUILD_META}" content="${client.build}">` : ''}${shipsEntry && client.navigation === true ? prefetchMeta(options.client?.prefetch) : speculationRules(options.client?.prefetch, options.base, apiPrefixOf(options.serve), mayPrefetchPerLink)}${rendering.guarded === true ? GUARDED_META : ''}${client.navigation === true && !shipsEntry ? historyScript : ''}${options.offline ? registerScript(options.base ?? '', options.installOffer === true) : ''}${keepsInstallOffer ? `<script>${INSTALL_OFFER}</script>` : ''}${options.dev && options.devTools ? devScripts(client, styled, options.client?.lateStyles === true) + (options.prerendering ? '' : requestBlock(files, rendering, options.base ?? '')) : ''}</head><body>${body}`
  const written = opening + sheets + closing
  const start = marks === undefined ? written : placeFieldMarks(written, marks)

  if (!streamed) {
    const pieces = marks === undefined && !options.prerendering && (options.base ?? '') === '' ? piecesOf(client.fixedStyles, styled, sheets, opening, `${closing}</body></html>`) : undefined

    return pieces ? new Pieced(`${start}</body></html>`, pieces) : `${start}</body></html>`
  }

  // A deferred module would wait for the whole stream; an async one hydrates the islands already there as soon as it loads.
  return streamDocument(shipsEntry ? `${start}<script type="module" async src="${client.entry}"></script>` : start, deferred, client, shipsEntry, error => reportServerError(error, rendering.ctx.request, options.observe?.onError), { hydration: hasIslands, forms: posts ? forms : undefined, words: checked !== '', locale: hasIslands || (checked !== '' && words.size > 0), dev: options.dev, polish })
}

// Takes the rejection of a promise whose render was dropped.
async function held(value: PendingBlock['value']): Promise<void> {
  if (!(value instanceof Promise))
    return

  try {
    await value
  }
  catch {}
}

// A page's text with the pieces it was put together from around the inline stylesheets it holds, which the compression keys its kept copy on without reading the text.
export class Pieced {
  constructor(readonly text: string, readonly pieces: BodyPieces) {}
}
