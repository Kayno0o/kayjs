import { signal } from '@kayjs/kay'

export function Counter({ initial = 0 }: { initial?: number }) {
  const count = signal(initial)
  return (
    <button type="button" onClick={() => count.value++}>
      Count: {count.value}
    </button>
  )
}
