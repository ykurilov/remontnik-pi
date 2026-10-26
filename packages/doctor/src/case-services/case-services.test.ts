import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { CaseNetworks } from '../case-networks/index.js'
import { caseServicesCompose, createCaseServices, parseServicesFile } from './index.js'

const PIN = `@sha256:${'a'.repeat(64)}`

// Службы для тестов приложения (`checks.services`): врач поднимает их отдельным проектом compose в сети проверок
// своего случая. Портов наружу, томов, секретов и прав сверх обычных у них нет; после проверок они убираются.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'remontnik-services-'))
  dirs.push(dir)
  return dir
}

const POSTGRES = `
services:
  db:
    image: postgres:17-alpine${PIN}
    environment:
      POSTGRES_PASSWORD: test
      POSTGRES_HOST_AUTH_METHOD: trust
    tmpfs: /var/lib/postgresql/data
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: 1s
      retries: 30
  cache:
    image: redis:7${PIN}
    command: redis-server --save ""
    depends_on:
      db:
        condition: service_healthy
`

describe('файл служб', () => {
  it('разрешённые поля переносятся как есть, окружение — словарём строк', () => {
    const services = parseServicesFile(POSTGRES)
    expect(services.db).toEqual({
      image: `postgres:17-alpine${PIN}`,
      environment: { POSTGRES_PASSWORD: 'test', POSTGRES_HOST_AUTH_METHOD: 'trust' },
      tmpfs: ['/var/lib/postgresql/data'],
      healthcheck: { test: ['CMD', 'pg_isready', '-U', 'postgres'], interval: '1s', retries: 30 },
    })
    expect(services.cache).toEqual({ image: `redis:7${PIN}`, command: 'redis-server --save ""', depends_on: { db: { condition: 'service_healthy' } } })
  })

  it('окружение списком «ИМЯ=значение» и зависимость списком', () => {
    const services = parseServicesFile(`services:\n  db:\n    image: postgres:17${PIN}\n    environment: ["A=1", "B=x=y"]\n  worker:\n    image: busybox${PIN}\n    depends_on: [db]\n`)
    expect(services.db!.environment).toEqual({ A: '1', B: 'x=y' })
    expect(services.worker!.depends_on).toEqual({ db: { condition: 'service_started' } })
  })

  it.each([
    ['ports', '    ports: ["5432:5432"]'],
    ['expose', '    expose: ["5432"]'],
    ['volumes', '    volumes: ["/srv:/data"]'],
    ['privileged', '    privileged: true'],
    ['cap_add', '    cap_add: [NET_ADMIN]'],
    ['network_mode', '    network_mode: host'],
    ['networks', '    networks: [default]'],
    ['pid', '    pid: host'],
    ['env_file', '    env_file: .env'],
    ['build', '    build: .'],
    ['secrets', '    secrets: [key]'],
    ['devices', '    devices: ["/dev/sda"]'],
    ['extra_hosts', '    extra_hosts: ["remontnik-gateway:10.0.0.1"]'],
    ['container_name', '    container_name: db'],
    ['labels', '    labels: { remontnik.case-services: other }'],
  ])('поле службы %s — отказ', (key, line) => {
    expect(() => parseServicesFile(`services:\n  db:\n    image: postgres:17${PIN}\n${line}\n`)).toThrow(new RegExp(key))
  })

  it.each([
    ['volumes', 'volumes:\n  data: {}\n'],
    ['networks', 'networks:\n  outside: {}\n'],
    ['secrets', 'secrets:\n  key: { file: /etc/passwd }\n'],
    ['include', 'include: [other.yml]\n'],
  ])('раздел файла %s — отказ', (key, text) => {
    expect(() => parseServicesFile(`services:\n  db:\n    image: postgres:17${PIN}\n${text}`)).toThrow(new RegExp(key))
  })

  it.each([
    ['без закрепления', 'postgres:17-alpine'],
    ['только тег', 'postgres:latest'],
    ['короткий отпечаток', 'postgres@sha256:abc'],
  ])('образ %s — отказ: нужен @sha256', (_, image) => {
    expect(() => parseServicesFile(`services:\n  db:\n    image: ${image}\n`)).toThrow(/services\.db\.image.*@sha256/)
  })

  it('образ, закреплённый по @sha256, принимается', () => {
    expect(parseServicesFile(`services:\n  db:\n    image: postgres${PIN}\n`).db!.image).toBe(`postgres${PIN}`)
  })

  it.each([
    ['$VAR в команде', 'command: echo $DEEPSEEK_API_KEY'],
    ['${VAR} в окружении', 'environment: { KEY: "${DEEPSEEK_API_KEY}" }'],
    ['${VAR:-x} в проверке готовности', 'healthcheck: { test: ["CMD-SHELL", "pg_isready -U ${USER:-postgres}"] }'],
    ['одиночный $ в конце', 'command: echo cost$'],
  ])('подстановка переменных: %s — отказ', (_, line) => {
    expect(() => parseServicesFile(`services:\n  db:\n    image: postgres${PIN}\n    ${line}\n`)).toThrow(/подстановка переменных врача запрещена, пишите \$\$/)
  })

  it('«$$» принимается и сохраняется как есть', () => {
    const services = parseServicesFile(`services:\n  db:\n    image: postgres${PIN}\n    healthcheck: { test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER"] }\n`)
    expect(services.db!.healthcheck!.test).toEqual(['CMD-SHELL', 'pg_isready -U $$POSTGRES_USER'])
  })

  it('без служб, без образа, с чужой зависимостью или кривым именем — отказ', () => {
    expect(() => parseServicesFile('name: x\n')).toThrow(/services/)
    expect(() => parseServicesFile('services:\n  db:\n    command: x\n')).toThrow(/image/)
    expect(() => parseServicesFile(`services:\n  db:\n    image: x${PIN}\n    depends_on: [nope]\n`)).toThrow(/nope/)
    expect(() => parseServicesFile(`services:\n  Db.1:\n    image: x${PIN}\n`)).toThrow(/Db\.1/)
    expect(() => parseServicesFile('services: [\n')).toThrow(/разобрать/)
  })
})

describe('проект compose для случая', () => {
  it('службы — только в сети проверок случая, с метками, пределами и без лишних прав; «$$» остаётся как есть', () => {
    const services = parseServicesFile(`services:\n  db:\n    image: postgres:17${PIN}\n    command: echo $$HOME\n`)
    const compose = caseServicesCompose({ project: 'remontnik-services-abc', services, networkId: 'net-id-1', memory: '1g', cpus: '1' }) as any
    expect(compose.name).toBe('remontnik-services-abc')
    expect(compose.networks).toEqual({ case: { external: true, name: 'net-id-1' } })
    expect(compose.volumes).toBeUndefined()
    const db = compose.services.db
    expect(db.networks).toEqual({ case: {} })
    expect(db.labels).toEqual({ 'remontnik.case-services': 'remontnik-services-abc' })
    // Compose сам превратит `$$` в `$` внутри контейнера; подставлять из окружения врача ему нечего.
    expect(db.command).toBe('echo $$HOME')
    expect(db).toMatchObject({ mem_limit: '1g', memswap_limit: '1g', cpus: '1', pids_limit: 512, restart: 'no', security_opt: ['no-new-privileges:true'] })
    expect(db.cap_drop).toEqual(expect.arrayContaining(['NET_RAW']))
    expect(db.ports).toBeUndefined()
  })
})

/** Подставной docker: пишет вызовы и копирует себе файл проекта compose; `ps` выдаёт старые службы. */
function fakeDocker(root: string, options: { upFails?: boolean; stale?: string[] } = {}) {
  const log = join(root, 'calls.log')
  const docker = join(root, 'docker')
  writeFileSync(
    docker,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${log}'`,
      `env | grep -q DEEPSEEK && echo LEAK >> '${log}'`,
      'prev=""',
      `for a in "$@"; do if [ "$prev" = "-f" ]; then cp "$a" '${root}/compose.json'; fi; prev="$a"; done`,
      'case "$1 $*" in',
      `  "compose "*" up "*) ${options.upFails ? "echo 'db unhealthy' >&2; exit 1" : 'exit 0'};;`,
      `  "ps "*) printf '%s\\n' ${(options.stale ?? []).map((id) => `'${id}'`).join(' ')};;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return {
    docker,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []),
    compose: () => JSON.parse(readFileSync(join(root, 'compose.json'), 'utf8')),
  }
}

function fakeNetworks() {
  const leases: string[] = []
  let open = 0
  const networks: CaseNetworks = {
    async use(copyDir, kind) {
      leases.push(`${kind} ${copyDir}`)
      open += 1
      return { network: { id: `${kind}-net-id`, name: `remontnik-case-${kind}`, kind, gatewayIp: '10.213.0.34' }, done: () => void (open -= 1) }
    },
    removeStale: async () => {},
    close: async () => {},
  }
  return { networks, leases, open: () => open }
}

describe('подъём и уборка служб', () => {
  it('службы поднимаются в сети проверок своей копии и ждут готовности; потом убираются вместе с томами', async () => {
    const root = tempDir()
    const fake = fakeDocker(root)
    const networks = fakeNetworks()
    const caseServices = createCaseServices({ docker: fake.docker, caseNetworks: networks.networks })
    process.env.DEEPSEEK_API_KEY = 'test-secret-should-not-leak'
    let running
    try {
      running = await caseServices.up('/srv/worktrees/case-1-candidate', POSTGRES)
    } finally {
      delete process.env.DEEPSEEK_API_KEY
    }
    expect(networks.leases).toEqual(['checks /srv/worktrees/case-1-candidate'])
    const up = fake.calls().find((call) => call.includes(' up '))!
    expect(up).toMatch(new RegExp(`^compose -p ${running.project} -f \\S+ --project-directory \\S+ up -d --wait --wait-timeout \\d+$`))
    expect(fake.calls()).not.toContain('LEAK')
    expect(fake.compose().networks).toEqual({ case: { external: true, name: 'checks-net-id' } })
    expect(Object.keys(fake.compose().services)).toEqual(['db', 'cache'])
    // Сеть держится, пока службы идут: врач не удалит её по простою.
    expect(networks.open()).toBe(1)
    await running.down()
    expect(fake.calls().at(-1)).toMatch(new RegExp(`^compose -p ${running.project} -f \\S+ --project-directory \\S+ down -v --remove-orphans`))
    expect(networks.open()).toBe(0)
  })

  it('у соседних копий — разные проекты compose', async () => {
    const root = tempDir()
    const fake = fakeDocker(root)
    const caseServices = createCaseServices({ docker: fake.docker, caseNetworks: fakeNetworks().networks })
    const a = await caseServices.up('/srv/worktrees/case-1-candidate', POSTGRES)
    const b = await caseServices.up('/srv/worktrees/case-2-candidate', POSTGRES)
    expect(a.project).not.toBe(b.project)
    expect(a.project).toMatch(/^remontnik-services-[0-9a-f]+$/)
    await a.down()
    await b.down()
  })

  it('службы не поднялись → то, что успело подняться, убирается, сеть отпускается, ошибка с причиной', async () => {
    const root = tempDir()
    const fake = fakeDocker(root, { upFails: true })
    const networks = fakeNetworks()
    const caseServices = createCaseServices({ docker: fake.docker, caseNetworks: networks.networks })
    await expect(caseServices.up('/srv/worktrees/case-1-candidate', POSTGRES)).rejects.toThrow(/unhealthy/)
    expect(fake.calls().at(-1)).toMatch(/ down -v --remove-orphans/)
    expect(networks.open()).toBe(0)
  })

  it('файл служб с запрещённым полем → docker не вызывается, сеть не берётся', async () => {
    const root = tempDir()
    const fake = fakeDocker(root)
    const networks = fakeNetworks()
    const caseServices = createCaseServices({ docker: fake.docker, caseNetworks: networks.networks })
    await expect(caseServices.up('/srv/worktrees/case-1-candidate', `services:\n  db:\n    image: x${PIN}\n    ports: ["5432:5432"]\n`)).rejects.toThrow(/ports/)
    expect(fake.calls()).toEqual([])
    expect(networks.leases).toEqual([])
  })

  it('сеть взята, а папка проекта не создалась → сеть отпускается', async () => {
    const root = tempDir()
    const fake = fakeDocker(root)
    const networks = fakeNetworks()
    const caseServices = createCaseServices({ docker: fake.docker, caseNetworks: networks.networks })
    const previous = process.env.TMPDIR
    process.env.TMPDIR = join(root, 'no-such-dir')
    try {
      await expect(caseServices.up('/srv/worktrees/case-1-candidate', POSTGRES)).rejects.toThrow()
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
    expect(networks.leases).toEqual(['checks /srv/worktrees/case-1-candidate'])
    expect(networks.open()).toBe(0)
  })

  it('сеть не далась → папки проекта не остаётся', async () => {
    const root = tempDir()
    const fake = fakeDocker(root)
    const networks = fakeNetworks()
    const caseServices = createCaseServices({
      docker: fake.docker,
      caseNetworks: { ...networks.networks, use: async () => Promise.reject(new Error('сеть не создалась')) },
    })
    const scratch = join(root, 'tmp')
    mkdirSync(scratch)
    const previous = process.env.TMPDIR
    process.env.TMPDIR = scratch
    try {
      await expect(caseServices.up('/srv/worktrees/case-1-candidate', POSTGRES)).rejects.toThrow(/сеть не создалась/)
    } finally {
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
    }
    expect(readdirSync(scratch)).toEqual([])
  })

  it('на старте врача службы прошлого запуска удаляются вместе с томами', async () => {
    const root = tempDir()
    const fake = fakeDocker(root, { stale: ['old-db', 'old-cache'] })
    await createCaseServices({ docker: fake.docker, caseNetworks: fakeNetworks().networks }).removeStale()
    expect(fake.calls()).toEqual(['ps -aq --filter label=remontnik.case-services', 'rm -fv old-db old-cache'])
  })
})
