import { Button, Card, CardBody, CardHeader, Field, Grid, Stack } from '@kayjs/ui'

export default function LoginPage() {
  return (
    <Grid min="md" gap="lg">
      <Card>
        <CardHeader>Sign in</CardHeader>
        <CardBody>
          <form action="/auth/signin" method="post">
            <Stack gap="sm">
              <input type="hidden" name="redirect" value="/dashboard" />
              <Field id="in-email" label="Email" required><input id="in-email" name="email" type="email" required /></Field>
              <Field id="in-pass" label="Password" required><input id="in-pass" name="password" type="password" required /></Field>
              <Button type="submit" tone="accent">Sign in</Button>
            </Stack>
          </form>
        </CardBody>
      </Card>
      <Card>
        <CardHeader>Create account</CardHeader>
        <CardBody>
          <form action="/auth/signup" method="post">
            <Stack gap="sm">
              <input type="hidden" name="redirect" value="/dashboard" />
              <Field id="up-email" label="Email" required><input id="up-email" name="email" type="email" required /></Field>
              <Field id="up-pass" label="Password" hint="Min 12 characters" required><input id="up-pass" name="password" type="password" minlength="12" required /></Field>
              <Button type="submit" tone="accent">Create account</Button>
            </Stack>
          </form>
        </CardBody>
      </Card>
    </Grid>
  )
}
