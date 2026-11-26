import { Badge, Button, Cluster, Stack } from '@kayjs/ui'

export default async function Home() {
  return (
    <Stack gap="md">
      <Cluster><Badge tone="accent">Kay v2</Badge><Badge>SQLite Auth</Badge></Cluster>
      <h1 class="page-title">Welcome to __APP_NAME__</h1>
      <p class="page-lead">Zero-dependency Argon2id auth, @kayjs/ui pure CSS grammar, and Bun speed.</p>
      <Cluster>
        <Button href="/login" tone="accent">Get started</Button>
        <Button href="/dashboard" variant="outline">Dashboard</Button>
      </Cluster>
    </Stack>
  )
}
