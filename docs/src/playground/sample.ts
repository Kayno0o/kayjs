export const SAMPLE = `---
import { signal } from 'kay'

const count = signal(0)
---
button(onClick={() => count.update(n => n + 1)}) Clicked {count()} times
`
