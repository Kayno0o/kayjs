# Island and form lints

## Common tasks

- Set a lint's level, allow it on one line or apply its quick fix: [Lints and warnings](lints.md).

## Reference

- The `islands` group reads what a component sends to the browser and how it hydrates; the `forms` group reads fields and the actions behind them.

| Lint | Default | Group | Reports |
| --- | --- | --- | --- |
| `invalid-autocomplete` | deny | forms | An `autocomplete` value HTML does not define. |
| `unbounded-string` | warn | forms | A string field of an action's schema named like a short value (`name`, `email`, `title`, `subject`, `slug`...) with no `maxLength` of its own, which takes the default bound of 10,000 characters, unless its `enum`, `const` or anchored bounded `pattern` already bounds it. |
| `invalid-nesting` | warn | islands | Markup HTML forbids or the parser rewrites: a block in a `p`, `form` in `form`, `tr` in a `table`, a heading in a heading, an `option` outside a `select`, an `li` outside a list, a non-`li` in one. |
| `positional-key` | warn | islands | `for todo, i of todos key={i}` whose rows read `todo.id`: keyed by position, a row added before others hands them its state. The fix drops the key. |
| `unkeyed-rows` | warn | islands | A keyless `for` in an island, or a component only islands import, over rows with no `id`: a copy is a new row, losing its focus. The offered fix writes `key={i}`; an `id` or a `key={row.slug}` is better. |
| `missing-autocomplete` | warn | forms | An `input` of type `email` or `password` with no `autocomplete`. |
| `uncalled-signal` | deny | islands | A signal or memo the template names without calling it where its value goes, `{count}` or `if count > 1`: a signal is read by calling it, in the template as in the script, `{count()}`. Handed on whole, as a component prop or a function argument, it passes the signal itself, which a parameter typed `Signal<T>`, `Memo<T>`, a function type or a generic `T` takes; one typed `unknown` or `any` is reported too, `String(count)`. `--fix` calls the signal named where its value goes. |
| `constant-signal` | warn | islands | A signal the component script declares and only ever reads: it never changes, so a plain `const` renders the same without the reactivity. |
| `signal-set-call` | warn | islands | A signal written `count.set(value)`, as a statement or an arrow's body, where assigning it, `count = value`, compiles to the same call; an updater written inline, `count.set(c => c * 2)`, and a `.set` whose value an expression uses are left. `--fix` assigns it. |
| `server-only-import` | deny | islands | `invalidatePage` or `sqliteCache` imported from `kay/cache` by an island's script, a `--- client` fence, a component only islands render, or a `.ts` module they import: the browser's `kay/cache` has `cached` and `invalidate` alone, so the build fails on the import. |
| `missing-captcha` | warn | forms | A call of `password.register`, `password.requestReset`, `magicLink.request` or `password.signIn` on a receiver named `*auth` with no `captcha` option, where neither the file nor a module's `authCore` sets `captcha: false`: kayjs-auth's default proof of work refuses it as `{ ok: false, error: 'captcha' }`. Pass `{ captcha: input.captcha }` from a form carrying `input(type="hidden" name="captcha" data-kay-work={await auth.captchaChallenge('register')})`. In `.kay` fences and `.ts` modules alike. |
| `island-marker` | deny | islands | `--- island` on a page, layout or special page, which are never islands. |
| `island-prop` | deny | islands | A component that is not an island passing one a value its type says cannot be sent: a function, a block with parameters, a symbol, an object holding one. `--- island` is the fix, offered, never applied by `--fix`. Found by the type check. |
| `hydration-mismatch` | deny | islands | An island reading the clock, `Math.random()` or a `toLocale*String` or `Intl` format with no locale (or, for dates, no `timeZone`) while it renders, which the server and the browser compute apart; `// kay-allow hydration-mismatch` allows a deliberate read. |
| `unowned-effect` | warn | islands | `effect`, `watch`, `every`, `listen`, `debounced`, `throttled`, `onMount` or `onCleanup` called in a timer, a promise callback or after an `await`, where no owner stops them and each call lives until the page goes, or in an inline event handler or `listen` handler, where each event adds one stopped only when the component goes. Call them in the component script, or inside `root()`. Only inline handlers are seen: a named handler, a conditional handler and an `await` inside a loop are not. |
