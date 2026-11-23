import type { KayChild } from 'kay'

export function Callout({ title, tone = 'info', children }: {
  title: string
  tone?: 'info' | 'tip' | 'warning' | undefined
  children?: KayChild
}) {
  return (
    <aside class="docs-callout" data-tone={tone}>
      <div class="docs-callout-title">{title}</div>
      <div>{children}</div>
    </aside>
  )
}
