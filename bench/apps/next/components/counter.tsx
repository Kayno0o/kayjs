'use client'

import { useState } from 'react'

export function Counter({ start }: { start: number }) {
  const [count, setCount] = useState(start)

  return (
    <button className="counter" onClick={() => setCount(c => c + 1)}>
      Clicked
      {' '}
      {count}
    </button>
  )
}
