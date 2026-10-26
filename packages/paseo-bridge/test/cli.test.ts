import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runPaseoCommand } from '../server/index.js'
import {
  BLOG_SECRET,
  FakeDoctor,
  FakePaseo,
  SHOP_AGENT,
  SHOP_SECRET,
  BLOG_AGENT,
  makeConfig,
  shopTask,
  signedPost,
  startBridge,
  until,
} from './bridge-world.js'

let doctor: FakeDoctor
let paseo: FakePaseo
let started: Awaited<ReturnType<typeof startBridge>>
let configFile: string

function writeOwnerConfig(apps: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'remontnik-paseo-cli-'))
  const secrets: Record<string, string> = { shop: SHOP_SECRET, blog: BLOG_SECRET }
  const entries: Record<string, unknown> = {}
  for (const app of apps) {
    const secretFile = join(directory, `${app}-bridge`)
    writeFileSync(secretFile, secrets[app]!)
    entries[app] = { agentId: `agent-${app}`, doctorUrl: doctor.url, secretFile }
  }
  const { port } = new URL(started.server.url)
  const file = join(directory, 'paseo-bridge.json')
  writeFileSync(file, JSON.stringify({ listen: `127.0.0.1:${port}`, apps: entries }))
  return file
}

async function run(argv: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await runPaseoCommand(argv, {
    env: { REMONTNIK_PASEO_BRIDGE_CONFIG: configFile },
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  })
  return { code, stdout, stderr }
}

beforeEach(async () => {
  doctor = new FakeDoctor(SHOP_SECRET)
  await doctor.start()
  paseo = new FakePaseo()
  paseo.states.set(SHOP_AGENT, 'idle')
  paseo.states.set(BLOG_AGENT, 'idle')
  started = await startBridge({ config: makeConfig({ shop: doctor.url, blog: doctor.url }), paseo })
  await signedPost(`${started.server.url}/v1/tasks`, shopTask(), SHOP_SECRET)
  await until(() => paseo.letters.length === 1)
  configFile = writeOwnerConfig(['shop'])
})

afterEach(async () => {
  await started.close()
  await doctor.stop()
})

const handoffs = () =>
  doctor.requests.filter((request) => request.path.startsWith('/v1/handoffs/')).map((request) => [request.path, JSON.parse(request.body)])

describe('remontnik-paseo', () => {
  it('accept, done и cannot доходят до врача через мост', async () => {
    expect((await run(['accept', '7'])).code).toBe(0)
    expect((await run(['done', '7', '--commit', 'abc1234', '--deployed', 'v12'])).code).toBe(0)
    expect((await run(['done', '7'])).code).toBe(0)
    expect((await run(['cannot', '7', '--reason', 'нужна схема базы'])).code).toBe(0)
    const taskId = shopTask().taskId
    expect(handoffs()).toEqual([
      ['/v1/handoffs/7/accepted', { taskId, agent: SHOP_AGENT }],
      ['/v1/handoffs/7/result', { taskId, kind: 'done', commit: 'abc1234', deployed: true, version: 'v12' }],
      ['/v1/handoffs/7/result', { taskId, kind: 'done', deployed: false }],
      ['/v1/handoffs/7/result', { taskId, kind: 'cannot', reason: 'нужна схема базы' }],
    ])
  })

  it('case печатает подробности случая', async () => {
    const result = await run(['case', '7'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ case: { id: 7 } })
  })

  it('ошибки: нет причины у cannot, чужой случай, неизвестная команда; секрет не печатается', async () => {
    const noReason = await run(['cannot', '7'])
    expect(noReason.code).not.toBe(0)
    expect(noReason.stderr).toMatch(/--reason/)

    const unknownCase = await run(['accept', '99'])
    expect(unknownCase.code).not.toBe(0)
    expect(unknownCase.stderr).toContain('unknown_task')

    const unknownCommand = await run(['deploy', '7'])
    expect(unknownCommand.code).not.toBe(0)

    expect(JSON.stringify([noReason, unknownCase, unknownCommand])).not.toContain(SHOP_SECRET)
    expect(handoffs()).toEqual([])
  })

  it('несколько приложений в настройке — нужен --app', async () => {
    configFile = writeOwnerConfig(['shop', 'blog'])
    const ambiguous = await run(['accept', '7'])
    expect(ambiguous.code).not.toBe(0)
    expect(ambiguous.stderr).toMatch(/--app/)
    expect((await run(['accept', '7', '--app', 'shop'])).code).toBe(0)
  })
})
