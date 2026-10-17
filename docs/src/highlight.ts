import type { LanguageRegistration, ShikiTransformer } from 'shiki'
import kayGrammar from 'kay/kay.tmLanguage.json'
import { createCssVariablesTheme, createHighlighter } from 'shiki'

const kay: LanguageRegistration = { ...kayGrammar, name: 'kay', embeddedLangs: ['typescript'] }

// Every colour a CSS variable the palette picked sets, so code follows the theme with no second render.
const palette = createCssVariablesTheme({ name: 'palette' })

const highlighter = await createHighlighter({
  themes: [palette],
  langs: [kay, 'typescript', 'javascript', 'json', 'bash', 'css', 'html', 'toml', 'diff'],
})

const languages = new Set(highlighter.getLoadedLanguages())

// Runs at build time only; code-copy.kay answers the copy button.
export function highlight(code: string, language: string | undefined): string {
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

  return highlighter.codeToHtml(code, { lang, theme: 'palette', transformers: [framed] })
}
