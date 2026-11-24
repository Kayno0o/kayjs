import type { ContentEntry } from '@kayjs/content'
import type { RequestContext } from 'kay/server'
import { join } from 'node:path'
import { shareCard } from '@kayjs/images'
import { Head } from 'kay'
import { type DocFrontmatter, docs, DOCS_ROOT, getFlatNav, getNavGroups, type NavItem, SECTIONS } from '../../content'

export const prerender = true

const COPY_CODE_SCRIPT = `document.addEventListener('click',function(e){var b=e.target&&e.target.closest?e.target.closest('.docs-code-copy'):null;if(!b)return;var p=b.closest('.docs-code');var pre=p&&p.querySelector('pre');var t=pre?pre.textContent||'':'';(navigator.clipboard&&navigator.clipboard.writeText?navigator.clipboard.writeText(t):Promise.reject()).catch(function(){var a=document.createElement('textarea');a.value=t;a.style.cssText='position:fixed;opacity:0';document.body.appendChild(a);a.select();document.execCommand('copy');a.remove()}).finally(function(){b.textContent='Copied';b.setAttribute('data-copied','true');clearTimeout(b._t);b._t=setTimeout(function(){b.textContent='Copy';b.removeAttribute('data-copied')},1800)})});`

export function paths(): string[] {
  return docs.paths('/docs')
}

interface DocPageData {
  entry: ContentEntry<DocFrontmatter>
  sectionLabel: string
  groups: ReturnType<typeof getNavGroups>
  prev: NavItem | undefined
  next: NavItem | undefined
  ogImage: string
}

export function load(ctx: RequestContext): DocPageData | Response {
  const slug = ctx.params.slug ?? ''
  const entry = docs.get(slug)
  if (!entry)
    return new Response('Doc page not found', { status: 404 })

  const groups = getNavGroups()
  const flat = getFlatNav()
  const idx = flat.findIndex(item => item.slug === entry.slug)
  const sectionLabel = SECTIONS.find(s => s.id === entry.data.section)?.label ?? entry.data.section
  const ogImage = shareCard({
    title: entry.data.title,
    badge: sectionLabel,
    image: join(DOCS_ROOT, 'src/kay-card.svg'),
  })

  return {
    entry,
    sectionLabel,
    groups,
    prev: idx > 0 ? flat[idx - 1] : undefined,
    next: idx >= 0 && idx < flat.length - 1 ? flat[idx + 1] : undefined,
    ogImage,
  }
}

export default function DocPage({ data }: { data: DocPageData }) {
  const { entry, sectionLabel, groups, prev, next, ogImage } = data
  const tocHeadings = entry.headings.filter(h => h.level === 2 || h.level === 3)

  return (
    <div class="docs-shell-width docs-layout">
      <Head>
        <title>{entry.data.title}</title>
        <meta name="description" content={entry.data.description} />
        <meta property="og:image" content={ogImage} />
      </Head>

      <aside class="docs-sidebar" aria-label="Documentation sections">
        <div class="docs-sidebar-sticky">
          {groups.map(group => (
            <div key={group.id} class="sb-group">
              <div class="sb-title">{group.label}</div>
              <ul class="sb-list">
                {group.items.map(item => (
                  <li key={item.slug}>
                    <a href={item.href} aria-current={item.slug === entry.slug ? 'page' : undefined}>
                      {item.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside>

      <article class="docs-article">
        <details class="docs-mobile-nav">
          <summary>Menu — {sectionLabel}</summary>
          <div class="docs-mobile-nav-body">
            {groups.map(group => (
              <div key={group.id} class="sb-group">
                <div class="sb-title">{group.label}</div>
                <ul class="sb-list">
                  {group.items.map(item => (
                    <li key={item.slug}>
                      <a href={item.href} aria-current={item.slug === entry.slug ? 'page' : undefined}>
                        {item.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </details>

        <div class="docs-crumb">
          {sectionLabel} <span>/</span> {entry.data.title}
        </div>
        <h1>{entry.data.title}</h1>
        <p class="docs-article-lead">{entry.data.description}</p>

        <div class="docs-prose" innerHTML={{ __html: entry.html }} />
        <script>{COPY_CODE_SCRIPT}</script>

        <nav class="docs-pager" aria-label="Page pagination">
          {prev !== undefined
            ? (
                <a class="docs-pager-card" href={prev.href}>
                  <div class="docs-pager-dir">← Previous</div>
                  <div class="docs-pager-name">{prev.title}</div>
                </a>
              )
            : <span />}
          {next !== undefined && (
            <a class="docs-pager-card docs-pager-next" href={next.href}>
              <div class="docs-pager-dir">Next →</div>
              <div class="docs-pager-name">{next.title}</div>
            </a>
          )}
        </nav>
      </article>

      <aside class="docs-toc" aria-label="On this page">
        <div class="docs-toc-sticky">
          {tocHeadings.length > 0 && (
            <>
              <div class="docs-toc-title">On this page</div>
              <ul class="docs-toc-list">
                {tocHeadings.map(h => (
                  <li key={h.id} style={h.level === 3 ? 'padding-left:0.75rem' : undefined}>
                    <a href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
          <div class="docs-toc-meta">
            <a href="/llms.txt"><span>→</span> View llms.txt (1-page ref)</a>
            <a href="/grammars"><span>→</span> Live UI Grammars</a>
            <a href={`https://github.com/Kayno0o/kayjs/blob/v2/docs/src/content/docs/${entry.slug}.md`}>
              <span>→</span> Edit on GitHub
            </a>
          </div>
        </div>
      </aside>
    </div>
  )
}
