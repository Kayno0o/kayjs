# Stores

`store` in kay.config.ts is where the app keeps what outlives one process: `sqliteData('data/app.sqlite')` for one machine, `pgData(db)` for replicas, or an object of stores of your own, each key optional (Redis, say). A feature naming no store of its own uses the one under its key.

## Reference

### The store contracts

| Key | Interface | Required | Optional | Factories |
| --- | --- | --- | --- | --- |
| `sessions` | `SessionStore` | `get`, `set(id, data, maxAge)`, `delete` | `deleteWhere` | `memorySessions`, `sqliteSessions`, `pgSessions` |
| `cache` | `CacheStore` | `get`, `set`, `delete`, `keys` | `dependencies`, `publish`, `subscribe` | `sqliteCache`, `pgCache` |
| `live` | `LiveStore` | `entries`, `set`, `delete`, `subscribe` | `end`, `endAll`, `stop` | `sqliteLive`, `pgLive` |
| `jobs` | `JobStore` | `add`, `claim`, `complete`, `retry`, `fail`, `failed` | `release`, `progress`, `state`, `live`, `update`, `purge`, `revive` | `memoryJobs`, `sqliteJobs`, `pgJobs` |
| `rates` | `RateStore` | `hit(key, window, weight)` | `peek`, `refund`, `reset` | `memoryRates`, `sqliteRates`, `pgRates` |
| `rooms` | `RoomStore` or `AsyncRoomStore` | `add`, `remove`, `members`, `publish`, `subscribe`, `close` | | `memoryRooms`, `sqliteRooms`, `pgRooms` |
| `vitals` | `VitalsStore` | `add`, `counts` | | `memoryVitals`, `sqliteVitals`, `pgVitals` |
| `notifications` | `NotificationStore` | `add`, `list`, `unread`, `markRead`, `markAllRead`, `erase`, `prune` | | `memoryNotifications`, `sqliteNotifications`, `pgNotifications` |
| `push` | `PushStore` | `add`, `list`, `remove`, `erase` | | `memoryPush`, `sqlitePush`, `pgPush` |
| `files` | `FileStore` | `write`, `read`, `delete` | `list`, `path`, `publicUrl` | `memoryFiles`, `diskFiles`, `s3Files` |

- Every factory is imported from `kay/server`, such as `import { memoryNotifications, memoryPush, memoryRates, memoryRooms, sqliteLive, sqliteNotifications, sqlitePush } from 'kay/server'`. A factory is `<backend><Thing>`: the backend is `memory`, `sqlite`, `pg`, `disk` or `s3`, the thing the store's key in the plural form the table shows. `sqliteData(path)` and `pgData(db)` make every kind over one file or database, `pgData` but the files.
- Every interface extends `StoreBase` from `kay/server`, as `store` does: `ping()` and `close()`, both optional, either may return a promise. `health` runs each store's `ping` beside the route's `check`, under `health.timeout` and its 3 s cache, and answers 503 when one rejects. A stop calls each store's `close()` once, `store`'s own last, so a `pgData` closes its connection after the rooms let go of their members. A store with neither costs nothing.
- `pgData(db).ping()` is a round trip to the database, and `await pgData(url).close()` or `await using store = pgData(url)` closes a store opened in a script or a test; closing twice is the same as once.
- `files` is read by `files` from `kay/server`, the image route and `kay build --static`: `sqliteData` keeps it in a `files` folder beside the database file (`data/files` for `data/app.sqlite`, where files go by default) and `pgData` leaves it out, so files stay on disk until `files: s3Files()` or a store of your own names another place ([Stored files](files.md#stores)).
- `fileStore` in kay.config.ts, before 1.87, is `store: { files }`: the old key works until 1.90 and `kay check` reports it as `deprecated-file-store`.
