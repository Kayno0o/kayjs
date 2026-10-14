import type { LanguageRegistration, ShikiTransformer } from 'shiki'
import kayGrammar from 'kay/kay.tmLanguage.json'
import { createHighlighter } from 'shiki'

const kay: LanguageRegistration = { ...kayGrammar, name: 'kay', embeddedLangs: ['typescript'] }

const highlighter = await createHighlighter({
  themes: ['github-light-default', 'ayu-mirage'],
  langs: [kay, 'typescript', 'javascript', 'json', 'bash', 'css', 'html', 'toml', 'diff'],
})

const languages = new Set(highlighter.getLoadedLanguages())
// The colours under 4.5:1 on the code's ground, each darkened or lightened until it reads: comments and keywords in the light theme, comments in the dark one.
const READABLE = { 'github-light-default': { '#6e7781': '#57606a', '#8250df': '#6639ba' }, 'ayu-mirage': { '#6e7c8f': '#8a96a8' } }

// Runs at build time only; light-dark() lets the page's color-scheme pick the theme with no script, and code-copy.kay answers the copy button.
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
            properties: { class: 'code-bar' },
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

  return highlighter.codeToHtml(code, { lang, themes: { light: 'github-light-default', dark: 'ayu-mirage' }, colorReplacements: READABLE, defaultColor: 'light-dark()', transformers: [framed] })
}
