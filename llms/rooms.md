# Rooms

## Common tasks

### Group websocket connections in rooms

`rooms()` from `kay/server` joins connections in a room and `publish` sends to everyone in it:

```ts
import { s } from 'kay'
import { api, rooms } from 'kay/server'

const chats = rooms<{ from: string, text: string }, string>()

export default api()
  .ws('/:room', {
    body: s.Object({ text: s.String() }),
    response: chats.response,
    open(ws) {
      chats.join(ws, ws.data.params.room, ws.data.user.name)
    },
    message(ws, { text }) {
      const room = ws.data.params.room

      chats.publish(room, { from: chats.memberOf(ws, room)!, text })
    },
    close(ws) {
      chats.leave(ws)
    },
  })
```

### Give a joiner the room's state

`rooms` keeps a state per room, and `snapshot` sends it to each connection as it joins, so a late joiner starts where the others are:

```ts
const live = rooms<{ round: number }, string, { round: number }>({
  state: () => ({ round: 0 }),
  snapshot: ({ round }) => ({ round }),
})

live.update(room, ({ round }) => ({ round: round + 1 }))
live.publish(room, live.state(room))
```

## Reference

### Rooms

Rooms group a module's websocket connections, such as a game's players or a document's editors:

```ts
import { dispatch, s } from 'kay'
import { api, rooms } from 'kay/server'

type Sent =
  | { type: 'said', from: string, text: string }
  | { type: 'board', cells: string[] }

const games = rooms<Sent, string, { cells: string[] }>({
  state: () => ({ cells: [] }),
  snapshot: ({ cells }) => ({ type: 'board', cells }),
})
const sendBoard = games.coalesce(room => ({
  type: 'board',
  cells: games.state(room).cells,
}))

export default api()
  .ws('/:room', {
    body: s.Union([
      s.Object({ type: s.Literal('say'), text: s.String() }),
      s.Object({ type: s.Literal('play'), cell: s.Integer() }),
    ]),
    open(ws) {
      games.join(ws, ws.data.params.room, ws.data.user.name)
    },
    message(ws, body) {
      const room = ws.data.params.room

      dispatch(body, {
        say: ({ text }) => games.publish(
          room,
          { type: 'said', from: ws.data.user.name, text },
          { except: ws },
        ),
        play: ({ cell }) => {
          games.update(room, ({ cells }) => ({ cells: [...cells, ws.data.user.name + cell] }))
          sendBoard(room)
        },
      })
    },
    close(ws) {
      games.leave(ws)
    },
  })
```

- `rooms<Message, Member, State>(options)` from `kay/server` keeps rooms of connections, `Message` what is sent to them, `Member` what each is listed as and `State` what the room remembers.
- `join(ws, room, member)` puts a connection in a room, joining again replacing its member.
- `leave(ws, room)` takes it out, and `leave(ws)` out of every room, as `close` does.
- `members(room)` lists the members, `roomsOf(ws)` the rooms a connection is in, and `memberOf(ws, room)` the member it joined `room` as, `undefined` for a room it is not in or a join with no member: who sent the message a handler is acting on.
- A room no one is in is gone.
- `rooms({ state: () => initial, snapshot: (state, room) => message })` keeps a state per room, `State` required once it is typed: `state(room)` reads it, `initial()` while no `update` made another, passed through JSON as a stored state is, and `update(room, state => next)` replaces it with what the function returns, resolving with the new state.
- Each `update` reads the latest state, one at a time, with `sqliteRooms` across every process sharing the file, so two updates never overwrite each other; its function runs in that turn, so it is quick and reads only its argument. Nothing is sent: publish the change, or `snapshot`'s message, as `publish(room, message)`.
- `snapshot` sends a connection joining the message it makes from the state as it then stands, to that connection alone and after it is listed, again each time it joins (a reconnect says `join` again): an update made while it joins reaches it in the snapshot or as what is published after, never neither, so publish whole states or changes that are safe to apply twice.
- The state is JSON, kept whole: a `Date` comes back as text, an `update` returning no JSON throws and keeps the old state, and a big state costs every `update` its size.
- Only the app's own code writes it, never a client's message, which `update` may read.
- A room's state goes with its last member, any process's, as the dropped members of a crashed process count; an `update` to a room no one is in resolves with the state it computed and stores nothing, so a room a client names costs no state.
- Without `state` and `snapshot`, nothing changes: no state is kept and nothing is sent on a join.
- A custom `RoomStore` gives `state(room)` and `update(room, change)` to keep states, both on JSON text, else `rooms({ state })` throws.
- `publish(room, message, { except, to })` sends a message to everyone in the room, but the connection `except` names, such as the sender, or only to the connections joined as the member `to` names, such as a game's host, compared as JSON.
- It goes out as Elysia sends one, a string as it is and anything else as JSON, not checked against the route's `response`.
- `response: chats.response` on the ws route types the messages an island's `socket()` receives (`last()`, `on()`) as the rooms' `Message`, so the union is written once, in `rooms<Message>()`; it accepts any message and checks nothing. A ws route with a `body` and no `response` types them `unknown`, which a cast then papers over.
- `coalesce(read, { wait })` gives a function sending a room one snapshot `read(room)` makes when it goes, however many times it is called within `wait`, a duration, `'50ms'` by default: a burst of moves sends the board once, as it stands.
- `dispatch(message, handlers)` from `kay` calls the handler a message's `type` names with the message, typed to that variant, and gives what it returns.
- The handlers cover every type, as the compiler checks, and a type none names, such as one a newer server sends, throws.
- `dispatch` works on the server's `body` and on what an island's `socket` receives, `messages.on(message => dispatch(message, { ... }))`.
- Rooms live in the process's memory by default.
- `rooms({ store: sqliteRooms('data/rooms.sqlite') })` shares them between every process of the machine opening the file, as `sqliteJobs` does: `members` lists those connected to any of them, and a message published in one reaches the others as the file changes, and at worst within `poll`, a duration, `'250ms'` by default (`'25ms'` where the folder cannot be watched).
- A process listens from its first `join` on, never handed what was published before.
- A process that stops without its connections leaving, such as one that crashed, has its members dropped once it has not been heard from for 10 seconds; one only stalled that long writes them back on its next heartbeat. A process with no connection joined neither beats nor polls, so an idle one costs the file nothing.
- `close()` on the store stops its timers and lets go of the file.
- Rooms do not reach other machines.
