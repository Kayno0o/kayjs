import type { ShikiTransformer, ThemeRegistration } from 'shiki'
import { createHighlighter } from 'shiki'

const surface = '#e4e9f1'

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
    const ch = Number.parseInt(hex.slice(at, at + 2), 16) / 255
    return ch <= 0.039_28 ? ch / 12.92 : ((ch + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function readable(hex: string): string {
  const channels = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16))
  let darker = hex
  for (let scale = 1; (luminance(surface) + 0.05) / (luminance(darker) + 0.05) < 4.5; scale -= 0.01) {
    darker = `#${channels.map(c => Math.round(c * scale).toString(16).padStart(2, '0')).join('')}`
  }
  return darker
}

interface Palette {
  text: string
  comment: string
  keyword: string
  string: string
  tag: string
  fn: string
  type: string
}

function orbitTheme(name: string, type: 'light' | 'dark', c: Palette): ThemeRegistration {
  return {
    name,
    type,
    colors: { 'editor.background': type === 'light' ? surface : '#10141e', 'editor.foreground': c.text },
    tokenColors: [
      { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.comment } },
      { scope: ['keyword', 'storage', 'keyword.operator.new', 'keyword.control'], settings: { foreground: c.keyword } },
      { scope: ['string', 'string.template', 'punctuation.definition.string'], settings: { foreground: c.string } },
      { scope: ['entity.name.tag', 'constant', 'constant.numeric', 'constant.language', 'support.constant'], settings: { foreground: c.tag } },
      { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'], settings: { foreground: c.fn } },
      { scope: ['entity.name.type', 'support.type', 'support.class', 'entity.other.attribute-name'], settings: { foreground: c.type } },
      { scope: ['keyword.operator', 'punctuation'], settings: { foreground: c.text } },
    ],
  }
}

const dark = orbitTheme('orbit-dark', 'dark', {
  text: '#dbe0ea',
  comment: '#7f889c',
  keyword: '#f5b83d',
  string: '#9fc2f2',
  tag: '#e8a6c8',
  fn: '#8fd3c7',
  type: '#f2d29b',
})

const light = orbitTheme(
  'orbit-light',
  'light',
  Object.fromEntries(
    Object.entries({
      text: '#141b2b',
      comment: '#566176',
      keyword: '#95580a',
      string: '#2b5a9a',
      tag: '#9a3a6c',
      fn: '#1f6f62',
      type: '#7a5a12',
    }).map(([k, hex]) => [k, readable(hex)]),
  ) as unknown as Palette,
)

const HL_KEY = Symbol.for('kay.docs.shiki')
const g = globalThis as Record<symbol, Awaited<ReturnType<typeof createHighlighter>> | undefined>
const highlighter = g[HL_KEY] ??= await createHighlighter({
  themes: [light, dark],
  langs: ['typescript', 'tsx', 'javascript', 'json', 'yaml', 'bash', 'css', 'html', 'diff'],
})

const loaded = new Set(highlighter.getLoadedLanguages())

export function highlight(code: string, language: string | undefined): string {
  const lang = language !== undefined && loaded.has(language) ? language : 'text'
  const labelled: ShikiTransformer = {
    pre(node) {
      if (lang !== 'text')
        node.properties['data-language'] = lang
    },
  }
  return highlighter.codeToHtml(code, {
    lang,
    themes: { light: light.name!, dark: dark.name! },
    defaultColor: 'light-dark()',
    transformers: [labelled],
  })
}
