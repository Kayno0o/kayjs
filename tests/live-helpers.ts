import type { LivePage, LiveRequest, LiveUpdate } from '../src/runtime/live-value'
import { decodeServerValue } from '../src/runtime/wire'

const SCRIPT = /<script type="application\/json" data-kay-live>([^<]*)<\/script>/g

export const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } }

// The scripts of live values a page carries, read as its islands read them.
export function pagesOf(html: string): LivePage[] {
  return [...html.matchAll(SCRIPT)].map(([, text]) => decodeServerValue(text!.replaceAll('\\u003c', '<')) as LivePage)
}

export function proofsOf(pages: LivePage[]): LiveRequest['proofs'] {
  return pages.map(({ values, sig, at }) => ({ keys: values.map(([id, key]) => [id, key] as [string, string]), at, sig }))
}

// What a connection delivers, one event at a time.
export class Feed {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''

  constructor(readonly response: Response) {
    this.reader = response.body!.getReader()
  }

  async next(): Promise<LiveUpdate[]> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n')

      if (end !== -1) {
        const block = this.buffer.slice(0, end)

        this.buffer = this.buffer.slice(end + 2)

        const data = block.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')

        if (data !== '')
          return decodeServerValue(data) as LiveUpdate[]

        continue
      }

      const { done, value } = await this.reader.read()

      if (done)
        throw new Error('the connection ended')

      this.buffer += this.decoder.decode(value, { stream: true })
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel()
  }
}
