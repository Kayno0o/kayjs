import type { PageProps } from '@kayjs/kay'
import { Card, CardBody, CardHeader } from '@kayjs/ui'

export default async function DashboardPage({ locals }: PageProps) {
  return (
    <Card>
      <CardHeader>Dashboard</CardHeader>
      <CardBody>
        <p class="m-0">Signed in as <strong>{locals.user?.email}</strong>.</p>
      </CardBody>
    </Card>
  )
}
