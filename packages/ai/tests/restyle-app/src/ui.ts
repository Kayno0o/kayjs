import { defineUi } from 'kay'

// The restyle test reads these classes back from the page of the chat.
export default defineUi({
  '@kayjs/ai/chat.kay': {
    parts: { root: 'rounded-xl', greeting: 'italic', suggestion: 'uppercase', turn: 'text-base', send: 'size-12' },
    variants: { tone: { neutral: { root: 'opacity-90' } } },
  },
  '@kayjs/ai/chat-calls.kay': { parts: { summary: 'font-bold', name: 'tracking-wide', toolIcon: 'opacity-70' } },
  '@kayjs/ai/chat-sources.kay': { parts: { label: 'uppercase', list: 'list-decimal', item: 'py-1', link: 'underline' } },
  '@kayjs/ui/side-panel.kay': { parts: { root: 'shadow-2xl', launcher: 'size-16' } },
})
