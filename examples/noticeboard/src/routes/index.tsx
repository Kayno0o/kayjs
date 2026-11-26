import type { PageProps } from '@kayjs/kay'
import { Button, Split, Stack } from '@kayjs/ui'
import { Head } from '@kayjs/kay'
import { LiveBoard } from '../components/LiveBoard'
import { NewNoticeModal } from '../components/NewNoticeModal'
import { latestNotices } from '../db'

export default async function BoardPage({ locals }: PageProps) {
  const user = locals.user
  const notices = latestNotices()
  const me = user ? (user.name || user.email) : null

  return (
    <Stack gap="1.5rem">
      <Head><title>Board — Noticeboard</title></Head>
      <Split>
        <h1 style="margin:0;font-family:var(--ui-font-display);font-size:2rem">Board</h1>
        {user ? <NewNoticeModal /> : <Button href="/login" variant="outline">Sign in to pin</Button>}
      </Split>
      <LiveBoard initialNotices={notices} me={me} />
    </Stack>
  )
}
