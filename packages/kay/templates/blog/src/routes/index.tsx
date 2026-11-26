import { Badge, Card, CardBody, CardFooter, CardHeader, Cluster, Stack } from '@kayjs/ui'
import { posts } from '../posts'

export const prerender = true

export default async function BlogIndex() {
  const list = posts.all()
  return (
    <Stack gap="lg">
      <h1 class="page-title">Articles</h1>
      {list.map(post => (
        <Card key={post.slug}>
          <CardHeader>
            <a href={`/blog/${post.slug}`} class="post-link">{post.data.title}</a>
          </CardHeader>
          <CardBody>
            <p class="post-desc">{post.data.description ?? ''}</p>
          </CardBody>
          <CardFooter>
            <Cluster>
              <span>{post.data.date} · {post.readingMinutes} min read</span>
              {(post.data.tags ?? []).map(tag => <Badge key={tag}>{tag}</Badge>)}
            </Cluster>
          </CardFooter>
        </Card>
      ))}
    </Stack>
  )
}
