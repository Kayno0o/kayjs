const CHECKBOX = '<input type="checkbox" class="task-list-item-checkbox" disabled(?: checked)?>'
// A loose item holds its text in a paragraph after the box.
const LOOSE = new RegExp(`(<li class="task-list-item">)(${CHECKBOX})\\n<p>([\\s\\S]*?)</p>`, 'g')
// A tight item's text follows the box over its continuation lines, up to a nested list, another block or the item's end.
const TIGHT = new RegExp(`(<li class="task-list-item">)(${CHECKBOX})([^<]*(?:<(?!/li>|(?:ul|ol|pre|blockquote|table|h[1-6]|p|hr|div)[ >/])[^<]*)*)`, 'g')
const TRAILING_SPACE = /\s+$/

// Markdown's task list HTML with each checkbox inside a `label` holding its item's text, so it has an accessible name; an item with no text before a block is left as it is.
export function labelTasks(html: string): string {
  return html
    .replace(LOOSE, (_, open: string, box: string, text: string) => `${open}<p><label>${box}${text}</label></p>`)
    .replace(TIGHT, (whole, open: string, box: string, text: string) => text.trim() === '' ? whole : `${open}<label>${box}${text.replace(TRAILING_SPACE, '')}</label>${TRAILING_SPACE.exec(text)?.[0] ?? ''}`)
}
