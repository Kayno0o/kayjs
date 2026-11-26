import type { StandardSchemaV1 } from '@kayjs/kay/server'
import { defineCollection } from '@kayjs/content'

export interface PostMeta {
  title: string
  date: string
  description?: string
  tags?: string[]
  draft?: boolean
}

// Any Standard Schema validator works here (Zod, Valibot, ArkType); this one keeps the template free of dependencies.
const postSchema: StandardSchemaV1<unknown, PostMeta> = {
  '~standard': {
    version: 1,
    vendor: 'app',
    validate(raw: unknown) {
      const data = raw as Partial<PostMeta>
      if (typeof data.title !== 'string' || typeof data.date !== 'string')
        return { issues: [{ message: 'A post needs a title and a date', path: ['title'] }] }
      return { value: data as PostMeta }
    },
  },
}

export const posts = defineCollection({ dir: 'content/posts', schema: postSchema })
