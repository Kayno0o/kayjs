import type { JSX } from '@solidjs/web'
import type { AwaitProps } from './checks'
import { awaited, fragment, markers } from './dom'

// Compiled islands bind `await` blocks themselves; this is the component form, for code that builds one by hand.
export function Await<T>(props: AwaitProps<T>): JSX.Element {
  return fragment((parent) => {
    const [start, end] = markers(parent)

    awaited(null, start, end, () => props.value, props.pending && (() => props.pending!()), value => props.ready(value as Awaited<T>), props.failed && (error => props.failed!(error)))
  }) as unknown as JSX.Element
}
