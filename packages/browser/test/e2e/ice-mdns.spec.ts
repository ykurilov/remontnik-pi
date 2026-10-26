import { createSocket } from 'node:dgram'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test, type Page } from '@playwright/test'
import { createProfiles } from '../../src/profiles/index.js'

// Имя `.local` у кандидата ICE Chromium разрешает мультикастом mDNS в локальную сеть, мимо прокси службы: страница
// унесла бы пароль в имени кандидата. Тест слушает мультикаст на этой машине и проверяет, что профиль службы его не
// шлёт. Контроли: свой запрос слушатель видит, обычный Chromium без флагов службы имя в мультикаст отправляет.

async function mdnsListener() {
  const seen: string[] = []
  const socket = createSocket({ type: 'udp4', reuseAddr: true })
  socket.on('message', (message) => seen.push(message.toString('latin1')))
  await new Promise<void>((resolve) => socket.bind(5353, () => resolve()))
  socket.addMembership('224.0.0.251')
  return { seen, close: () => socket.close() }
}

function dnsQuery(name: string): Buffer {
  const labels = name.split('.').map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)]))
  return Buffer.concat([Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]), ...labels, Buffer.from([0, 0, 1, 0, 1])])
}

const ICE_PROBE = (marker: string) => `(async () => {
  const offerer = new RTCPeerConnection()
  offerer.createDataChannel('x')
  const offer = await offerer.createOffer()
  const answerer = new RTCPeerConnection()
  await answerer.setRemoteDescription(offer)
  await answerer.setLocalDescription(await answerer.createAnswer())
  await answerer.addIceCandidate({ candidate: 'candidate:1 1 udp 2122260223 ${marker}.local 54321 typ host', sdpMid: '0', sdpMLineIndex: 0 })
  await new Promise((resolve) => setTimeout(resolve, 4000))
  return { state: answerer.iceConnectionState }
})()`

async function evaluateUnsealed(page: Page, expression: string): Promise<unknown> {
  const cdp = await page.context().newCDPSession(page)
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'probe' })
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, contextId: executionContextId, awaitPromise: true, returnByValue: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}

test('имя .local у кандидата ICE не уходит в мультикаст mDNS: обычный Chromium шлёт, профиль службы — нет', async () => {
  test.setTimeout(60_000)
  const mdns = await mdnsListener()
  const site = createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<title>x</title>'))
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve))
  const siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`
  try {
    // Контроль слушателя: свой запрос виден.
    const sender = createSocket('udp4')
    await new Promise<void>((resolve) => sender.send(dnsQuery('listenercontrol.local'), 5353, '224.0.0.251', () => resolve()))
    sender.close()
    await expect.poll(() => mdns.seen.some((text) => text.includes('listenercontrol'))).toBe(true)

    // Контроль Chromium: без флагов службы имя уходит в мультикаст.
    const plain = await chromium.launch()
    const plainPage = await plain.newPage()
    await plainPage.goto(siteUrl)
    await plainPage.evaluate(ICE_PROBE('plaincontrolmarker'))
    await plain.close()
    await expect.poll(() => mdns.seen.some((text) => text.includes('plaincontrolmarker'))).toBe(true)

    const profiles = createProfiles({
      dataDir: mkdtempSync(join(tmpdir(), 'remontnik-mdns-probe-')),
      policy: { allowedOrigins: [siteUrl], allowedMutations: [], profiles: [{ name: 'remontnik' }] },
      log: () => {},
    })
    try {
      const session = await profiles.get('remontnik')
      await session.page.goto(siteUrl)
      await evaluateUnsealed(session.page, ICE_PROBE('serviceprofilemarker'))
    } finally {
      await profiles.closeAll()
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
    expect(mdns.seen.some((text) => text.includes('serviceprofilemarker'))).toBe(false)
  } finally {
    mdns.close()
    site.close()
  }
})
