import { importModule } from './bundle'

// The exports of a page file. With `skipBroken`, a file that fails to compile has none, and its failure goes into `broken` for the checks naming one of its actions.
export async function actionModule(file: string, skipBroken: boolean | undefined, broken: Map<string, string>): Promise<Record<string, unknown>> {
  try {
    return await importModule<Record<string, unknown>>(file)
  }
  catch (error) {
    if (skipBroken !== true || !(error instanceof Error) || error.name !== 'KayCompileError')
      throw error

    broken.set(file, error.message)

    return {}
  }
}
