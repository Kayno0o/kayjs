import type { LanguageRegistration, ShikiTransformer } from 'shiki'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import kayGrammar from 'kay/kay.tmLanguage.json'
import { createCssVariablesTheme, createHighlighter } from 'shiki'

const kay: LanguageRegistration = { ...kayGrammar, name: 'kay', embeddedLangs: ['typescript'] }

// Every colour a CSS variable the palette picked sets, so code follows the theme with no second render.
const palette = createCssVariablesTheme({ name: 'palette' })

const LANGUAGES = [kay, 'typescript', 'javascript', 'json', 'bash', 'css', 'html', 'toml', 'diff']

// Created on the first block, so loading the config alone (kay check, dev and start) pays nothing for Shiki, nor does a build whose blocks were all highlighted before.
let ready: ReturnType<typeof load> | undefined

async function load() {
  const highlighter = await createHighlighter({ themes: [palette], langs: LANGUAGES })

  return { highlighter, languages: new Set(highlighter.getLoadedLanguages()) }
}

// The HTML of each block an earlier build highlighted, by a hash of its language and code, kept while nothing that shapes the HTML changes.
const CACHE_FILE = join(import.meta.dir, '../.kay/cache/highlight.json')
const MAX_ENTRIES = 5000
const used = new Set<string>()
let cache: ReturnType<typeof readCache> | undefined
let remembered: { version: string, html: Map<string, string> } | undefined
let flushing: ReturnType<typeof setTimeout> | undefined

// Shiki's package.json is not exported, so it is read next to the entry that is.
async function shikiVersion(): Promise<string> {
  const entry = Bun.resolveSync('shiki', import.meta.dir)

  return (await Bun.file(join(dirname(entry), '../package.json')).json() as { version: string }).version
}

async function readCache() {
  const version = Bun.hash(JSON.stringify([await shikiVersion(), palette, LANGUAGES, String(highlight)])).toString(36)

  try {
    const stored = await Bun.file(CACHE_FILE).json() as { version: string, html: Record<string, string> }

    if (stored.version === version)
      return remembered = { version, html: new Map(Object.entries(stored.html)) }
  }
  catch {}

  return remembered = { version, html: new Map() }
}

// A read-only disk only loses the cache. Past the cap, what this process did not use goes.
function flush() {
  clearTimeout(flushing)
  flushing = undefined

  if (!remembered)
    return

  const { version, html } = remembered
  const kept = html.size > MAX_ENTRIES ? [...html].filter(([key]) => used.has(key)) : [...html]

  try {
    const draft = `${CACHE_FILE}.${process.pid}.tmp`

    mkdirSync(dirname(CACHE_FILE), { recursive: true })
    writeFileSync(draft, JSON.stringify({ version, html: Object.fromEntries(kept) }))
    renameSync(draft, CACHE_FILE)
  }
  catch {}
}

function schedule() {
  if (flushing)
    return

  flushing = setTimeout(flush, 1000)
  flushing.unref()
}

process.on('exit', () => {
  if (flushing)
    flush()
})

// Runs when the content compiles and, for the chat's answers, on the server per finished code block (which drops the copy button); code-copy.kay answers the copy button on the pages.
export async function highlight(code: string, language: string | undefined): Promise<string> {
  const { html } = await (cache ??= readCache())
  const key = Bun.hash(`${language}\0${code}`).toString(36)
  const known = html.get(key)

  used.add(key)

  if (known !== undefined)
    return known

  const { highlighter, languages } = await (ready ??= load())
  const lang = language !== undefined && languages.has(language) ? language : 'text'
  // Inside the function: kay caches compiled pages by this function's source, so a change here recompiles them.
  const framed: ShikiTransformer = {
    root(node) {
      node.children = [{
        type: 'element',
        tagName: 'div',
        properties: { class: 'code' },
        children: [
          {
            type: 'element',
            tagName: 'div',
            properties: { 'class': 'code-bar', 'data-search': 'false' },
            children: [
              { type: 'element', tagName: 'span', properties: {}, children: [{ type: 'text', value: lang === 'text' ? '' : lang }] },
              // The classes copy-button.kay draws CopyButton with; components/code-copy.kay answers the click.
              { type: 'element', tagName: 'button', properties: { 'type': 'button', 'class': 'kui-btn kui-copy-btn', 'data-copy': '' }, children: [{ type: 'text', value: 'Copy' }] },
            ],
          },
          ...node.children.filter(child => child.type === 'element'),
        ],
      }]
    },
  }

  const rendered = highlighter.codeToHtml(code, { lang, theme: 'palette', transformers: [framed] })

  html.set(key, rendered)
  schedule()

  return rendered
}
