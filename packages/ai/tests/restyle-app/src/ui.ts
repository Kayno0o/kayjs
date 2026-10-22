import { defineUi } from 'kay'

// The restyle test reads these classes back from the page of the chat.
export default defineUi({
  '@kaynooo/kayjs-ai/chat.kay': {
    parts: { root: 'rounded-xl', greeting: 'italic', suggestion: 'uppercase', turn: 'text-base', send: 'size-12' },
    variants: { tone: { neutral: { root: 'opacity-90' } } },
  },
  '@kaynooo/kayjs-ai/chat-calls.kay': { parts: { summary: 'font-bold', name: 'tracking-wide' } },
  '@kaynooo/kayjs-ai/chat-panel.kay': { parts: { panel: 'shadow-2xl', button: 'size-16' } },
})
