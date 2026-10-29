# Several workers

Serving from every core of a machine: `kay start --workers` and the executable. Replicas on several machines are in [Running in production](production.md).

## Common tasks

### Serve from several processes

- `kay start --workers 4` (or `auto`, one per core) and `./server --workers 4` (or `KAY_WORKERS=4`) serve from that many Bun processes on the one port, through `reusePort`, with nothing to change in the app. One worker by default, and elsewhere than Linux, where `reusePort` does not balance. No kay.config.ts key.
- The command running them (`kay start`, or the executable itself, before it loads the app) only supervises: it passes SIGINT, SIGTERM, SIGHUP and SIGQUIT to every worker, each draining as alone, and exits 0 when they all did. `--health` and `--load` of the executable never supervise.
- A worker that dies unasked is started again after 250 ms, doubling while it keeps dying; five deaths in a row without living 10 s stop everything with exit 1. Workers drain once the supervisor is gone.
- Each worker costs a server's memory. Set `KAY_SECRET` as for replicas; `KAY_EPHEMERAL_SECRET=1` makes the supervisor share a made one with its workers.

## Reference

### What the workers share

- What `store` in kay.config.ts leaves out and one process would keep in memory (`cache`, `live`, `rates`, `rooms`, `vitals`, `notifications`, `push`) is kept by kay in `data/workers.sqlite`, emptied each time the command starts. A store you name is never replaced; sessions travel in their cookie and the queue keeps `data/jobs.sqlite`, as before.
- A store built in memory (`memorySessions()` from `kay/server`, say) is kept too, and then splits per worker: the first worker logs a warning naming it. Name `sqliteData(path)` or a shared store instead.
- Every worker runs the queue, the schedules and the startup code, a job claimed and a schedule locked once through the store; an `onStart` hook or a module's top-level code runs once per worker.
- The edit sessions of the CMS and `editedEntry` are kept in the shared `cache` store, so a page rendered by one worker is served to the editor by another.
- Workers hear each other's live values and room changes within about half a second, and a read-modify-write is not atomic across them, nor is a read right after a write in another worker. Other state a module keeps in a variable is per worker.
