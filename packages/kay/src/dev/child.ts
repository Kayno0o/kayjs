// kay dev's app process: the build, the watchers and the app, on a Unix socket behind the `kay dev` process that keeps the port.

import type { DevChildMessage, DevChildOptions } from './protocol'
import { devServer } from './index'
import { DEV_CHILD_ENV } from './protocol'

if (import.meta.main) {
  const options = JSON.parse(process.env[DEV_CHILD_ENV] ?? '{}') as DevChildOptions
  const send = (message: DevChildMessage): void => {
    process.send?.(message)
  }
  const srv = await devServer({
    ...options,
    broadcast: payload => send({ t: 'event', payload }),
    recycle: reason => send({ t: 'recycle', reason }),
  })
  let stopping: Promise<void> | undefined
  const stop = (): void => {
    stopping ??= srv.stop().finally(() => process.exit(0))
  }
  process.on('message', (message: { t?: string }) => {
    if (message.t === 'stop')
      stop()
  })
  // The parent died without asking, or Ctrl-C reached the whole process group.
  process.on('disconnect', stop)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  send({ t: 'ready', assetPrefix: srv.assetPrefix })
}
