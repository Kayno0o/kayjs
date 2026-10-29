import type { CacheSlot } from 'kay/library'
import type { ExtensionProblem, PageHook, RenderedPage } from 'kay/server'
// Alt text drafted for the imported images of a page: one model call per image content, kept under `.kay/cache`, written into the HTML as a page is built or served.
import type { Attachment, Message } from './types'
import { readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import process from 'node:process'
import { logFrom, s } from 'kay'
import { IMPORTED, libraryCacheSlot, readCacheEntry, serverRoot, writeCacheEntry } from 'kay/library'
import { ask } from './ask'
import { choose } from './config'
import { fakeAi } from './fake'

const LIBRARY = 'kayjs-ai'
// Part of what a draft is made from, so a changed prompt drafts again.
const PROMPT_VERSION = '1'
const MAX_ALT_CHARS = 200

const ALT = s.Object({ alt: s.String({ maxLength: MAX_ALT_CHARS }) })

interface Draft {
  alt: string
  // The asset the draft was made for and the locale it is in, for `kay check` to name.
  name: string
  locale: string
}

export interface DescribeImageOptions {
  // The language to write in, such as `fr`; the image's own context decides when left out.
  language?: string | undefined
  signal?: AbortSignal | undefined
}

function systemPrompt(language: string | undefined): string {
  return `You write the alt attribute of an image for a screen reader. Answer with one short sentence of plain text saying what the image shows, no "image of" or "picture of", under ${MAX_ALT_CHARS} characters${language === undefined || language === '' ? '' : `, written in the language ${language}`}. An image that is only decoration, with nothing to say, gets an empty text.`
}

// One short alt text for an image, over `ask` with a `schema`: the fake answers under `bun test`, and a provider that does not see images fails the call.
export async function describeImage(image: Attachment, options: DescribeImageOptions = {}): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: 'Write the alt text of this image.', attachments: [image] }]
  const { alt } = await ask(messages, { schema: ALT, system: systemPrompt(options.language), maxTokens: 300, temperature: 0, ...options.signal === undefined ? {} : { signal: options.signal } })

  return alt.trim()
}

// A model is configured when the environment names a provider; the fake of development is none, and the fake of `bun test` is the one that answers.
function modelConfigured(): boolean {
  try {
    return process.env.NODE_ENV === 'test' || choose().provider !== fakeAi
  }
  catch {
    return false
  }
}

// The files a model is shown: an SVG, an AVIF or anything else is left as it is, without a call.
const SHOWN = /\.(?:png|jpe?g|gif|webp)(?:\?.*)?$/i
// How many images are described at once, so a site of many images does not meet a provider's rate limit.
const AT_ONCE = 3

const log = logFrom('kayjs-ai')

// What a draft is made for: the folder of its project, its file's name, and the locale it is written in.
interface Place {
  root: string
  path: string
  locale: string
}

function slotOf({ root, path, locale }: Place): { slot: CacheSlot, id: string } {
  const id = Bun.hash(`${root}\0${basename(path)}\0${locale}`).toString(36)

  return { id, slot: libraryCacheSlot(root, LIBRARY, id, PROMPT_VERSION) }
}

// What was found kept or made, by draft: an empty text is an image with nothing to say.
const known = new Map<string, string>()
// Each draft is made once per process, in flight or done; one that failed stays here, logged once, and is tried again after a restart.
const drafting = new Map<string, Promise<string | undefined>>()
const waiting: (() => void)[] = []
let running = 0

// Runs `task` when fewer than `AT_ONCE` run, handing its place to the next one waiting when it ends.
export async function turn<Value>(task: () => Promise<Value>): Promise<Value> {
  if (running >= AT_ONCE)
    await new Promise<void>(resolve => waiting.push(resolve))
  else
    running++

  try {
    return await task()
  }
  finally {
    const next = waiting.shift()

    if (next === undefined)
      running--
    else
      next()
  }
}

// Drops what this process remembers of the drafts, for a test that clears the cache folder.
export function forgetDrafts(): void {
  known.clear()
  drafting.clear()
}

// The kept draft of an image: its text, empty for an image with none to give, undefined when it was not drafted yet.
async function kept(place: Place): Promise<string | undefined> {
  const { id, slot } = slotOf(place)
  const remembered = known.get(id)

  if (remembered !== undefined)
    return remembered

  const entry = await readCacheEntry<Draft>(slot)

  if (entry !== undefined)
    known.set(id, entry.alt)

  return entry?.alt
}

async function make(place: Place): Promise<string | undefined> {
  const { id, slot } = slotOf(place)
  const name = basename(place.path)

  try {
    const alt = await turn(async () => describeImage(Bun.file(place.path), { language: place.locale }))

    known.set(id, alt)
    await writeCacheEntry(slot, { alt, name, locale: place.locale } satisfies Draft)

    return alt
  }
  catch (error) {
    log.warn(`imageAlt could not draft the alt of ${name}: ${error instanceof Error ? error.message : String(error)}`)

    return undefined
  }
}

// Starts the draft of an image unless it is under way or done; never rejects.
async function draftOnce(place: Place): Promise<string | undefined> {
  const { id } = slotOf(place)
  let pending = drafting.get(id)

  if (pending === undefined) {
    pending = make(place)
    drafting.set(id, pending)
  }

  return pending
}

// The `img` outside an island, which the browser draws again and hydration must find as the server wrote it.
function serverImages(onImage: (img: HTMLRewriterTypes.Element) => void): HTMLRewriter {
  let islands = 0

  return new HTMLRewriter()
    .on('slot[data-component]', {
      element(slot) {
        islands++
        slot.onEndTag(() => {
          islands--
        })
      },
    })
    .on('img', {
      element(img) {
        if (islands === 0)
          onImage(img)
      },
    })
}

// The `src` of each `img` outside an island with no `alt` of its own, no `aria-hidden` and no presentational role, that is an imported image a model is shown.
async function candidates(html: string): Promise<string[]> {
  const found: string[] = []

  const rewriter = serverImages((img) => {
    const src = img.getAttribute('src')

    if (src?.includes(IMPORTED) && SHOWN.test(src) && !img.hasAttribute('alt') && img.getAttribute('aria-hidden') !== 'true' && !['presentation', 'none'].includes(img.getAttribute('role') ?? ''))
      found.push(src)
  })

  await rewriter.transform(new Response(html)).text()

  return found
}

async function withAlts(html: string, alts: ReadonlyMap<string, string>): Promise<string> {
  const rewriter = serverImages((img) => {
    const alt = alts.get(img.getAttribute('src') ?? '')

    if (alt !== undefined && !img.hasAttribute('alt'))
      img.setAttribute('alt', alt)
  })

  return rewriter.transform(new Response(html)).text()
}

// The page with the alt each candidate image has, found by `altOf`; an image with none is left as it is.
async function filled(page: RenderedPage, altOf: (place: Place) => Promise<string | undefined>): Promise<string> {
  if (!page.html.includes(IMPORTED))
    return page.html

  const sources = [...new Set(await candidates(page.html))]

  if (sources.length === 0)
    return page.html

  const root = await serverRoot()
  const alts = new Map<string, string>()

  await Promise.all(sources.map(async (src) => {
    const path = await page.file(src)
    const alt = path === undefined ? undefined : await altOf({ root, path, locale: page.locale })

    if (alt !== undefined && alt !== '')
      alts.set(src, alt)
  }))

  return alts.size === 0 ? page.html : withAlts(page.html, alts)
}

// For a prerendered page: waits for the model to describe each image not kept yet, unless no model is configured.
export const writeImageAlts: PageHook = async page => filled(page, async place => await kept(place) ?? (modelConfigured() ? draftOnce(place) : undefined))

// For a page rendered per request, which never waits on the model: it takes the drafts kept and starts those missing in the background, for the next render.
export const writeKeptImageAlts: PageHook = async page => filled(page, async (place) => {
  const alt = await kept(place)

  if (alt === undefined && modelConfigured())
    void draftOnce(place)

  return alt
})

// The drafts kept so far, for a person to review: none is sent to the model again, and an author's own `alt` replaces one.
export async function draftProblems(): Promise<ExtensionProblem[]> {
  const root = await serverRoot()
  const { file } = libraryCacheSlot(root, LIBRARY, 'x', '')
  const folder = dirname(file)
  let names: string[]

  try {
    names = (await readdir(folder)).filter(name => name.endsWith('.json')).toSorted()
  }
  catch {
    return []
  }

  const kept = await Promise.all(names.map(async name => readDraft(`${folder}/${name}`)))

  return kept.flatMap(entry => entry === undefined || entry.alt === '' ? [] : [{ message: `imageAlt drafted the alt of ${entry.name}${entry.locale === '' ? '' : ` (${entry.locale})`}: "${entry.alt}"`, help: 'check it, then write the img\'s own alt to keep your wording; delete .kay/cache/libraries/kayjs-ai to draft again' }])
}

async function readDraft(file: string): Promise<Draft | undefined> {
  try {
    return (await Bun.file(file).json() as { value: Draft }).value
  }
  catch {
    return undefined
  }
}

// A warning for an app that asked for drafts with no model to make them.
export function noModelProblems(): ExtensionProblem[] {
  return modelConfigured() ? [] : [{ message: 'ai({ imageAlt: true }) has no model to draft with, so images keep the alt they were written with', help: 'set ANTHROPIC_API_KEY, OPENAI_API_KEY or AI_BASE_URL' }]
}
