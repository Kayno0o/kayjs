import type { PinnedNotice } from '../db'
import type { BoardMessage } from '../services'
import { useLive } from '@kayjs/live/client'
import { toast } from '@kayjs/ui'
import { signal } from '@kayjs/kay'

export interface LiveBoardProps {
  initialNotices: PinnedNotice[]
  me: string | null
}

function formatReaders(names: string[], guests: number): string {
  const who = [...names, ...(guests === 0 ? [] : [guests === 1 ? 'a guest' : `${guests} guests`])]
  return who.length === 0 ? 'Nobody is reading' : `Reading now: ${who.join(', ')}`
}

export function LiveBoard({ initialNotices, me }: LiveBoardProps) {
  const notices = signal<PinnedNotice[]>(initialNotices)
  const names = signal<string[]>([])
  const guests = signal(0)

  const live = useLive<BoardMessage>('/api/board', (msg) => {
    if (msg.type === 'present') {
      names.value = msg.names
      guests.value = msg.guests
    }
    else if (msg.type === 'posted') {
      if (!notices.value.some(n => n.id === msg.notice.id))
        notices.value = [msg.notice, ...notices.value]
      if (msg.notice.author !== me)
        toast.info(`${msg.notice.author} pinned "${msg.notice.title}"`)
    }
  })

  return (
    <div data-layout="stack" style="--ui-gap:1.25rem">
      <p id="presence" aria-live="polite" style="margin:0;font-size:0.88rem;color:var(--ui-muted)">
        {live.status.value === 'open' ? formatReaders(names.value, guests.value) : 'Connecting...'}
      </p>

      {notices.value.length === 0
        ? (
            <div data-ui="notice" role="note">
              <strong>Nothing pinned yet.</strong> Sign in to pin the first notice.
            </div>
          )
        : (
            <div id="notice-list" data-layout="stack" style="--ui-gap:1rem">
              {notices.value.map(n => (
                <section key={n.id} data-ui="card">
                  <header data-part="header">{n.title}</header>
                  <div data-part="body">
                    <p style="margin:0;white-space:pre-line">{n.body}</p>
                  </div>
                  <footer data-part="footer">
                    <span>{n.author}</span>
                    {' · '}
                    <a href={`/notices/${n.id}`}>{n.postedAt.slice(0, 10)}</a>
                  </footer>
                </section>
              ))}
            </div>
          )}
    </div>
  )
}
