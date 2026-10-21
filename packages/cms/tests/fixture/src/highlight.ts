const ESCAPED: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

// A highlighter in Shiki's shape: a `pre` with colours in `style` attributes, which a page keeps and a preview must keep only as colours.
export function highlight(code: string, language?: string): string {
  const text = code.replace(/[&<>]/g, char => ESCAPED[char]!)

  return `<pre class="shiki" style="color:#123456" data-language="${language ?? ''}"><code><span class="line" style="color:#ff0000; background:url(javascript:alert(1))">${text}</span><span onclick="alert(2)"></span></code></pre>`
}
