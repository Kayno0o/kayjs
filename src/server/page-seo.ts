import type { HeadTag } from '../runtime/head'
import { localeState } from '../runtime/locale-state'
import { localizedText } from '../runtime/localized'
import { pageSeo } from './page-settings'

// The head tags a module's `page.seo` gives, its text read in the locale being rendered: registered as a group before the module's own `head`, so the module's blocks still win and the page's win over its layouts'.
export function seoTags(module: object): HeadTag[] {
  if ((module as { page?: { seo?: unknown } }).page?.seo === undefined)
    return []

  const state = localeState()
  const text = (name: 'title' | 'description' | 'image' | 'canonical') => localizedText(pageSeo(module, name) as string | undefined, state?.locale, state?.settings.defaultLocale)
  const [title, description, image, canonical] = [text('title'), text('description'), text('image'), text('canonical')]
  const tags: HeadTag[] = []

  if (title !== undefined)
    tags.push({ tag: 'title', props: { children: title } })

  if (description !== undefined)
    tags.push({ tag: 'meta', props: { name: 'description', content: description } })

  if (image !== undefined)
    tags.push({ tag: 'meta', props: { property: 'og:image', content: image } })

  if (canonical !== undefined)
    tags.push({ tag: 'link', props: { rel: 'canonical', href: canonical } })

  return tags
}
