import { sanitizeHtml } from './sanitize'

const BUTTONS = /<button\b[\s\S]*?<\/button\s*>/gi
const STYLE = /(<[a-z][^<>]*?)\sstyle="/gi
const KEPT_STYLE = /(<[a-z][^<>]*?)\sdata-style="([^"]*)"/gi
// Colours, font style and weight, text decoration and custom properties (the variables of a Shiki theme), in a value that holds no URL, escape or quote: all a highlighter's spans need, and nothing that loads or covers the page.
const DECLARATION = /^\s*(?:color|background-color|font-style|font-weight|text-decoration|--[\w-]+)\s*:[\w#%.,\s()-]+$/i
const UNSAFE_VALUE = /url|expression|image|\bimport/i
const SANITIZE = {
  tags: ['div', 'span'],
  attributes: { div: ['class', 'data-style', 'data-search'], span: ['class', 'data-style'], pre: ['class', 'data-style', 'tabindex'], code: ['class'] },
}

function styled(markup: string): string {
  return markup.replace(KEPT_STYLE, (_, tag: string, value: string) => {
    const kept = value.split(';').filter(declaration => !UNSAFE_VALUE.test(declaration) && DECLARATION.test(declaration))

    return kept.length === 0 ? tag : `${tag} style="${kept.join(';')}"`
  })
}

// A highlighter's HTML kept to what code needs, without the copy button of a docs-style frame, which the page's listener would have to answer: its tags are sanitized as the rest of a reply is, and its `style` attributes, which `sanitizeHtml` never keeps, only when they hold colours.
export function safeCode(markup: string): string {
  return styled(String(sanitizeHtml(markup.replace(BUTTONS, '').replace(STYLE, '$1 data-style="'), SANITIZE)))
}
