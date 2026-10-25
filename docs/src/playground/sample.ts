export const SAMPLE = `---
import { signal } from 'kay'

const count = signal(0)
---
button(onClick={() => count++}) Clicked {count()} times
`
