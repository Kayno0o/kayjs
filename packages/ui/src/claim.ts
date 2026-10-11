import { onCleanup, onMount, signal } from 'kay'

// The jobs only one mounted component on the page should do, each with the components queued for it.
const claimants = { toaster: signal<symbol[]>([]), tooltips: signal<symbol[]>([]) }

export type Job = keyof typeof claimants

// Queues the calling component for `job` while it is mounted, and reads whether it does the job: the first mounted does, and the next takes over once it unmounts. Before any is mounted, as on the server, every one does, so hydration finds the markup it rendered.
export function claim(job: Job): () => boolean {
  const me = Symbol(job)
  const queue = claimants[job]

  onMount(() => {
    queue.set(list => [...list, me])

    onCleanup(() => queue.set(list => list.filter(item => item !== me)))
  })

  return () => {
    const first = queue()[0]

    return first === undefined || first === me
  }
}
