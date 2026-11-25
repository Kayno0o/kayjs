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
  Field,
  Grid,
  Menu,
  Notice,
  RadioGroup,
  Select,
  Stack,
  Switch,
  Tabs,
} from '@kayjs/ui'
import { Head } from 'kay'
import { GrammarDemo } from '../components/GrammarDemo'

export const prerender = true

export default function GrammarsPage() {
  return (
    <main class="docs-container" style="padding-top:2.5rem;padding-bottom:4rem">
      <Head>
        <title>UI Style Grammars</title>
        <meta name="description" content="Switch @kayjs/ui between Orbit, Editorial, Workshop, Console, Soft, and Bare in pure CSS with zero JS styling runtime." />
      </Head>

      <Stack gap="2rem">
        <div>
          <div class="docs-eyebrow">
            <span class="docs-eyebrow-dot" />
            @kayjs/ui · Pure CSS @layer kui
          </div>
          <h1 style="margin:0 0 0.65rem;font-family:var(--ui-font-display);font-size:clamp(2rem,3.5vw,2.75rem);line-height:1.12">
            Same DOM. Five structurally different apps.
          </h1>
          <p class="docs-lead" style="margin-bottom:1.25rem">
            Switch the active CSS Grammar below without touching a single component or shipping a JS recipe engine.
            Every grammar is a single self-contained file you can eject and own with <code>kay ui-eject</code>.
          </p>
          <GrammarDemo />
        </div>

        <Grid min="20rem" gap="1.25rem">
          <Card>
            <CardHeader>Zero-JS Form Controls</CardHeader>
            <CardBody>
              <Stack gap="0.9rem">
                <Field id="project-slug" label="Project slug" hint="Lowercase URL-safe identifier">
                  <input id="project-slug" type="text" value="orbit-app" />
                </Field>
                <Switch name="strict" label="Zero-JS static routes by default" checked />
                <Checkbox name="compile" label="Compile single Bun executable (--compile)" checked />
                <RadioGroup
                  name="target"
                  legend="Deploy target"
                  defaultValue="binary"
                  options={[
                    { value: 'binary', label: 'Single executable', hint: '35ms cold start' },
                    { value: 'static', label: 'Static HTML export', hint: 'CDN-ready' },
                  ]}
                />
              </Stack>
            </CardBody>
            <CardFooter>
              <Cluster>
                <Button tone="accent" size="sm">Save settings</Button>
                <Button variant="ghost" size="sm">Reset</Button>
              </Cluster>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>Cockpit States &amp; Interactive Islands</CardHeader>
            <CardBody>
              <Stack gap="1rem">
                <Cluster>
                  <Badge tone="accent">v2.0-beta</Badge>
                  <Badge tone="success">38/38 pass</Badge>
                  <Badge tone="warning">experimental</Badge>
                  <Badge tone="danger">breaking</Badge>
                </Cluster>
                <Notice tone="accent">
                  All styles live inside <code>@layer kui</code> so your app CSS or Tailwind utilities always win without <code>!important</code>.
                </Notice>
                <Cluster>
                  <Menu
                    label="Actions Menu"
                    items={[
                      { id: 'eject', label: 'kay ui-eject orbit' },
                      { id: 'build', label: 'kay build --static' },
                      { id: 'compile', label: 'kay build --compile' },
                    ]}
                  />
                  <Select
                    name="default-grammar"
                    ariaLabel="Default Grammar"
                    defaultValue="orbit"
                    options={[
                      { value: 'orbit', label: 'Orbit' },
                      { value: 'editorial', label: 'Editorial' },
                      { value: 'workshop', label: 'Workshop' },
                      { value: 'console', label: 'Console' },
                      { value: 'soft', label: 'Soft' },
                    ]}
                  />
                </Cluster>
                <Tabs
                  defaultValue="css"
                  items={[
                    { id: 'css', label: 'Pure CSS', content: 'Every grammar is a single ~3–4 KB brotli CSS file with native light-dark() support.' },
                    { id: 'eject', label: 'One-File Eject', content: 'Run `kay ui-eject orbit` to copy the entire grammar into your repo and customize freely.' },
                  ]}
                />
                <Accordion>
                  <AccordionItem group="g-faq" title="Does Accordion ship client JS?" open>
                    <p style="margin:0">No — it uses native HTML <code>&lt;details name="g-faq"&gt;</code> for exclusive disclosure with 0 KB JS.</p>
                  </AccordionItem>
                  <AccordionItem group="g-faq" title="Can I customize just the accent color?">
                    <p style="margin:0">Yes — set <code>:root {'{ --ui-accent: #7cc4e8; }'}</code> in your own stylesheet.</p>
                  </AccordionItem>
                </Accordion>
              </Stack>
            </CardBody>
          </Card>
        </Grid>
      </Stack>
    </main>
  )
}
