// Проверка точных версий: у pi-durable, pi-ai и chord не должно быть диапазонов,
// а в репозитории — настроек автообновления (Dependabot, Renovate).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_PACKAGES = [
  '@earendil-works/pi-durable',
  '@earendil-works/pi-ai',
  '@earendil-works/chord',
]
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
]
const AUTOUPDATE_FILES = [
  '.github/dependabot.yml',
  '.github/dependabot.yaml',
  'renovate.json',
  'renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
  '.renovaterc.json5',
  '.github/renovate.json',
  '.github/renovate.json5',
]
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.private', 'dist'])
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function findPackageJsonFiles(directory, found = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue
    const full = join(directory, entry)
    if (statSync(full).isDirectory()) findPackageJsonFiles(full, found)
    else if (entry === 'package.json') found.push(full)
  }
  return found
}

export function checkPins(rootDirectory) {
  const problems = []

  for (const file of findPackageJsonFiles(rootDirectory)) {
    const name = relative(rootDirectory, file)
    const manifest = JSON.parse(readFileSync(file, 'utf8'))
    for (const section of DEPENDENCY_SECTIONS) {
      for (const pinned of PINNED_PACKAGES) {
        const version = manifest[section]?.[pinned]
        if (version !== undefined && !EXACT_VERSION.test(version)) {
          problems.push(`${name}: ${pinned} в ${section} — «${version}», нужна точная версия`)
        }
      }
    }
    if (manifest.renovate !== undefined) {
      problems.push(`${name}: ключ renovate — автообновление в этом репозитории запрещено`)
    }
  }

  for (const file of AUTOUPDATE_FILES) {
    if (existsSync(join(rootDirectory, file))) {
      problems.push(`${file}: настройки автообновления запрещены`)
    }
  }

  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = checkPins(process.cwd())
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log('check-pins: версии закреплены точно, автообновлений нет')
}
