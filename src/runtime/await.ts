import type { AwaitProps } from './checks'
import type { JSX } from './jsx'
import { fragment, markers } from './dom'
import { awaited } from './dom-await'

// Compiled islands bind `await` blocks themselves; this is the component form, for code that builds one by hand.
export function Await<T>(props: AwaitProps<T>): JSX.Element {
  return fragment((parent) => {
    const [start, end] = markers(parent)

    awaited(null, start, end, () => props.value, props.pending && (() => props.pending!()), value => props.ready(value as never), props.failed && (error => props.failed!(error)), props.fallback && (error => props.fallback!(error)))
  })
}
