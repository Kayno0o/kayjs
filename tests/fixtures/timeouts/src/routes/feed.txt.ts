import { seen } from '../seen'

export async function GET(ctx: { signal: AbortSignal }) {
  seen.endpoint = ctx.signal
  await Bun.sleep(600)

  return 'late'
}
