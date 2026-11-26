---
title: "@kayjs/live"
description: Zero-dependency typed Server-Sent Events (SSE) rooms, microtask-coalesced presence broadcasts, and reactive useLive() browser signal hooks.
section: plugins
order: 4
---

`@kayjs/live` adds real-time push updates and online presence over standard HTTP Server-Sent Events (`text/event-stream`) in ~280 LOC with **zero external dependencies** and no WebSocket proxy headaches.

## 1. Create typed rooms on the server

```ts
// src/live.ts
import { createRooms } from '@kayjs/live'

export type BoardMessage
  = | { type: 'presence', count: number }
    | { type: 'notice', title: string }

export const rooms = createRooms<BoardMessage, string>({
  path: '/_live',
  room: ctx => ctx.url.searchParams.get('room') ?? 'main',
  member: () => 'guest',
  onJoin: room => presence(room),
  onLeave: room => presence(room),
})

// One broadcast per room and microtask, however many clients join at once.
const presence = rooms.coalesce((room): BoardMessage => ({ type: 'presence', count: rooms.size(room) }))
```

Register `rooms` in `kay.config.ts` (`plugins: [rooms]`): it mounts the stream at `path`. Without `path`, nothing is mounted and a route opens streams itself with `rooms.stream(ctx, { room, member })`. Broadcast from any server `action()` or API route:

```ts
rooms.publish('main', { type: 'notice', title: 'Shipped v2!' })
```

## 2. Subscribe reactively in any island (`useLive`)

```tsx
import { signal } from '@kayjs/kay'
import { useLive } from '@kayjs/live/client'
import type { BoardMessage } from '../live'

export function LiveBoard() {
  const online = signal(0)
  const live = useLive<BoardMessage>('/_live?room=main', (message) => {
    if (message.type === 'presence')
      online.value = message.count
  })

  return (
    <p>
      {live.status.value === 'open' ? 'Live' : 'Connecting…'} · {online.value} online
    </p>
  )
}
```

<Callout title="HTTP/2 & reverse-proxy safe" tone="info">
Kay sets `idleTimeout: 0` on `Bun.serve()`, emits periodic SSE `: ping` keepalives, cleans up aborted connections via `request.signal`, and avoids the HTTP/2-forbidden `Connection: keep-alive` header.
</Callout>
