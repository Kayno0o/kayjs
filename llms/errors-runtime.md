# Errors raised while running

Which errors a server raises, when a function throws or returns a `Result`, and the classes an app catches. The code of every error, and where its fix is written, is in [Errors](errors.md).

## Reference

### Throwing and returning

- The errors kay raises while serving a request that an app handles (a response failing its schema, an API answer kay cannot send, a refused redirect, a result that cannot reach the browser, a closed store, a request timeout, a CSP report) are `KayError`s of the `runtime` group and carry a code; the argument checks of helpers such as `webPush.send`, `rooms` and `signed`, and the app's own code, are plain errors with none. The code is `error.code`, `LogEntry.error.code` of its log line, the `kay.error.code` attribute of its span and `code` in the `observe.onError` event, which leaves it out for an error that is no `KayError`.
- Every error kay and its libraries throw for an app to catch extends `KayError` (from `kay/library`): `code` is the registered name, `kind` tells apart what one code covers (the code itself when it covers one cause), `status` is the HTTP status it stands for (`undefined` when none), `cause` the error underneath, and `name` the class's, so `instanceof` of each class still works.
- A message opens with `kay: ` when it names a setting (a `configError`, which every library throws for an option it refuses at boot, ending on the library, the option and where it is documented), with `kayjs-<library>: ` when a library refuses a call of the developer's, and with nothing when the app shows it to a visitor or an editor (a `SaveConflictError`, a `RedirectRefusedError`).
- A function throws for a wrong setup or a programming mistake (a `configError` at boot, a `KayError` subclass) and for an infrastructure failure the app cannot act on per call (a provider down, a store unreachable). It returns a Result for what a visitor or another caller did and the app branches on: a sign-in, a save, `list.confirm`, a tracked call, `webPush.enable()`.
- A Result discriminates on `ok`. A failure is `{ ok: false, error }`, `error` one `ErrorShape` (`status`, `message`, `errors` by field, `data`) in kay, in cms and in auth, where `error.code` is also the kind the app branches on (`'signed-out'`, `'limited'`...); a tracked call keeps those fields flat on the result too. `errors` by field comes only from a call that refused its input, next to `error`. One result is an exception: `ApiResult` of `site.api()` in tests mirrors a Response (`ok`, `status`, `headers`, `body`) and has no `error`. `showDraft` of `kay/edit` and `saveEntry`, `saveEntries` and `removeEntry` of `kay/content` resolve `{ ok: true }` or `{ ok: false, error, issues }`.
- `WaitResult`, `SaveOutcome` and `CallResult` keep the field they had before `ok` (`timedOut`, `saved` and `issues`, the flat failure) as plain API, none deprecated; `show()` of `installPrompt` and `subscribe()` of `webPush` answer the bare string they always did, beside `install()` and `enable()`. A result an app builds by hand, such as a test fake of one of these, needs `ok` and `error` now.
- Every error class kay exports ends in `Error`, as a library's does (`HydrationMismatchError` of `kay/dom`, `ActionRedirectError` from `kay`, `CspViolationError` from `kay/server`, `RedirectRefusedError` of `kay/library`, their `name` too).

### Errors raised while running

Each extends `KayError`, so its `code`, `kind`, `status` and `name` are set and `error instanceof KayError` holds.

| Class | `code` | Thrown for |
| --- | --- | --- |
| `PrivateAddressError` | `private-address` | A host that answers with an address that is not public, which a download of kay refuses. |
| `RedirectRefusedError` (`kay/library`) | `redirect-refused` | A runtime redirect an editor asked for that kay refuses, its message worded for the editor. |
| `GiveUpError` | `job-give-up` | A workflow run whose steps changed under it: the job is kept as failed at once, with no retry. |
| `RequestTimeoutError` | `request-timeout` | A request past its `timeout`, `status` 504. |
| `IslandPropsError` | `island-props-invalid` | An island given a prop that cannot reach the browser. |
| `StreamRefusedError` | `stream-refused` | A stream source that cannot serve after all. |
| `CspViolationError` | `csp-violation` | A violation a browser reported to kay's report route. |
| `ConfigRefusedError` | `config-refused` | A `kay.config.ts` that does not load under `kay dev`. |
| `DatabaseOwnedError` | `database-owned` | A boot on a database that belongs to another app. |
| `TimeoutError` | `poll-timeout` | A database call a store gave up on after its time limit. |
| `MarkdownError` | `markdown-invalid` | Markdown an entry holds that kay cannot read, with the `line`. |

A request can also raise a `KayError` with no class of its own, told by its code: `response-schema-mismatch` (an API answer failing its `response` schema, 500), `api-answer-invalid`, `redirect-target-invalid`, `live-value-invalid`, `session-too-big`, `outside-request`, `hook-timeout` and `store-closed`.

The libraries list their own classes in an `Errors` table of their `llms/`: [kayjs-ai](../packages/ai/llms/testing-and-errors.md#errors), [kayjs-auth](../packages/auth/llms/hardening-and-testing.md#errors), [kayjs-cms](../packages/cms/llms/options.md#errors), [kayjs-mail](../packages/mail/llms/contact-form-and-testing.md#errors) and [kayjs-ui](../packages/ui/llms/setup.md#errors).
