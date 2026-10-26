import type { PluginServerContext } from '@getpaseo/plugin/server'
import { startPaseoBridgePlugin } from './server/plugin-runtime.js'

// Серверная часть плагина Paseo: мост Ремонтника. Настройка — ~/.config/remontnik/paseo-bridge.json.

export default function contribute(server: PluginServerContext) {
  const runtime = startPaseoBridgePlugin(server)
  return () => runtime.stop()
}
