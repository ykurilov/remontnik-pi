// Браузер Ремонтника: служба с командами для врача, сохранённые входы без утечки паролей, живой экран владельца.
export { type ActionResult, BROWSER_COMMANDS, type BrowserCommand, type BrowserCommandRunner, createBrowserActions } from './actions/index.js'
export { DANGER_KINDS, type DangerKind, checkDanger, decideRequest, detectHumanCheck, isAllowedOrigin, matchesMutation } from './guard/index.js'
export { type ControlLock, OWNER_SILENCE_LIMIT_MS, createControlLock } from './live/control.js'
export { type LiveScreen, parseLiveListen, startLiveScreen } from './live/server.js'
export { type BrowserPolicy, type BrowserProfileConfig, loadBrowserPolicy, parseBrowserPolicy } from './policy/index.js'
export { createBrowserHttpServer } from './service/index.js'
export { type BrowserServiceOptions, type RunningBrowserService, startBrowserService, startBrowserServiceFromEnv } from './service/start.js'
export {
  type LoginSummary,
  type LoginVault,
  type OutputFilter,
  VaultKeyError,
  createOutputFilter,
  loginVaultPath,
  openLoginVault,
  parseVaultKey,
} from './vault/index.js'
export { runBrowserCli } from './cli/index.js'
