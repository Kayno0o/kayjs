import { signal } from 'kay'

export function Counter({ start = 0 }: { start?: number }) {
  const count = signal(start)

  return (
    <button class="counter" onClick={() => count.value++}>
      Clicked {count.value}
    </button>
  )
}
