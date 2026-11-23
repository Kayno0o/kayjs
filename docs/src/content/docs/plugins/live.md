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

export interface BoardEvents {
  presence: { count: number }
  notice: { id: number, title: string, author: string }
}

export const rooms = createRooms<BoardEvents>({
  path: '/_live',
  coalescePresence: true,
})
```

Mount `rooms.plugin` in `kay.config.ts`, then broadcast from any server `action()` or API route:

```ts
rooms.publish('main', 'notice', { id: 1, title: 'Shipped v2!', author: 'Kévyn' })
```

## 2. Subscribe reactively in any island (`useLive`)

```tsx
import { useLive } from '@kayjs/live/client'
import type { BoardEvents } from '../live'

export function LiveBoard() {
  const { connected, data } = useLive<BoardEvents>('/_live?room=main', {
    presence: { count: 1 },
  })

  return (
    <p>
      {connected.value ? 'Live' : 'Connecting…'} · {data.value.presence.count} online
    </p>
  )
}
```

<Callout title="HTTP/2 & reverse-proxy safe" tone="info">
Kay sets `idleTimeout: 0` on `Bun.serve()`, emits periodic SSE `: ping` keepalives, cleans up aborted connections via `request.signal`, and avoids the HTTP/2-forbidden `Connection: keep-alive` header.
</Callout>
