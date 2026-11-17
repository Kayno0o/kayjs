# Refused fields and their messages

## Common tasks

- Show why a post was refused: the tasks of [Actions](actions.md#common-tasks).

## Reference

### Refused fields and their messages

- A form posting to an action shows a refused post again by itself: each `input`, `textarea` and `select` in it whose `name`, and `type` if any, are written out takes the value the post sent in place of the one the template gives, a checkbox or radio button whether it was ticked, a field named like a secret (a password), a file, the honeypot and the form's own callback fields excepted. Forms posting to one action share one refused post. A component inside the form reads the same post with `postedValue(name, fallback?)`, `postedChecked(name, value?, fallback?)` and `postedValues(name, fallback?)` from `kay` (undefined outside a refused post and for a secret; in the browser they read what the server rendered, answering only a value that differs from `fallback`), which is how the kayjs-ui controls refill; a list field posts back as `name[]`, and a literal field named `foo[]` is not a list. The same components read the form's messages with `formErrors()` from `kay`, called in the script and answering `(field) => action.form.error(field)` of the form being rendered (nothing outside one), which is how a FormField shows `add.form.error('title')` with no `issue` prop; a component given an `action` (kayjs-ui's `Form`) is that form for its content: the kayjs-ui controls and the page's own `input`s in it refill and take `aria-invalid` on the server as in a `form(action)` (in the browser a component's `input` is its own). An island's own template does not know a `form(action)` of the page around it: its FormField shows nothing by name, so give the island the action (`Form(action={add})` inside it) or an `issue` prop.
- Each field the post was refused for gets `aria-invalid="true"`, and `aria-describedby` naming the element showing its message, so a screen reader reads the message with the field. In an island the mark goes once the field is no longer refused, unless a component still marks it through `markInvalid` (see [Islands](navigation.md#forms-posting-in-place)), such as a kayjs-ui `FormField` showing a message of its own.
- An `error title` line inside the form shows that message: `p.error`, with the id `add-title-error`, while the post is refused for `title`, nothing otherwise.
- `error.text-sm title` adds classes.
- A quoted name such as `error "first-name"` takes any field, and the name is typed from the schema.
- A bare `error` shows the form's own message, `add.form.error()`, its `form` described by it.
- One inside a `for` renders without an id and describes nothing.
- A `pending` block inside the form shows its lines only while that form posts, with no JavaScript of your own and none added to the page: the runtime that posts the form in place unhides it, and hides it again once the page the answer leads to (a redirect's included) is in; when the answer ends in a document that replaces the page (a redirect to another origin, a reload), it stays shown while that loads (ten seconds at most), and a page restored from the cache hides it. It is hidden in the render, after the answer or a refused post, and without JavaScript.
- In an island the block shows as well while a call of the form's action is in flight, from `onSubmit`, an `onClick` or anywhere else (`add.pending()`, so every call of the action, `add.with(...)` included: the forms of a list sharing one action all show their block; a `track()` handle is no action a form can post to), and while an `onSubmit` returns a promise.
- The block is a `slot` laid out as its contents, so it takes no place of its own in a flex or grid form and needs no class. No style rule is involved, so a strict `style-src` leaves it working.
- Its text is announced through a live region the runtime writes outside the form, as the form's `aria-busy` may hold back a region inside it.
- Without an `error` line, the field is described by the element an `if add.form.error('title')` block shows first, or one holding `{add.form.error('title')}`, written outside a `for` in the file holding a form that posts to `add`, which keeps its own `id` or gets one such as `add-title-error`.
- The form likewise is described by the element showing `add.form.error()`.
- A static `aria-describedby` the template writes, such as a hint, is kept and the error's id added after it; a bound one is left as it is.
- A message rendered any other way, through a component, a `for` over `errors` or another file, describes nothing, and the field is then announced as invalid without it.
- A field with a `bind:`, a spread, `disabled` or `multiple` keeps what the template gives, and one the page renders through another component is not the form's own.
- On a page posting no refused form, every field renders as written.

### Refused posts

- `ctx.deny(status, { message, errors, data })` is the one refusal of a guard, a page, an action and an endpoint, `refuse(status, { ... })` throws it from anywhere; `return` it so `form.failed()` types `data`. `ctx.fail` is its old spelling until 1.108 (`unreturned-fail`).
- A post the schema refuses, or whose handler denies with `ctx.deny(status, { data })`, is answered with the page it came from, rendered with the failure's status, rather than with a redirect.
- There `add.form.failed()` returns `{ status, message, values, errors, data }`, typed from the action, or `undefined`.
- `values` is what the form posted (fields named like a password left out).
- `errors` is a message per refused field, the schema's `error` option when set.
- `data` is what `ctx.deny` received.
- `return ctx.deny(409, { errors: { email: 'Already taken' } })` puts a message on a field, typed from the schema's keys, with `''` for the form's own, so `error email`, `aria-invalid`, `add.form.error('email')`, the value re-fill and an island's `ActionError.errors` (and a kayjs-ui `FormField` named `email`) follow it with and without JavaScript.
- A rate limit's refusal sits under `errors['']`, read by `add.form.error()`, and a text `data` is that message: `return ctx.deny(502, { data: 'Not sent; try again later' })`.
- The page renders as a visit of it would, through the app's plugins and the page's guards, and nothing the visitor typed is lost however long it is.
- Reloading it posts again, as after any form a server answers in place.
- The page is the one the post was sent from, as `ctx.params` reads it below, the home page when it names none or another site.
- Without the page swap the browser shows the action's URL, so the page carries a `base` naming its own URL, and its relative links lead where they did.
- Each form on it posting to an action names that page in a `kay_back` query parameter, so a post refused again renders the same page, however many times in a row, and one that goes through goes back to it.
- A handler that throws, a mail server down say, is logged as any server error, `onError` included, and answered as a refusal with status 500.
- A plain form post then renders its page with the message under the form and what was typed kept, read by `add.form.error()`, and a call answers `{ ok: false }` with it in `errors['']`.
- The message is `Something went wrong on our side; try again later` unless the site words it as `kay.action.serverError` ([Locales](locales-texts.md)) or the action words its own, `action(schema, handler, { messages: { serverError: 'Not sent; write to hello@example.com instead' } })`, so a handler needs no `try`/`catch` of its own to tell the visitor.
- `serverError` may be a function given the error and `ctx`, sync or async, to word it from what is loaded per request or the page's `ctx.locale`: `serverError: async () => 'Write to ' + (await settings.one()).email`. Its text is answered with the same status 500; one that throws, or answers a blank text, leaves kay's message (a throw logged beside the handler's error), and a redirect or denial thrown from it is no answer either.
- An action past its `timeout` (`serve.timeout` or the action's own) answers 504 the same way, worded `kay.action.timeout` (`This took too long; try again later`) and reported as a server error.
- A redirect or a guard's denial thrown is no error.

### Reading the outcome

- `add.form.failed()`, `add.data()`, `add.status()` and `add.form.error('title')` read the outcome from any template, layout, component or island, and from the server fence. What a form shows is read from `add.form` (`failed()`, `error(field)`, `validate(form, field)`), apart from the call state on `add` itself (`pending()`, `status()`, `data()`, `progress()`, `settled()`, `track()`); `failed()`, `error()` and `validate()` on `add` work until 1.108 and `deprecated-action-readers` rewrites them.
- `form.error()` without a field is the form-wide message, `errors['']`.
- The field name is typed from the schema.
- An island reads them in the browser too, as its server render did, but for `values`, which stay on the server, so no field the server cannot tell is a secret reaches the page's source: the fields hold what was sent.
- Once the page shown called the action, they read how its last call went instead, reactively, a call clearing them as it starts: an island calling `add({ title })` gets `{ ok: false }` and `add.form.error('title')` shows the message, the field marked invalid.
- `await add.form.validate(form, field?)` checks a form against the action's schema, writing what it refuses into `add.form.error(field)` and `add.form.failed()` in place of the last outcome (`data()` too), for every field or `field` alone; it resolves whether it is accepted, posts nothing, and accepts a form with no schema on the page (a client-only island's). kayjs-ui's `Form`, `SaveForm` and `FormDialog` take `validate="submit" | "blur"`.
- A post that succeeds goes back to the page with what the handler returned: `add.data()` returns it, typed from the action, or `undefined`, on that one render only; `add.status()` is `ready` then. `succeeded()`, which wrapped it in `{ data }`, works until 1.108 and `kay check` rewrites it.
- `data` travels in a cookie, sealed (AES-GCM under a key derived from [the app secret](environment.md#the-app-secret), else a key of the process, which a restart changes), so a secret shown once, such as a new API token, can be neither read nor altered in it.
- Data too big for it, over about 3.5 KB sealed, is left out with a warning, and `data()` returns `undefined`, as it does for a cookie that does not open, forged or sealed before a restart.
- A prerendered page reads both too: the request carrying that cookie renders it afresh, see [Prerendering](prerendering.md#prerendering).
- The cookie carrying `succeeded()` back is `HttpOnly`, `SameSite=Lax`, and `Secure` when the request came over https, `X-Forwarded-Proto` included, as is every request in production when `site` is https.
