// Проверка открытости по всей истории git: `.private/` не побывала ни в одном коммите, `gitleaks` не находит
// ключей ни в одном коммите. С флагом `--trees` дополнительно прогоняется `check-public` по дереву каждого коммита.
// Историю скрипт только читает: ничего не переписывает и не отправляет.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPublic } from './check-public.mjs'

const PRIVATE_FOLDER = /^\.private(\/|$)/

function git(repository, args) {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 })
}

/** Пути из `.private/`, которые когда-либо попадали в любой коммит любой ветки. */
export function findPrivateInHistory(repository) {
  const paths = git(repository, ['log', '--all', '--name-only', '--format='])
    .split('\n')
    .filter((path) => PRIVATE_FOLDER.test(path))
  return [...new Set(paths)]
}

/** `null` — gitleaks не установлен. Иначе строки с находками. Ложные срабатывания закрывает `.gitleaksignore`. */
export function runGitleaks(repository) {
  const result = spawnSync('gitleaks', ['git', '--redact', '--no-banner', '--log-opts=--all', repository], { encoding: 'utf8' })
  if (result.error?.code === 'ENOENT') return null
  if (result.status === 0) return []
  return [`gitleaks нашёл ключи в истории:\n${result.stdout}${result.stderr}`.trim()]
}

/** `check-public` по дереву каждого коммита: деревья выгружаются во временную папку, по одному. */
export function checkPublicInEveryCommit(repository) {
  const problems = []
  const scratch = mkdtempSync(join(tmpdir(), 'check-history-'))
  try {
    for (const commit of git(repository, ['rev-list', '--all']).split('\n').filter(Boolean)) {
      const folder = join(scratch, commit)
      mkdirSync(folder)
      execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', repository, commit, folder])
      for (const problem of checkPublic(folder)) problems.push(`${commit.slice(0, 7)}: ${problem}`)
      rmSync(folder, { recursive: true, force: true })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repository = process.cwd()
  const withTrees = process.argv.includes('--trees')
  if (!existsSync(join(repository, '.git'))) {
    // Например, копия для прогона на другом компьютере: истории в ней нет, проверять нечего.
    console.log('check-history: пропущено, в папке нет истории git')
    process.exit(0)
  }
  const problems = []

  const privatePaths = findPrivateInHistory(repository)
  if (privatePaths.length > 0) problems.push(`.private/ попадала в историю: ${privatePaths.join(', ')}`)

  const leaks = runGitleaks(repository)
  if (leaks === null) {
    problems.push('gitleaks не установлен (brew install gitleaks): история на ключи не проверена')
  } else {
    problems.push(...leaks)
  }

  if (withTrees) problems.push(...checkPublicInEveryCommit(repository))

  if (problems.length > 0) {
    console.error(problems.join('\n'))
    process.exit(1)
  }
  console.log(`check-history: история чиста${withTrees ? ' (в том числе деревья всех коммитов)' : ''}`)
}
