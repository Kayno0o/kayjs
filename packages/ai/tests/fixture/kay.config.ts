import { ai } from '@kaynooo/kayjs-ai'
import { defineConfig } from 'kay/server'

const ESCAPED = /[&<>]/g
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }

// A highlighter as an app sets it: it escapes the code, and colours it with a style.
export default defineConfig({ extensions: [ai()], markdown: { highlight: (code, language) => `<pre class="hl"><code><span class="tok" style="color:#c00">${code.replace(ESCAPED, char => ESCAPES[char]!)}</span> ${language}</code></pre>` } })
