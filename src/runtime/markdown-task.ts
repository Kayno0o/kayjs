const CHECKBOX = '<input type="checkbox" class="task-list-item-checkbox" disabled(?: checked)?>'
// A loose item holds its text in a paragraph after the box.
const LOOSE = new RegExp(`(<li class="task-list-item">)(${CHECKBOX})\\n<p>([\\s\\S]*?)</p>`, 'g')
// A tight item's text follows the box up to its line end, a nested list or the item's end.
const TIGHT = new RegExp(`(<li class="task-list-item">)(${CHECKBOX})([^\\n<]*(?:<(?!/li>|ul[ >]|ol[ >])[^\\n<]*)*)`, 'g')

const UNLABEL_LOOSE = new RegExp(`(<li class="task-list-item">)<p><label>(${CHECKBOX})([\\s\\S]*?)</label></p>`, 'g')
const UNLABEL_TIGHT = new RegExp(`(<li class="task-list-item">)<label>(${CHECKBOX})([\\s\\S]*?)</label>`, 'g')

// What `labelTasks` wrote, back to the plain checkbox, for HTML that is sanitized again.
export function unlabelTasks(html: string): string {
  return html.replace(UNLABEL_LOOSE, '$1$2\n<p>$3</p>').replace(UNLABEL_TIGHT, '$1$2$3')
}

// Markdown's task list HTML with each checkbox inside a `label` holding its item's text, so it has an accessible name; an item with no text before a block is left as it is.
export function labelTasks(html: string): string {
  return html
    .replace(LOOSE, (_, open: string, box: string, text: string) => `${open}<p><label>${box}${text}</label></p>`)
    .replace(TIGHT, (whole, open: string, box: string, text: string) => text.trim() === '' ? whole : `${open}<label>${box}${text}</label>`)
}
