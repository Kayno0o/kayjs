import {
  Accordion,
  AccordionItem,
  Badge,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Checkbox,
  Cluster,
  CommandPalette,
  DataTable,
  Dialog,
  Drawer,
  Field,
  Grid,
  Menu,
  Notice,
  Popover,
  RadioGroup,
  Select,
  Stack,
  Switch,
  Tabs,
} from '@kayjs/ui'
import { ToastTrigger } from '../components/ToastTrigger'

const SAMPLE_ROWS = [
  { id: '1', pkg: 'kay', loc: 6400, role: 'Core compiler, signals, SSR, server' },
  { id: '2', pkg: '@kayjs/ui', loc: 2200, role: 'Platform-first primitives + CSS Grammars' },
  { id: '3', pkg: '@kayjs/auth', loc: 1285, role: 'Argon2id, sessions, SQLite, OAuth2+PKCE' },
  { id: '4', pkg: '@kayjs/images', loc: 210, role: 'AVIF/WebP pipeline + cache' },
  { id: '5', pkg: '@kayjs/mail', loc: 184, role: 'Resend + dev outbox preview' },
  { id: '6', pkg: '@kayjs/seo', loc: 230, role: 'Meta, JSON-LD, sitemap, self-hosted fonts' },
]

export default async function ShowcasePage({ locals, url }: { locals?: { user?: { email: string } }, url?: URL }) {
  const blockedNext = !locals?.user ? url?.searchParams.get('next') : null
  return (
    <Stack gap="2rem">
      {blockedNext && (
        <Notice tone="warning" role="alert">
          <strong>Guarded route blocked:</strong> <code>{blockedNext}</code> requires authentication via <code>auth.guard()</code>. Create an account below to enter.
        </Notice>
      )}
      <section>
        <Stack gap="0.75rem">
          <Cluster>
            <Badge tone="accent">Platform-First</Badge>
            <Badge tone="success">0 KB static JS</Badge>
            <Badge>Pure CSS @layer kui</Badge>
          </Cluster>
          <h1 style="margin:0;font-family:var(--ui-font-display,inherit);font-size:clamp(1.75rem,4vw,2.6rem)">
            Same DOM. Four structurally different apps.
          </h1>
          <p style="margin:0;max-width:56ch;color:var(--ui-muted)">
            Switch the Style Grammar in the header bar above — Editorial, Workshop, Console, Soft, or Bare — without touching a single component or shipping a JS recipe runtime.
          </p>
          <Cluster>
            <CommandPalette
              items={[
                { id: 'home', label: 'Go to Showcase', shortcut: 'G H', href: '/' },
                { id: 'account', label: 'Open Protected Account', shortcut: 'G A', href: '/account' },
                { id: 'eject', label: 'Eject CSS Grammar (kay ui-eject)', shortcut: '⌘E' },
              ]}
            />
            <Dialog title="Confirm deployment" description="Zero external JS libraries — native <dialog> top-layer." triggerLabel="Open Dialog">
              <p>Press Escape or click the backdrop to close.</p>
            </Dialog>
            <Drawer title="Inspector Drawer" description="Native <dialog> docked to the edge." triggerLabel="Open Drawer" side="right">
              <Stack gap="0.75rem">
                <Switch name="autosave" label="Auto-save changes" checked />
                <Checkbox name="telemetry" label="Include timing headers" />
              </Stack>
            </Drawer>
            <Popover id="showcase-pop" triggerLabel="Native Popover (0 KB JS)">
              <p style="margin:0">Powered by HTML popover + CSS anchor positioning.</p>
            </Popover>
          </Cluster>
        </Stack>
      </section>

      <Grid min="19rem" gap="1.25rem">
        <Card>
          <CardHeader>Zero-JS Form Controls</CardHeader>
          <CardBody>
            <Stack gap="1rem">
              <Field id="project" label="Project Name" hint="Lowercase slug">
                <input id="project" name="project" type="text" placeholder="my-kay-app" />
              </Field>
              <Switch name="strict" label="Strict zero-JS static routes" checked />
              <Checkbox name="compile" label="Build single executable (--compile)" checked />
              <RadioGroup
                name="deploy"
                legend="Target"
                defaultValue="binary"
                options={[
                  { value: 'binary', label: 'Single Bun binary', hint: '35ms cold start' },
                  { value: 'static', label: 'Static HTML export', hint: 'CDN-ready' },
                ]}
              />
            </Stack>
          </CardBody>
          <CardFooter>
            <Button tone="accent">Save preferences</Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>@kayjs/auth — Live Progressive Auth</CardHeader>
          <CardBody>
            {locals?.user
              ? (
                  <Stack gap="0.75rem">
                    <Notice tone="success">
                      Signed in as <strong>{locals.user.email}</strong>
                    </Notice>
                    <Cluster>
                      <Button href="/account" tone="accent">Open Guarded Account</Button>
                      <form action="/auth/signout" method="post">
                        <Button type="submit" variant="outline">Sign out</Button>
                      </form>
                    </Cluster>
                  </Stack>
                )
              : (
                  <form action="/auth/signup" method="post">
                    <Stack gap="0.85rem">
                      <input type="hidden" name="redirect" value="/account" />
                      <Field id="auth-email" label="Email" required>
                        <input id="auth-email" name="email" type="email" placeholder="you@example.com" required />
                      </Field>
                      <Field id="auth-pass" label="Password" hint="Min 8 characters" required>
                        <input id="auth-pass" name="password" type="password" minlength="8" required />
                      </Field>
                      <Button type="submit" tone="accent">Create account &amp; enter /account</Button>
                    </Stack>
                  </form>
                )}
          </CardBody>
        </Card>
      </Grid>

      <Card>
        <CardHeader>Interactive Islands (Auto-Hydrated)</CardHeader>
        <CardBody>
          <Stack gap="1.25rem">
            <Cluster>
              <Menu
                label="Actions Menu"
                items={[
                  { id: 'dup', label: 'Duplicate' },
                  { id: 'arc', label: 'Archive' },
                  { id: 'del', label: 'Delete' },
                ]}
              />
              <Select
                name="grammar"
                ariaLabel="Preferred grammar"
                defaultValue="editorial"
                options={[
                  { value: 'editorial', label: 'Editorial' },
                  { value: 'workshop', label: 'Workshop' },
                  { value: 'console', label: 'Console' },
                  { value: 'soft', label: 'Soft' },
                ]}
              />
              <ToastTrigger />
            </Cluster>

            <Tabs
              defaultValue="overview"
              items={[
                { id: 'overview', label: 'Overview', content: 'Roving arrow-key navigation powered by createTabs() and O(1) selector().' },
                { id: 'layers', label: 'CSS Layers', content: 'Every rule lives inside @layer kui so Tailwind utilities or app CSS always win without !important.' },
                { id: 'eject', label: 'Single-File Eject', content: 'Run `kay ui-eject editorial` to own 1 CSS file while keeping upstream a11y & behavior upgrades.' },
              ]}
            />

            <Accordion>
              <AccordionItem title="Does Accordion ship client JavaScript?" group="faq" open>
                No — it uses native HTML <code>&lt;details name="faq"&gt;</code> for exclusive disclosure with 0 KB JS.
              </AccordionItem>
              <AccordionItem title="Can I mix Tailwind v4 classes on top?" group="faq">
                Yes — because all @kayjs/ui styles live in <code>@layer kui</code>, Tailwind utilities override cleanly with zero specificity battles.
              </AccordionItem>
            </Accordion>
          </Stack>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>DataTable Island (Sort, Filter, Select, Paginate)</CardHeader>
        <CardBody>
          <DataTable
            rows={SAMPLE_ROWS}
            pageSize={4}
            selectable
            columns={[
              { key: 'pkg', label: 'Package' },
              { key: 'loc', label: 'LOC' },
              { key: 'role', label: 'Role' },
            ]}
          />
        </CardBody>
      </Card>
    </Stack>
  )
}
