import { content } from '@kayjs/content'
import { seo } from '@kayjs/seo'
import { ui } from '@kayjs/ui/plugin'
import { defineConfig } from '@kayjs/kay/config'
import { posts } from './src/posts'

export default defineConfig({
  lang: 'en',
  plugins: [
    ui({ grammar: 'editorial' }),
    seo({ site: 'https://example.com', titleTemplate: '%s — __APP_NAME__' }),
    content({
      feeds: [{
        path: '/rss.xml',
        title: '__APP_NAME__',
        description: 'Articles & notes',
        site: 'https://example.com',
        linkPrefix: '/blog',
        collection: posts,
      }],
    }),
  ],
})
