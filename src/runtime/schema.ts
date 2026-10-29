import type { TSchema } from 'elysia'
import type { ByteSize } from './byte-size'
import { t as schema } from 'elysia'
import { byteSize } from './byte-size'
import { DEFAULT_MAX_LENGTH } from './schema-bounds'

type Builder = typeof schema

// `s.String`, bounded to `DEFAULT_MAX_LENGTH` unless the options bound it with a `maxLength`, an `enum` or a `const`.
function BoundedString(options: Parameters<Builder['String']>[0] = {}): ReturnType<Builder['String']> {
  const bounded = 'maxLength' in options || 'enum' in options || 'const' in options

  return schema.String(bounded ? options : { ...options, maxLength: DEFAULT_MAX_LENGTH })
}

// A string of at least 32 characters that production must set, and development and tests derive from the project path, so a secret needs no placeholder in the app: read it with `defineEnv`.
function Secret(options: Parameters<Builder['String']>[0] = {}): ReturnType<Builder['String']> {
  return schema.String({ ...options, minLength: Math.max(32, (options as { minLength?: number }).minLength ?? 0), requiredInProduction: true, secret: true })
}

// A field of `defineEnv` an island may read, as `publicEnv` from `kay`, such as a map key or an analytics id; a name such as `STRIPE_SECRET` or `DATABASE_URL` is refused at boot, since every visitor reads it.
function Public<Field extends TSchema>(field: Field): Field & { public: true } {
  return { ...field, public: true }
}

// Elysia's `UnionEnum` fills the first value in as `default`, so an optional field read as that value when left out and a required one was never refused; kay leaves `default` out unless the options give one.
const UnionEnum: Builder['UnionEnum'] = (values, options) => {
  const field = schema.UnionEnum(values, options)

  if (options === undefined || !('default' in options))
    delete (field as { default?: unknown }).default

  return field
}

// A `UnionEnum` of a record's keys, typed as their union, for a `select` whose options come from a record of labels.
function UnionKeys<const Keyed extends object>(record: Keyed, options?: Parameters<Builder['UnionEnum']>[1]): ReturnType<typeof schema.UnionEnum<[keyof Keyed & string, ...(keyof Keyed & string)[]]>> {
  const keys = Object.keys(record)

  if (keys.length === 0)
    throw new Error('kay: s.UnionKeys() takes a record with at least one key')

  return UnionEnum(keys as [keyof Keyed & string, ...(keyof Keyed & string)[]], options)
}

type FileOptions = Omit<NonNullable<Parameters<Builder['File']>[0]>, 'minSize' | 'maxSize'> & { minSize?: ByteSize | undefined, maxSize?: ByteSize | undefined }
type FilesOptions = Omit<NonNullable<Parameters<Builder['Files']>[0]>, 'minSize' | 'maxSize'> & { minSize?: ByteSize | undefined, maxSize?: ByteSize | undefined }

// Elysia reads `'2m'` and `'600k'`, kay everywhere else `'2mb'` and `'600kb'`: the sizes of a file field are read as the action's `maxSize` is and handed to Elysia as bytes.
function sized<Options extends { minSize?: ByteSize | undefined, maxSize?: ByteSize | undefined }>(options: Options | undefined, name: string): (Omit<Options, 'minSize' | 'maxSize'> & { minSize?: number, maxSize?: number }) | undefined {
  if (options === undefined)
    return undefined

  const { minSize, maxSize, ...rest } = options

  return {
    ...rest,
    ...minSize !== undefined && { minSize: byteSize(minSize, `${name}({ minSize })`) },
    ...maxSize !== undefined && { maxSize: byteSize(maxSize, `${name}({ maxSize })`) },
  }
}

const File = (options?: FileOptions): ReturnType<Builder['File']> => schema.File(sized(options, 's.File'))
const Files = (options?: FilesOptions): ReturnType<Builder['Files']> => schema.Files(sized(options, 's.Files'))

// Elysia's schema builder, re-exported so an action's schema needs no import of its own, with `Secret` and `Public` for `defineEnv`, `UnionKeys`, and `File` and `Files` taking a size as an action's `maxSize` does.
// kept: free
export const s: Omit<Builder, 'File' | 'Files'> & { File: typeof File, Files: typeof Files, Secret: typeof Secret, Public: typeof Public, UnionKeys: typeof UnionKeys } = { ...schema, String: BoundedString, UnionEnum, File, Files, Secret, Public, UnionKeys }
