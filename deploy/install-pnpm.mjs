// Ставит pnpm в образ Ремонтника только после сверки архива с хешем, записанным здесь: реестр или сеть
// не подменят его незаметно. Новая версия pnpm — новые PNPM_VERSION и PNPM_INTEGRITY (поле `dist.integrity`
// в метаданных пакета), одной правкой этого файла.
// Запуск при сборке образа: node install-pnpm.mjs
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNPM_VERSION = '10.33.2'
const PNPM_INTEGRITY = 'sha512-qQ+vb+6rca1sblf5Tg/hoS9dzCLNdU20CulZPraj4LaxLjVAIYuzeuCDQEsfLObbKkEh6XmCm0r/lLmfSdoc+A=='
const tarballUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`

const response = await fetch(tarballUrl, { redirect: 'error' })
if (!response.ok) throw new Error(`pnpm ${PNPM_VERSION} не скачался: ${response.status}`)
const tarball = Buffer.from(await response.arrayBuffer())
const actual = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
if (actual !== PNPM_INTEGRITY) throw new Error(`архив pnpm ${PNPM_VERSION} не совпал с записанным хешем: ${actual}`)

const dir = mkdtempSync(join(tmpdir(), 'pnpm-'))
const file = join(dir, `pnpm-${PNPM_VERSION}.tgz`)
writeFileSync(file, tarball)
// Из локального файла: у pnpm нет зависимостей, npm больше ничего не скачивает.
execFileSync('npm', ['install', '--global', '--offline', '--no-audit', '--no-fund', file], { stdio: 'inherit' })
rmSync(dir, { recursive: true, force: true })
execFileSync('npm', ['cache', 'clean', '--force'], { stdio: 'inherit' })
console.log(`pnpm ${PNPM_VERSION} поставлен, хеш сверен`)
