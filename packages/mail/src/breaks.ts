import type { JSX } from 'kay'
import { escapeHtml } from './escape'

const LINE_BREAK = /\r\n|\r|\n/

// Text a visitor wrote, its line breaks written as `<br>`, which every client shows and the text part keeps.
export function withBreaks(text: string): JSX.Element {
  return { t: text.split(LINE_BREAK).map(escapeHtml).join('<br>') }
}
