import { signal } from 'kay'

const GRAMMARS = [
  { id: 'orbit', label: 'Orbit', note: 'Starry sky, 1px hairlines, amber accent, cockpit states' },
  { id: 'editorial', label: 'Editorial', note: 'Ink on warm paper, serif display, top-ruled cards' },
  { id: 'workshop', label: 'Workshop', note: '2px ink frames, 5px offset shadow, tactile' },
  { id: 'console', label: 'Console', note: 'Dense monospace, crisp gridlines, dark-first' },
  { id: 'soft', label: 'Soft', note: 'Borderless tinted surfaces, pill controls' },
  { id: 'bare', label: 'Bare', note: 'Behavior & layout floor only' },
] as const

export function GrammarDemo() {
  const active = signal<string>('orbit')

  const pick = (id: string) => {
    active.value = id
    let link = document.getElementById('kui-live-grammar') as HTMLLinkElement | null
    if (!link) {
      link = document.createElement('link')
      link.id = 'kui-live-grammar'
      link.rel = 'stylesheet'
      document.head.appendChild(link)
    }
    link.href = `/grammars/${id}.css`
  }

  return (
    <div data-layout="stack" style="--ui-gap:1rem">
      <div data-layout="cluster" style="--ui-gap:0.45rem">
        {GRAMMARS.map(g => (
          <button
            key={g.id}
            type="button"
            data-ui="button"
            data-size="sm"
            data-tone={active.value === g.id ? 'accent' : undefined}
            data-variant={active.value === g.id ? 'solid' : 'outline'}
            title={g.note}
            onClick={() => pick(g.id)}
          >
            {g.label}
          </button>
        ))}
      </div>
      <p style="margin:0;font-family:var(--ui-font-mono);font-size:0.78rem;color:var(--ui-muted)">
        Active grammar: <strong style="color:var(--ui-accent)">{active.value}</strong> — eject with{' '}
        <code>kay ui-eject {active.value}</code>
      </p>
    </div>
  )
}
