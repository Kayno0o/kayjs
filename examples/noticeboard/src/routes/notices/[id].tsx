import type { PageProps, RouteContext } from '@kayjs/kay/server'
import { Button, Card, CardBody, CardFooter, CardHeader, Stack } from '@kayjs/ui'
import { Head } from '@kayjs/kay'
import { notFound } from '@kayjs/kay/server'
import { findNotice } from '../../db'

export function load(ctx: RouteContext<'/notices/[id]'>) {
  const notice = findNotice(Number(ctx.params.id))
  if (!notice)
    return notFound()
  return notice
}

export default function NoticeDetailPage({ data }: PageProps<typeof load>) {
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
