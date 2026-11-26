import { Head } from '@kayjs/kay'
import { CopyCommand } from '../components/CopyCommand'
import { highlight } from '../highlight'

export const prerender = true

const ROUTE_CODE = `// Async route: strictly server-only (0 KB shipped)
import { db } from '../db'
import { Counter } from '../components/Counter'

export default async function Home() {
  const posts = await db.query('SELECT * FROM posts')

  return (
    <main>
      <h1>Latest posts</h1>
      <Counter initial={posts.length} $hydrate="visible" />
      <ul>
        {posts.map(p => <li key={p.id}>{p.title}</li>)}
      </ul>
    </main>
  )
}`

const ISLAND_CODE = `// Auto-detected island: no 'use client', no client:load
import { computed, signal } from '@kayjs/kay'

export function Counter({ initial = 0 }: { initial?: number }) {
  const count = signal(initial)
  const doubled = computed(() => count.value * 2)

  return (
    <button onClick={() => count.value++}>
      Count: {count.value} (×2 = {doubled.value})
    </button>
  )
}`

const ACTION_CODE = `// Progressive <form action={save}> AND typed island RPC
import { action } from '@kayjs/kay/server'
import { z } from 'zod'

export const save = action(
  z.object({ title: z.string().min(1) }),
  async (input, ctx) => {
    const id = await db.insert(input.title, ctx.locals.user)
    return { ok: true, id }
  },
)`

const ECOSYSTEM = [
  { name: '@kayjs/ui', badge: '5 CSS Grammars', accent: true, href: '/docs/plugins/ui', desc: 'Platform-first headless primitives & pure CSS @layer kui grammars (Orbit, Editorial, Workshop, Console, Soft). Eject in one command.' },
  { name: '@kayjs/auth', badge: '0 external deps', accent: false, href: '/docs/plugins/auth', desc: 'Argon2id passwords, hashed sessions, email verification, magic links, OAuth 2.0 + PKCE, route guards, RGPD helpers & bun:sqlite.' },
  { name: '@kayjs/content', badge: 'Bun.markdown', accent: false, href: '/docs/plugins/content', desc: 'Zero-dep Markdown collections, nested Bun.YAML frontmatter, lazy render(), Shiki highlight, MDX-lite TSX & RSS.' },
  { name: '@kayjs/mcp', badge: 'Streamable HTTP', accent: false, href: '/docs/plugins/mcp', desc: 'Expose typed server actions as bearer-authenticated MCP tools with schema compaction, shared schemas, resources & footprint budgets.' },
  { name: '@kayjs/live', badge: '0 external deps', accent: false, href: '/docs/plugins/live', desc: 'Typed SSE rooms, microtask-coalesced presence broadcasts, and reactive useLive() browser signal hooks.' },
  { name: '@kayjs/images & seo', badge: 'AVIF / WebP', accent: false, href: '/docs/plugins/images-and-seo', desc: 'Build-time responsive images with disk cache, 1200×630 OG shareCard() PNGs, self-hosted fonts, JSON-LD & sitemaps.' },
  { name: '@kayjs/i18n · mail', badge: '0 external deps', accent: false, href: '/docs/plugins/ecosystem', desc: 'Localized URL rewriting, hreflang & kay i18n-check; Resend HTTP transport with a dev-only /_kay/mail outbox.' },
  { name: '@kayjs/spa · tailwind · icons', badge: 'Opt-in', accent: false, href: '/docs/plugins/ecosystem', desc: 'In-place SPA swaps with [data-persist] islands, Tailwind v4 integration, and zero-runtime inline ~icons/* SVGs.' },
  { name: 'KayPlugin API', badge: 'Extensible', accent: false, href: '/docs/production/plugin-api', desc: 'Server routes, middleware, build & post-prerender hooks, kay check checks, Bun.build plugins, and custom CLI commands.' },
]

export default function HomePage() {
  const routeHtml = highlight(ROUTE_CODE, 'tsx')
  const islandHtml = highlight(ISLAND_CODE, 'tsx')
  const actionHtml = highlight(ACTION_CODE, 'ts')

  return (
    <main class="docs-container">
      <Head>
        <title>kay — Standard TSX. Automatic islands. Built for Bun.</title>
      </Head>

      <section class="docs-hero">
        <div>
          <div class="docs-eyebrow">
            <span class="docs-eyebrow-dot" />
            Bun-Native · Standard TSX · 0 KB Static
          </div>
          <h1>
            Standard TSX.
            <br />
            <span>Automatic islands.</span>
          </h1>
          <p class="docs-lead">
            Write plain TypeScript and JSX — no <code>'use client'</code>, no <code>client:load</code>.
            Static UI compiles to flat HTML strings; interactive components automatically become sub-kilobyte signal islands.
          </p>
          <div class="docs-actions">
            <a data-ui="button" data-tone="accent" href="/docs/getting-started/quickstart">Get Started →</a>
            <a data-ui="button" data-variant="outline" href="/grammars">Live UI Grammars</a>
            <a data-ui="button" data-variant="ghost" href="/docs/production/migrating-from-v1">v1 → v2 Migration</a>
          </div>
          <CopyCommand command="bunx @kayjs/kay@beta new my-app --template app" $hydrate="idle" />
        </div>

        <div class="hero-code-card" role="group" aria-label="Kay v2 code examples">
          <input class="hero-code-input" type="radio" name="hero-code" id="hc-route" checked />
          <label class="hero-code-tab" for="hc-route">routes/index.tsx</label>
          <div class="hero-code-panel" innerHTML={routeHtml} />

          <input class="hero-code-input" type="radio" name="hero-code" id="hc-island" />
          <label class="hero-code-tab" for="hc-island">Counter.tsx</label>
          <div class="hero-code-panel" innerHTML={islandHtml} />

          <input class="hero-code-input" type="radio" name="hero-code" id="hc-action" />
          <label class="hero-code-tab" for="hc-action">actions/save.ts</label>
          <div class="hero-code-panel" innerHTML={actionHtml} />

          <div class="hero-code-spacer">
            <span class="hero-pill">0 KB static</span>
          </div>

          <div class="hero-code-foot">
            <span>oxc-parser → flat SSR string + &lt;kay-island&gt;</span>
            <span style="color:var(--ui-accent)">18.8 ms clean build</span>
          </div>
        </div>
      </section>

      <section class="docs-kpis" aria-label="Measured performance highlights">
        <div class="docs-kpi">
          <div class="docs-kpi-val">18.8<span> ms</span></div>
          <div class="docs-kpi-lbl">Clean production build</div>
          <div class="docs-kpi-sub">single-pass Bun.build</div>
        </div>
        <div class="docs-kpi">
          <div class="docs-kpi-val">0.32<span> KB</span></div>
          <div class="docs-kpi-lbl">Client island runtime</div>
          <div class="docs-kpi-sub">brotli · 0 KB on static pages</div>
        </div>
        <div class="docs-kpi">
          <div class="docs-kpi-val">7,017<span>/s</span></div>
          <div class="docs-kpi-lbl">SSR throughput</div>
          <div class="docs-kpi-sub">flat string concatenation</div>
        </div>
        <div class="docs-kpi">
          <div class="docs-kpi-val">35.4<span> ms</span></div>
          <div class="docs-kpi-lbl">Single-binary cold start</div>
          <div class="docs-kpi-sub">kay build --compile</div>
        </div>
      </section>

      <section id="ecosystem" class="docs-section">
        <div class="docs-sec-head">
          <div>
            <div class="docs-sec-kicker">Modular KayPlugin Ecosystem</div>
            <h2 class="docs-sec-title">Tiny 6.9k LOC core. Opt-in everything else.</h2>
          </div>
          <span style="font-family:var(--ui-font-mono);font-size:0.78rem;color:var(--ui-muted)">13 packages · zero core leaks</span>
        </div>
        <div class="eco-grid">
          {ECOSYSTEM.map(pkg => (
            <a key={pkg.name} class="eco-card" href={pkg.href}>
              <div class="eco-top">
                <span class="eco-name">{pkg.name}</span>
                <span data-ui="badge" data-tone={pkg.accent ? 'accent' : undefined}>{pkg.badge}</span>
              </div>
              <p class="eco-desc">{pkg.desc}</p>
            </a>
          ))}
        </div>
      </section>

      <section id="benchmarks" class="docs-section">
        <div class="docs-sec-head">
          <div>
            <div class="docs-sec-kicker">Measured Benchmarks</div>
            <h2 class="docs-sec-title">How Kay v2 compares</h2>
          </div>
          <span style="font-family:var(--ui-font-mono);font-size:0.78rem;color:var(--ui-muted)">Bun 1.4.5 · mitata · lower JS/build is better</span>
        </div>
        <div class="bench-wrap">
          <table class="bench-table">
            <thead>
              <tr>
                <th>Framework</th>
                <th>Products JS (gz)</th>
                <th>Table JS (gz)</th>
                <th>SSR (renders/s)</th>
                <th>Create 10k rows</th>
                <th>Clean build</th>
              </tr>
            </thead>
            <tbody>
              <tr class="bench-row-kay">
                <td>Kay v2</td>
                <td>2.62 KB</td>
                <td>4.93 KB</td>
                <td>7,017/s</td>
                <td>219.1 ms</td>
                <td>18.8 ms</td>
              </tr>
              <tr>
                <td>Kay v1</td>
                <td>11.40 KB</td>
                <td>13.80 KB</td>
                <td>3,983/s</td>
                <td>262.0 ms</td>
                <td>460 ms</td>
              </tr>
              <tr>
                <td>SolidStart</td>
                <td>8.20 KB</td>
                <td>8.20 KB</td>
                <td>1,712/s</td>
                <td>226.0 ms</td>
                <td>140 ms</td>
              </tr>
              <tr>
                <td>SvelteKit</td>
                <td>22.50 KB</td>
                <td>22.50 KB</td>
                <td>3,861/s</td>
                <td>232.0 ms</td>
                <td>90 ms</td>
              </tr>
              <tr>
                <td>Astro</td>
                <td>8.60 KB</td>
                <td>9.60 KB</td>
                <td>1,898/s</td>
                <td>234.0 ms</td>
                <td>1,190 ms</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </main>
  )
}
