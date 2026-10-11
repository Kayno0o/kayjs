import { createSignal } from 'solid-js'

export default function Counter(props: { start: number }) {
  const [count, setCount] = createSignal(props.start)

  return (
    <button class="counter" onClick={() => setCount(c => c + 1)}>
      Clicked
      {' '}
      {count()}
    </button>
  )
}
