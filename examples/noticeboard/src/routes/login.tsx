import { Button, Card, CardBody, CardHeader, Field, Grid, Stack } from '@kayjs/ui'
import { Head } from 'kay'

export default function LoginPage() {
  return (
    <Stack gap="1.5rem">
      <Head><title>Sign in — Noticeboard</title></Head>
      <Grid min="18rem" gap="1.5rem">
        <Card>
          <CardHeader>Sign in</CardHeader>
          <CardBody>
            <form action="/auth/signin" method="post">
              <Stack gap="0.9rem">
                <input type="hidden" name="redirect" value="/" />
                <Field id="in-email" label="Email" required>
                  <input id="in-email" name="email" type="email" required />
                </Field>
                <Field id="in-pass" label="Password" required>
                  <input id="in-pass" name="password" type="password" required />
                </Field>
                <Button type="submit" tone="accent">Sign in</Button>
              </Stack>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>Join Noticeboard</CardHeader>
          <CardBody>
            <form action="/auth/signup" method="post">
              <Stack gap="0.9rem">
                <input type="hidden" name="redirect" value="/" />
                <Field id="up-name" label="Display name" required>
                  <input id="up-name" name="name" type="text" required />
                </Field>
                <Field id="up-email" label="Email" required>
                  <input id="up-email" name="email" type="email" required />
                </Field>
                <Field id="up-pass" label="Password" hint="Min 8 characters" required>
                  <input id="up-pass" name="password" type="password" minlength="8" required />
                </Field>
                <Button type="submit" tone="accent">Create account</Button>
              </Stack>
            </form>
          </CardBody>
        </Card>
      </Grid>
    </Stack>
  )
}
