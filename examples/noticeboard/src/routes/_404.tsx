import { Button, Notice, Stack } from '@kayjs/ui'
import { Head } from '@kayjs/kay'

export default function NotFoundPage() {
  return (
    <Stack gap="1rem">
      <Head><title>Not found — Noticeboard</title></Head>
      <Notice tone="warning">This page could not be found.</Notice>
      <div><Button href="/" variant="outline">Back to the board</Button></div>
    </Stack>
  )
}
