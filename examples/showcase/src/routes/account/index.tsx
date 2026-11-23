import { Badge, Button, Card, CardBody, CardFooter, CardHeader, Stack } from '@kayjs/ui'

export default async function AccountPage({ locals }: { locals: { user?: { id: string, email: string, role: string } } }) {
  const user = locals.user!
  return (
    <Card>
      <CardHeader>Protected Account</CardHeader>
      <CardBody>
        <Stack gap="0.75rem">
          <p style="margin:0">
            Authenticated via <code>@kayjs/auth</code> middleware guard.
          </p>
          <p style="margin:0">
            <strong>Email:</strong> {user.email} · <Badge tone="accent">{user.role}</Badge>
          </p>
        </Stack>
      </CardBody>
      <CardFooter>
        <form action="/auth/signout" method="post">
          <Button type="submit" variant="outline">Sign out</Button>
        </form>
      </CardFooter>
    </Card>
  )
}
