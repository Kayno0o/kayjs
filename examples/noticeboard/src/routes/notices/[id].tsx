import type { RequestContext } from 'kay/server'
import type { PinnedNotice } from '../../db'
import { Button, Card, CardBody, CardFooter, CardHeader, Stack } from '@kayjs/ui'
import { Head } from 'kay'
import { findNotice } from '../../db'

export function load(ctx: RequestContext): PinnedNotice | Response {
  const notice = findNotice(Number(ctx.params.id))
  if (!notice)
    return new Response('Notice not found', { status: 404 })
  return notice
}

export default function NoticeDetailPage({ data }: { data: PinnedNotice }) {
  return (
    <Stack gap="1.25rem">
      <Head><title>{data.title} — Noticeboard</title></Head>
      <Card>
        <CardHeader>{data.title}</CardHeader>
        <CardBody>
          <p style="margin:0;white-space:pre-line">{data.body}</p>
        </CardBody>
        <CardFooter>
          <span>{data.author} · {data.postedAt.slice(0, 10)}</span>
        </CardFooter>
      </Card>
      <div>
        <Button href="/" variant="outline">← Back to the board</Button>
      </div>
    </Stack>
  )
}
