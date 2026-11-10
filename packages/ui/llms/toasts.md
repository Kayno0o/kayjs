# kayjs-ui: toast and Toaster

## Common tasks

```ts
import { attempt, toast } from '@kaynooo/kayjs-ui'

toast.success('Saved')
toast.error('Could not save')
toast.info('Copied')

// `duration` is a string such as `'3s'` (`'6s'` by default; an error stays until the reader dismisses it, so `'10s'` gives it back a clock); `false` keeps any toast until the reader dismisses it, or `dismissToast(id)` does, each call answering its id. Its `tone` is any `Tone`, `danger` for `toast.error` (the icon and colour follow it).
const sticky = toast.error('Offline', { duration: false })

// `action` adds one button before the close button, for the obvious next step: it is busy while `run`'s promise is pending, the toast goes once it settles (a rejection is logged), and Alt+t reaches it. An action toast keeps the clock of its tone, none for an error.
toast.error('Could not pull: the branch diverged', { action: { label: 'Rebase onto origin/main', run: () => rebase() } })

// `description` adds a quieter second line, and `message` may be markup, a snippet, instead of a string. `onDismiss(reason)` is called once the toast has gone, `reason` being `timeout`, `user` (close button or Escape), `action` (its button ran) or `api` (`dismissToast(id)`, `toast.update` closing it); one that throws is logged.
toast.info('Exported', { description: '12 rows, 3 skipped', onDismiss: reason => track(reason) })

// `action` may be a link instead: `{ label: 'Open', href: '/exports/12' }` draws a link-button. A click runs its `run` when it has one (not awaited, the navigation goes on), then closes the toast with the reason `action`, as toasts outlive a page swap.

// `toast.update(id, patch)` changes an open toast in place (`message`, `description`, `tone`, `action`, `duration`, `loading`, `onDismiss`) and answers false when it already went. A field left out, or `undefined`, stays; `null` clears `description`, `action` and `onDismiss`. A toast turned into an error already open with the same words closes instead of stacking. Naming `tone`, `duration` or `loading` starts its clock afresh from the new tone's default.
const id = toast.info('Uploading', { duration: false })
toast.update(id, { message: 'Uploaded', tone: 'success', duration: '4s' })

// `toast.promise(source, { loading, success?, error })` shows `loading` with a spinner and no clock, then settles the same toast: `success` (a string or `value => string`; none closes the toast) or `error` (a string or `thrown => string`, which stays like any danger toast). `source` is a promise or a function returning one. It resolves to the value, or to undefined once the call threw, as `attempt` does, so it needs no `catch`. `success` and `error` may also be `{ message, description?, action? }`. The outcome keeps the toast's `onDismiss`, which hears one dismissal for the whole flow, and drops the loading toast's `description` and `action` unless the outcome gives its own. A reader who closed the loading toast meanwhile still gets the outcome as a new toast, without a second `onDismiss`. A `success` or `error` that throws is logged and closes the toast, and the call keeps its result.
const file = await toast.promise(() => upload(blob), { loading: 'Uploading', success: result => `Uploaded ${result.name}`, error: 'Could not upload' })

// Resolves to what the call returned (`true` for a call returning nothing), or to undefined once it threw and `failure` was toasted, or a refusal of the whole call such as a limit.
const post = await attempt(() => publish({ id }), 'Could not publish')

// `success` is toasted once the call goes through.
if (await attempt(() => archive({ id }), { failure: 'Could not archive', success: 'Archived' }))
  selected.set([])

// A refusal of the action's handler, `ctx.fail(409, { error: 'Already published' })`, toasted as it says.
await attempt(() => publish({ id }), 'Could not publish', (data: { error: string }) => data.error)
```

## Reference

`attempt(run, failure, refused?)`, or `attempt(run, { failure, success?, refused?, refusedAction?, onRefused? })`, toasts, for a call that throws, the message `refused` reads from the data the action's handler passed to `ctx.fail`; else a refusal of the whole call, such as a limit; else `failure`. An empty or undefined answer from `refused` falls through to the next, and the next after `refused` is the data itself when it is a string or has a string `error` or `message` that reads as a message (below), so `refused` is for another field or an override. Type `refused`'s parameter as the handler's data: `(data: { error: string }) => data.error`. `refusedAction(data)` reads the same data for the toast's button, `data => data.diverged ? { label: 'Rebase', run: rebase } : undefined`; only a refusal gets it, not `failure`, and one that throws offers no button and is logged. `onRefused` shows no toast, so no button, and a refusal matching an error already open is not stacked.

A call to an API route made with `call()` throws `ApiError`, which `attempt` reads too: `refused` gets its `data`, else the words the route gave (the text it answered or the `message` or `error` of its JSON) are toasted for a 4xx when they read as a message (one line of at most 200 characters, not markup nor a code such as `NOT_FOUND` or `404`; `ACCESS DENIED` is a message), `refused` is called only for a JSON object answer, and one that throws counts as saying nothing and is logged with `console.error`, and `failure` stands for status 0 (no answer came), a 5xx or an answer with no words: `await attempt(() => call(notes, '/:id', { method: 'delete', params: { id } }), 'Could not delete')`.

`onRefused(data)` in the options gets what a refusal carries instead of any toast (an action's `ctx.fail` data, or a route's JSON object answer), to show it in place without a `try`/`catch` and `action.refused`: `await attempt(() => apply(), { failure: 'Could not apply', onRefused: data => output = data.output })`. `onRefused` is awaited, and one that throws or rejects is logged and toasts `failure`. A failure that is no refusal (a schema refusal, a network error, a 5xx answer, any other throw) still toasts `failure`, and `attempt` resolves to `undefined` either way.

`messageOf(error, fallback)` is the same reading for a page that shows the message where it is, not as a toast: the route's words of an `ApiError` or an action's refusal when they read as a message, else `fallback` (status 0, a 5xx, any other error): `catch (error) { notice = messageOf(error, 'Could not load') }`.

`Toaster` takes `position` (`top-left`, `top-center`, `top-right`, `bottom-left`, `bottom-center`, `bottom-right`, the last by default), `limit` (at most that many shown, the newest; older ones wait with their clocks running and show again as room is made) and a `toast` block, `@toast(item, dismiss)`, which draws what is inside each toast in place of its icon, message, description and buttons, `dismiss` closing it as the reader (`onDismiss('user')`). The toast keeps its box, tone, clock and Escape, and the screen reader regions still read `item.message`. Its parts add `content` and `description` to the existing ones ([Restyle a component](restyle.md)). `Toast` is `{ id, message, tone, description?, action?, loading?, onDismiss? }`, `toasts` the list the Toaster reads, and `ToastPatch`, `ToastPromiseOptions` and `ToastDismissReason` are the types.

What a screen reader hears: a message and its description are read from a polite status region, a danger one from an alert region, and the outcome of a `toast.promise` is always read politely, an error included, as the reader waited for it. A toast changed by `toast.update` is not read again unless its words change in the region.

A toast stays for six seconds, an error for ten, or until its close button is pressed, named by `dismissLabel` on Toaster. Screen readers hear each one from a status region kept in the page, an error from an alert region. Its clock stops while the pointer rests on the toasts or focus is inside them, and goes on with the time it had left once both are gone. Alt and `t` (`hotkey` on Toaster, `null` for none) moves focus to the toasts on screen, where Escape dismisses the focused one. Toaster is a manual popover in the top layer, so toasts show above an open dialog.
