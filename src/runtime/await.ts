import type { JSX } from '@solidjs/web'
import type { AwaitProps } from './checks'
import { createComponent, createMemo, Errored, Loading } from 'solid-js'

// Solid's own async rendering, used in the browser and for islands on the server: a memo holding a promise suspends the nearest `Loading`.
export function Await<T>(props: AwaitProps<T>): JSX.Element {
  const value = createMemo(() => props.value)
  const loading = () => createComponent(Loading, {
    get fallback() {
      return props.pending?.()
    },
    get children() {
      return props.ready(value() as Awaited<T>)
    },
  })

  if (!props.failed)
    return loading()

  const failed = props.failed

  return createComponent(Errored, {
    fallback: (error: () => unknown) => failed(error()),
    get children() {
      return loading()
    },
  })
}
