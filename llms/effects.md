# Effects and lifecycle

How a component runs code after its render, when a value changes, on a timer or on a window event, and how each of these stops; props, signals and the rest of a component are in [Components](components.md).

## Common tasks

### Run code when a value changes

`effect` runs once the render is done, in the browser, and again whenever a signal it read changes:

```kay
---
import { signal, effect } from 'kay'

const query = signal('')

effect(() => {
  localStorage.setItem('query', query())
})
---
input(bind:value={query} aria-label="Search")
```

### React to a change, or to typing once it pauses

`watch` from `kay` runs on each change of what it watches, not on its first read, handed the value before; `debounced` gives a value once it has stopped changing for a while:

```kay
---
import { debounced, watch, signal, onCleanup } from 'kay'

const typed = signal('')
const found = signal<string[]>([])

watch(debounced(typed, '300ms'), async (query) => {
  // Registered before the await: a slower answer to an older query is dropped.
  let stale = false

  onCleanup(() => stale = true)

  const people = query === '' ? [] : await (await fetch(`/api/people?q=${encodeURIComponent(query)}`)).json()

  if (!stale)
    found = people
})
---
input(bind:value={typed} aria-label="Search people")
ul
  for name of found()
    li {name}
```

### Run code on a timer or a window event

`every` and `listen` from `kay` run while the island lives, never on the server:

```kay
---
import { every, listen, signal } from 'kay'

const seconds = signal(0)
const key = signal('')

every('1s', () => seconds++)
listen(window, 'keydown', event => key = event.key)
---
p {seconds()}s on the page, last key {key()}
```

## Reference

- `effect(fn)` runs once the render is done and again whenever what it read changes.
- `onMount`, `onCleanup`, `untrack`, `batch`, `root` and `flush` come from `kay` too.
- A function an `effect` or `onMount` callback returns runs as its cleanup, as one passed to `onCleanup` does: `effect(() => { const t = setInterval(tick, 1000); return () => clearInterval(t) })`.
- `effect`, `watch`, `every`, `listen` and `onCleanup` run with no owner at a module's top level, after an `await`, or in a timer: nothing stops the first four, which live until the page goes, and `onCleanup` drops its function. In development each logs a `[kay]` warning naming it, once, and `kay check` reports a call in an inline handler (one more per event), a timer, a promise callback or after an `await` as the `unowned-effect` lint; `root(fn)` is the owner to give them.
- An event handler runs under the owner it was bound in, the enclosing block or component, so an `onCleanup` it registers runs when that goes.
- An `onCleanup` that throws is logged and handed to the page's error report (`reportError`), never to an `onError` or `catch` boundary, and the owner's other cleanups and children still end.
- `root(fn)` runs `fn(dispose)` under an owner of its own, not attached to the one it was called under: the effects and `onCleanup`s created inside live until `dispose()` is called, and `root` returns what `fn` returns. It is for code with no component to stop it, such as a module-level subscription.
- `every`, `watch`, `listen`, `shortcut`, `guardLeave`, `followLog` and `presence` each return a function that stops them before the island ends (twice is harmless), and take `{ signal }` to stop on abort (an aborted one starts nothing). `followLog` and `presence` return an object that is that function too: after `room()`, `others()` is empty.
- A write applies at once; the effects it touches run together in a microtask, or right away through `flush()`. An effect writing what it reads, on every run, is stopped after 1000 rounds with a `[kay]` error that names it in development (several effects feeding each other are all stopped); the other effects of the page keep running, and a stopped one runs again when what it reads changes.
- `durationMs('3s')` from `kay` is the milliseconds a duration written with its unit stands for, `'250ms'` 250 and `'2m'` 120000, for a timer of your own: a bare number throws, and a text that is no duration gives `NaN`.
- `every(interval, run, { while })` from `kay` runs `run` every `interval`, a duration such as `'3s'` or `'250ms'`, while the island lives, and while `while`, read as an effect reads, holds: the timer starts and stops as it turns, never on the server.
- `every` skips a tick while the promise the last run returned is pending.
- `every(interval, run, { immediate: true })` runs it as the timer starts too, rather than one interval later.
- `every` pauses while the tab is hidden and runs once as it shows again; `{ background: true }` keeps it running hidden. An interval under 1 ms or over 24 days, or one that is not a number or a duration string (`'3 s'`), throws.
- `every('3s', refresh, { while: () => issuing })` polls the page, `every('1s', () => now = Date.now())` ticks a clock, and a bare number throws.
- `watch(source, (next, previous) => ...)` from `kay` runs on each change of `source`, a signal or a function reading some, not on its first read: no hand-kept previous value to compare against.
- `watch` tracks only `source`, never what its callback reads; a read giving the same value runs nothing, and what the callback registers with `onCleanup` stays until its next run.
- `watch(source, run, { immediate: true })` runs on the first read too, `previous` being `undefined` then.
- The first read is when the island's effects first run, once its render is done: a write the script makes before then is part of it and runs nothing.
- What the callback registers with `onCleanup` before an `await` runs at its next run: a flag set there drops a slower answer to an older value.
- `debounced(source, delay)` from `kay` is a memo giving `source`'s value once it has stopped changing for `delay`, a duration, starting with its value now: `watch(debounced(typed, '300ms'), lookUp)` looks up as the user pauses, with no `setTimeout` kept by hand.
- `debounced` drops its pending value with the island; on the server it keeps its first value. A `debounced` is read by calling it, as a memo is.
- `throttled(source, delay)` from `kay` is its twin for a value that must keep up while it changes: it gives `source`'s value at most once per `delay`, the first change at once and the last one when the wait ends; it is read by calling it, keeps its first value on the server and drops its timer with the island.
- `watch` and `debounced` run nothing while the server renders an island, as `effect` does; at a module's top level they run in the server's process too, as `effect` does there.
- `listen(window, 'keydown', event => ...)` from `kay` listens to an event of `window`, `document` or any other target while the island lives, the handler typed by the target's events and the fourth argument passed to `addEventListener`.
- `listen` never runs on the server, where the compiler keeps `window` unread, so a `.ts` module writes `listen(() => window, ...)`.
- A `listen` target read from a signal or a ref, `listen(() => panel, 'scroll', ...)`, listens to its new value as it changes, none while it is undefined.
