import type { RequestContext } from '@kayjs/kay/server'
import { Button, Stack } from '@kayjs/ui'
import { Head } from '@kayjs/kay'
import { posts } from '../../posts'

export const prerender = true
export function paths() {
  return posts.paths('/blog')
}

export async function load(ctx: RequestContext) {
  const post = posts.get(ctx.params.slug ?? '')
  if (!post)
    return new Response('Not found', { status: 404 })
  return { post }
}

export default function PostPage({ data }: { data: { post: NonNullable<ReturnType<typeof posts.get>> } }) {
  const { post } = data
  return (
    <Stack gap="md">
      <Head><title>{post.data.title}</title></Head>
      <article>
        <h1 class="post-title">{post.data.title}</h1>
        <p class="post-meta">{post.data.date} · {post.readingMinutes} min read</p>
        <div innerHTML={post.html} />
      </article>
      <div><Button href="/" variant="outline">← All posts</Button></div>
    </Stack>
  )
}
