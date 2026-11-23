import type { KayChild } from 'kay'

export function Tabs({ label = 'Code examples', children }: { label?: string, children?: KayChild }) {
  return (
    <div class="md-tabs" role="group" aria-label={label}>
      {children}
    </div>
  )
}
