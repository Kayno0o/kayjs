# Stores

`store` in kay.config.ts is where the app keeps what outlives one process: `sqliteData('data/app.sqlite')` for one machine, `pgData(db)` for replicas, or an object of stores of your own, each key optional (Redis, say). A feature naming no store of its own uses the one under its key.

## Common tasks

- Keep everything on one machine: `store: sqliteData('data/app.sqlite')`; files stay in `data/files`.
- Share it between replicas: `store: { ...pgData(db), files: s3Files() }`, the bucket for files every replica reads.
- Plug in a store of your own: give the key an object with the interface's methods below, plus `ping` and `close` when it holds a connection.

## Reference

### The store contracts

| Key | Interface | Required | Optional | Factories |
| --- | --- | --- | --- | --- |
| `sessions` | `SessionStore` | `get`, `set(id, data, maxAge)` (`maxAge` in ms), `delete` | `deleteWhere` | `memorySessions`, `sqliteSessions`, `pgSessions` |
| `cache` | `CacheStore` | `get`, `set`, `delete`, `keys` | `dependencies`, `publish`, `subscribe` | `sqliteCache`, `pgCache` |
| `live` | `LiveStore` | `entries`, `set`, `delete`, `subscribe` | `end`, `endAll`, `stop`, `hold` | `sqliteLive`, `pgLive` |
| `jobs` | `JobStore` | `add`, `claim`, `complete`, `retry`, `fail`, `failed`, `nextRunAt`, `lock` | `release`, `progress`, `state`, `live`, `update`, `prune`, `revive` | `memoryJobs`, `sqliteJobs`, `pgJobs` |
| `rates` | `RateStore` | `hit(key, window, weight)` (`window` in ms) | `peek`, `refund`, `reset` | `memoryRates`, `sqliteRates`, `pgRates` |
| `rooms` | `RoomStore` | `add`, `remove`, `members`, `publish`, `subscribe`, `close` | `state`, `update` (promises) | `memoryRooms`, `sqliteRooms`, `pgRooms` |
| `vitals` | `VitalsStore` | `add`, `counts` | | `memoryVitals`, `sqliteVitals`, `pgVitals` |
| `notifications` | `NotificationStore` | `add`, `list`, `unread`, `markRead`, `markAllRead`, `erase`, `prune` | | `memoryNotifications`, `sqliteNotifications`, `pgNotifications` |
| `push` | `PushStore` | `add`, `list`, `delete`, `erase` | | `memoryPush`, `sqlitePush`, `pgPush` |
| `files` | `FileStore` | `write`, `read`, `delete` | `list`, `path`, `publicUrl` | `memoryFiles`, `diskFiles`, `s3Files` |
| `kv` | `KvStore` | `get`, `set(key, value, ttlMs?)`, `delete`, `once(key, ttlMs)` | | `memoryKv`, `sqliteKv`, `pgKv` (inside `pgData`) |

- Every factory is imported from `kay/server`, such as `import { memoryKv, memoryNotifications, memoryPush, memoryRates, memoryRooms, sqliteKv, sqliteLive, sqliteNotifications, sqlitePush } from 'kay/server'`. A factory is `<backend><Thing>`: the backend is `memory`, `sqlite`, `pg`, `disk` or `s3`, the thing the store's key in the plural form the table shows. `sqliteData(path)` and `pgData(db)` make every kind over one file or database, neither with the files.
- Every interface extends `StoreBase` from `kay/server`, as `store` does: `ping()` and `close()`, both optional, either may return a promise. `health` runs each store's `ping` beside the route's `check`, under `health.timeout` and its 3 s cache, and answers 503 when one rejects. A stop calls each store's `close()` once, `store`'s own last, so a `pgData` closes its connection after the rooms let go of their members. A store with neither costs nothing.
- A store method answers `MaybePromise<T>` (the value at once, or a promise of it; `MaybePromise` is exported from `kay/library`), so a store over memory or a file answers at once, one over a database later, and a caller `await`s every call. A room's `state` and `update` answer promises only, and `members`, `add`, `remove`, `publish` and `subscribe` of a room store are synchronous, as they are mirrored in memory.
- A store receives a duration as milliseconds, a number: `SessionStore.set`'s `maxAge` and `RateStore.hit`'s `window`. An option an app writes (`maxAge: '30d'`, `rateLimit.window`) is always a `Duration`, which kay turns into milliseconds before it calls a store.
- `kv(namespace)` from `kay/server` is what a library or an app uses for a value under a key that is not a count: `get(key)`, `set(key, value, ttlMs?)` (a string, kept until `ttlMs` has passed, or until deleted without it), `delete(key)` (whether there was one) and `once(key, ttlMs)`, which takes a key for `ttlMs` and resolves true for the one call that took it, however many processes ask at once: a ticket spent once, a sweep run by one replica. Keys are kept apart per namespace. It reads `store.kv`, which `sqliteData` and `pgData` fill, else this process's memory (`kv(namespace, store)` names a store). kayjs-ai's approval tickets, kayjs-cms's signed-out cookies (`passwordGuard({ kv })`) and kayjs-auth's cached OAuth client documents use it, where they counted or held a `Map` through `store.rates` before.
- One verb per job: `delete` removes one record by its key and answers whether there was one (`FileStore`, `PushStore`, a user store), `erase(user)` removes everything a user owns and answers the count, `prune(before)` removes what is old and answers the count (`JobStore.prune`, the audit log), and `remove` is left to a member of a list (`RoomStore.remove`, `JobStore.remove`). `SessionStore`, `CacheStore` and `LiveStore` `delete` stay without an answer, as nothing reads it.
- `pgData(db).ping()` is a round trip to the database, and `await pgData(url).close()` or `await using store = pgData(url)` closes a store opened in a script or a test; closing twice is the same as once.
- `files` is read by `files` from `kay/server`, the image route and `kay build --static`: no factory fills it, so files stay in `data/files` (in memory under `bun test` and `testSite`) until the app writes `store: { ...sqliteData(path), files: s3Files() }` or a store of its own ([Stored files](files.md#stores)).
- `fileStore` in kay.config.ts, before 1.87, is `store: { files }`: the old key works until 1.90, wins over `store.files` while both are written, and `kay check` reports it as `deprecated-file-store`.
- `AppStore.database` is the url of the database the stores keep their data in (`sqlite:///abs/path` for `sqliteData`, the url `pgData` was given), and `AppStore.sql` the Postgres connection `pgData` works through (the pool it opened from a url, or the one the app handed in), so a library keeping tables of its own there reuses it instead of opening a pool: kayjs-mail, kayjs-ai and kayjs-cms follow them through `appDatabase()` from `kay/library`. Both are left out for a store built by hand, and `database` for a `pgData(sql)` given a connection.
