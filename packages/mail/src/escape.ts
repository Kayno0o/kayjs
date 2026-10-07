const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }
const HTML_SPECIAL = /[&<>"']/g

export function escapeHtml(text: string): string {
  return text.replace(HTML_SPECIAL, char => HTML_ESCAPES[char]!)
}
