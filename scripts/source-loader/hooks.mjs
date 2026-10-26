// Пакеты `@ykurilov/remontnik-*` берутся из `packages/*/src`, а `./x.js` внутри исходников — из `./x.ts`.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packagesDirectory = fileURLToPath(new URL('../../packages/', import.meta.url))
const KIT_PACKAGE = /^@ykurilov\/remontnik-([a-z-]+)(?:\/(.+))?$/

export async function resolve(specifier, context, nextResolve) {
  const kit = KIT_PACKAGE.exec(specifier)
  if (kit) {
    const [, name, subpath] = kit
    const file = `${packagesDirectory}${name}/src/${subpath ? `${subpath}/` : ''}index.ts`
    return { url: pathToFileURL(file).href, shortCircuit: true }
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const candidate = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL)
    if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
