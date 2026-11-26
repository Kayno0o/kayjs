import { signal } from '@kayjs/kay'

const GRAMMARS = [
  { id: 'editorial', label: 'Editorial', note: 'Ink on paper, serif, top-ruled cards' },
  { id: 'workshop', label: 'Workshop', note: '2px ink frames, 5px offset shadow, tactile' },
  { id: 'console', label: 'Console', note: 'Dense monospace, 1px gridlines, dark-first' },
  { id: 'soft', label: 'Soft', note: 'Borderless tinted surfaces, pill controls' },
  { id: 'orbit', label: 'Orbit', note: 'Starry sky, hairline surfaces, amber accent, cockpit states' },
  { id: 'bare', label: 'Bare', note: 'Unstyled behavior & layout floor only' },
] as const

export function GrammarSwitcher({ initial = 'editorial' }: { initial?: string }) {
  const current = signal(initial)

  const pick = (id: string) => {
    current.value = id
    const link = document.getElementById('kui-grammar') as HTMLLinkElement | null
    if (link)
      link.href = `/grammars/${id}.css`
    document.documentElement.dataset.grammar = id
  }

  return (
    <div data-layout="cluster" style="--ui-gap:0.4rem">
      {GRAMMARS.map(g => (
        <button
          key={g.id}
          type="button"
          data-ui="button"
          data-variant={current.value === g.id ? 'solid' : 'outline'}
          data-tone={current.value === g.id ? 'accent' : undefined}
          data-size="sm"
          title={g.note}
          onClick={() => pick(g.id)}
        >
          {g.label}
        </button>
      ))}
    </div>
  )
}
