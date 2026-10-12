import { render } from './dom'
import { freshPrefix, withIds } from './uid'

// A component's props, optional when it takes none.
type PropsOf<P> = object extends P ? [props?: P] : [props: P]

// Renders a component into `element`, on a page kay does not serve, as an island renders but with no server markup to hydrate. Returns what disposes it: its effects and cleanups end and `element` is emptied.
export function mount<P extends object>(component: (props: P) => unknown, element: Element, ...[props]: PropsOf<P>): () => void {
  const ids = freshPrefix()

  return render(() => withIds(ids, () => component(props ?? {} as P)), element)
}
