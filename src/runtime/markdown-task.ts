const CHECKBOX = '<input type="checkbox" class="task-list-item-checkbox" disabled(?: checked)?>'
// A loose item holds its text in a paragraph after the box.
const LOOSE = new RegExp(`(<li class="task-list-item">)(${CHECKBOX})\\n<p>([\\s\\S]*?)</p>`, 'g')
// A tight item's text follows the box over its continuation lines, up to a nested list, another block or the item's end.
const TIGHT = new RegExp(`(<li class="task-list-item">)(${CHECKBOX})([^<]*(?:<(?!/li>|(?:ul|ol|pre|blockquote|table|h[1-6]|p|hr|div)[ >/])[^<]*)*)`, 'g')
const TRAILING_SPACE = /\s+$/

// A box with no text to name it says nothing a screen reader could attach to anything, so it is hidden from one.
const hidden = (box: string) => box.replace('<input ', '<input aria-hidden="true" ')

// Markdown's task list HTML with each checkbox inside a `label` holding its item's text, so it has an accessible name; the box of an item with no text is hidden from a screen reader instead.
export function labelTasks(html: string): string {
  return html
    .replace(LOOSE, (_, open: string, box: string, text: string) => text.trim() === '' ? `${open}<p>${hidden(box)}${text}</p>` : `${open}<p><label>${box}${text}</label></p>`)
    .replace(TIGHT, (_, open: string, box: string, text: string) => text.trim() === '' ? `${open}${hidden(box)}${text}` : `${open}<label>${box}${text.replace(TRAILING_SPACE, '')}</label>${TRAILING_SPACE.exec(text)?.[0] ?? ''}`)
}
