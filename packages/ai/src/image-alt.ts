import type { ExtensionProblem, PageHook } from 'kay/server'
// Alt text drafted for the imported images of a page: one model call per image content, kept under `.kay/cache`, written into the HTML as a page is built or served.
import type { Attachment, Message } from './types'
import { readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import process from 'node:process'
import { s } from 'kay'
import { libraryCacheSlot, readCacheEntry, serverRoot, writeCacheEntry } from 'kay/library'
import { ask } from './ask'
import { choose } from './config'
import { fakeAi } from './fake'

const LIBRARY = 'kayjs-ai'
// Part of what a draft is made from, so a changed prompt drafts again.
const PROMPT_VERSION = '1'
const ASSETS = '/_kay/assets/'
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

// What a draft for an image is made once for, however many pages show it and however many renders: in flight or done, by its cache file.
const drafts = new Map<string, Promise<string | undefined>>()

async function draft(root: string, path: string, locale: string): Promise<string | undefined> {
  const name = basename(path)
  const slot = libraryCacheSlot(root, LIBRARY, Bun.hash(`${name}\0${locale}`).toString(36), PROMPT_VERSION)
  const kept = await readCacheEntry<Draft>(slot)

  if (kept !== undefined)
    return kept.alt === '' ? undefined : kept.alt

  if (!modelConfigured())
    return undefined

  const alt = await describeImage(Bun.file(path), { language: locale })

  await writeCacheEntry(slot, { alt, name, locale } satisfies Draft)

  return alt === '' ? undefined : alt
}

async function draftOnce(root: string, path: string, locale: string): Promise<string | undefined> {
  const id = `${root}\0${path}\0${locale}`
  let drafting = drafts.get(id)

  if (drafting === undefined) {
    drafting = safeDraft(root, path, locale, id)
    drafts.set(id, drafting)
  }

  return drafting
}

// A call that fails leaves the image as it is and is tried again by the next render.
async function safeDraft(root: string, path: string, locale: string, id: string): Promise<string | undefined> {
  try {
    return await draft(root, path, locale)
  }
  catch {
    drafts.delete(id)

    return undefined
  }
}

// The `src` of each `img` outside an island with no `alt` of its own, no `aria-hidden` and no presentational role, that is an imported image.
async function candidates(html: string): Promise<string[]> {
  const found: string[] = []
  let islands = 0

  const rewriter = new HTMLRewriter()
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
        const src = img.getAttribute('src')

        if (islands === 0 && src?.includes(ASSETS) && !img.hasAttribute('alt') && img.getAttribute('aria-hidden') !== 'true' && !['presentation', 'none'].includes(img.getAttribute('role') ?? ''))
          found.push(src)
      },
    })

  await rewriter.transform(new Response(html)).text()

  return found
}

async function withAlts(html: string, alts: ReadonlyMap<string, string>): Promise<string> {
  let islands = 0

  const rewriter = new HTMLRewriter()
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
        const alt = alts.get(img.getAttribute('src') ?? '')

        if (islands === 0 && alt !== undefined && !img.hasAttribute('alt'))
          img.setAttribute('alt', alt)
      },
    })

  return rewriter.transform(new Response(html)).text()
}

// The page with a drafted `alt` on each server-rendered `img` of an imported image that has none; a page without such an image is returned as it is, and one with no model configured gets the drafts already kept.
export const writeImageAlts: PageHook = async (page) => {
  if (!page.html.includes(ASSETS))
    return page.html

  const sources = [...new Set(await candidates(page.html))]

  if (sources.length === 0)
    return page.html

  const root = await serverRoot()
  const alts = new Map<string, string>()

  await Promise.all(sources.map(async (src) => {
    const path = await page.file(src)
    const alt = path === undefined ? undefined : await draftOnce(root, path, page.locale)

    if (alt !== undefined)
      alts.set(src, alt)
  }))

  return alts.size === 0 ? page.html : withAlts(page.html, alts)
}

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
