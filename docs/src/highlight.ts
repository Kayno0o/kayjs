import type { LanguageRegistration, ShikiTransformer } from 'shiki'
import kayGrammar from 'kay/kay.tmLanguage.json'
import { createCssVariablesTheme, createHighlighter } from 'shiki'

const kay: LanguageRegistration = { ...kayGrammar, name: 'kay', embeddedLangs: ['typescript'] }

// Every colour a CSS variable the palette picked sets, so code follows the theme with no second render.
const palette = createCssVariablesTheme({ name: 'palette' })

// Created on the first block, so loading the config alone (kay check, dev and start) pays nothing for Shiki.
let ready: ReturnType<typeof load> | undefined

async function load() {
  const highlighter = await createHighlighter({
    themes: [palette],
    langs: [kay, 'typescript', 'javascript', 'json', 'bash', 'css', 'html', 'toml', 'diff'],
  })

  return { highlighter, languages: new Set(highlighter.getLoadedLanguages()) }
}

// Runs when the content compiles and, for the chat's answers, on the server per finished code block (which drops the copy button); code-copy.kay answers the copy button on the pages.
export async function highlight(code: string, language: string | undefined): Promise<string> {
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

  return highlighter.codeToHtml(code, { lang, theme: 'palette', transformers: [framed] })
}
