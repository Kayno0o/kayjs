import { onCleanup, onMount, signal } from 'kay'

interface Claimant {
  me: symbol
  // The extension's own host, which any component an app renders itself outranks whenever it mounts.
  fallback: boolean
}

// The jobs only one mounted component on the page should do, each with the components queued for it.
const claimants = { toaster: signal<Claimant[]>([]), tooltips: signal<Claimant[]>([]) }

export type Job = keyof typeof claimants

// Queues the calling component for `job` while it is mounted, and reads whether it does the job: the first mounted does, the next takes over once it unmounts, and a `fallback` one only does it while no other is mounted, as islands hydrate in no fixed order and the extension's host must not win over the app's own for being quicker. Before any is mounted, as on the server, every one does, so hydration finds the markup it rendered.
export function claim(job: Job, fallback = false): () => boolean {
  const me = Symbol(job)
  const queue = claimants[job]

  onMount(() => {
    queue.set(list => [...list, { me, fallback }])

    onCleanup(() => queue.set(list => list.filter(item => item.me !== me)))
  })

  return () => {
    const list = queue()
    const first = list.find(item => !item.fallback) ?? list[0]

    return first === undefined || first.me === me
  }
}
