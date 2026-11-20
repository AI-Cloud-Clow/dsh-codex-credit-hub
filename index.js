import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'codex-credit-hub'
export const inject = ['connection', 'credentials', 'tools']

export const RECORD_SCOPE = 'codex-credit-hub'
export const RECORD_ID_API = 'codex-api'

const CODEX_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_WEB_URL = 'https://chatgpt.com/codex/settings/usage'
const OPENAI_CREDIT_GRANTS_URL = 'https://api.openai.com/v1/dashboard/billing/credit_grants'
const OPENAI_ONBOARDING_LOGIN_URL = 'https://api.openai.com/v1/dashboard/onboarding/login'
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const OPENAI_PLATFORM_CLIENT_ID = 'app_2SKx67EdpoN0G6j64rFvigXD'
const OPENAI_PLATFORM_RESOURCE = 'https://api.openai.com/v1'
const OPENAI_API_WEB_URL = 'https://platform.openai.com/home'
const OPENAI_PLATFORM_HOME_URL = 'https://platform.openai.com/home'
const OPENAI_BROWSER_SYNC_COOLDOWN_MS = 60_000

export const Config = z.object({
  refreshIntervalSec: z.number().min(15).max(3600).default(60).volatile(),
  displayFormat: z.union([z.const('both'), z.const('remaining'), z.const('percent')]).default('both').volatile(),
})

function readVolatile(field, fallback) {
  if (field !== null && typeof field === 'object' && typeof field.get === 'function') {
    return field.get() ?? fallback
  }
  return field ?? fallback
}

function resolveCodexHome() {
  const custom = typeof process.env.CODEX_HOME === 'string' ? process.env.CODEX_HOME.trim() : ''
  return custom || join(homedir(), '.codex')
}

function codexAuthPath() {
  return join(resolveCodexHome(), 'auth.json')
}

export function normalizeSecretInput(raw) {
  if (typeof raw !== 'string') return ''
  let text = raw.trim()
  if (!text) return ''
  if (/^Bearer\s+/i.test(text)) {
    text = text.replace(/^Bearer\s+/i, '').trim()
  }
  return text
}

export function scrubSecrets(text) {
  return String(text ?? '')
    .replace(/sk-(?:proj-|admin-|svcacct-)?[A-Za-z0-9_-]{12,}/g, '[redacted-key]')
    .replace(/sess-[A-Za-z0-9_-]{8,}/g, '[redacted-sess]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/rt[._-][A-Za-z0-9._~+/=-]{8,}/g, '[redacted-refresh]')
    .replace(/("?(?:refresh_token|refreshToken|access_token|accessToken|id_token|idToken|sessionKey|sensitive_id)"?\s*:\s*")[^"]+(")/g, '$1[redacted]$2')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .slice(0, 1000)
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function isJwtExpired(token, skewMs = 60_000) {
  const payload = decodeJwtPayload(token)
  const exp = Number(payload?.exp ?? 0)
  if (!Number.isFinite(exp) || exp <= 0) return false
  const expMs = exp > 1e12 ? exp : exp * 1000
  return Date.now() + skewMs >= expMs
}

function requestFailure(error, label) {
  if (error?.name === 'TimeoutError') {
    return { ok: false, status: 0, network: true, message: `${label} 网络请求超时，请检查网络或代理连接` }
  }
  if (error?.name === 'AbortError') return { ok: false, status: 0, message: `${label} 请求已取消` }
  return {
    ok: false,
    status: 0,
    network: true,
    message: scrubSecrets(`${label} 网络请求失败，请检查网络或代理连接 (${error instanceof Error ? error.message : String(error)})`),
  }
}

function getFetchEnv() {
  const hasProxy = Boolean(
    process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy,
  )
  if (hasProxy && process.env.NODE_USE_ENV_PROXY === undefined) {
    // Enable Node 22.19+ / 24+ built-in environment proxy support when the user
    // configured HTTP(S)_PROXY, so pure Node renewal shares the terminal proxy.
    process.env.NODE_USE_ENV_PROXY = '1'
  }
}

async function fetchJson(url, options, label) {
  getFetchEnv()
  try {
    const response = await fetch(url, options)
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch {}
    const html = /(?:<!doctype\s+html|<html[\s>])/i.test(text)
    return { response, body, html }
  } catch (error) {
    return { error: requestFailure(error, label) }
  }
}

function combineSignals(externalSignal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  if (!externalSignal) return timeoutSignal
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([externalSignal, timeoutSignal])
  }
  return externalSignal
}

function formatWindowDuration(seconds) {
  const sec = Number(seconds ?? 0)
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const hours = Math.round(sec / 3600)
  if (hours >= 24 && hours % 24 === 0) return `${hours / 24}d`
  if (hours >= 1) return `${hours}h`
  return `${Math.max(1, Math.round(sec / 60))}m`
}

function parseOptionalFiniteNumber(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string' && value.trim() === '') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

function normalizeWindow(win, kind = 'wham') {
  if (!win || typeof win !== 'object') return null
  const usedPercentRaw = kind === 'rpc' ? win.usedPercent : win.used_percent
  const parsedUsed = parseOptionalFiniteNumber(usedPercentRaw) ?? 0
  const usedPercent = Math.max(0, Math.min(100, parsedUsed))
  const remainingPercent = Number(Math.max(0, 100 - usedPercent).toFixed(2))
  const windowSeconds = kind === 'rpc'
    ? (parseOptionalFiniteNumber(win.windowDurationMins) ?? 0) * 60
    : (parseOptionalFiniteNumber(win.limit_window_seconds) ?? 0)
  const resetAtSec = kind === 'rpc'
    ? (parseOptionalFiniteNumber(win.resetsAt) ?? 0)
    : (parseOptionalFiniteNumber(win.reset_at) ?? 0)
  const resetAtMs = resetAtSec > 0
    ? (resetAtSec > 1e12 ? resetAtSec : resetAtSec * 1000)
    : null
  return {
    usedPercent: Number(usedPercent.toFixed(2)),
    remainingPercent,
    windowSeconds,
    windowLabel: formatWindowDuration(windowSeconds),
    resetAtMs,
  }
}

async function readCodexAuthFile() {
  try {
    const raw = await readFile(codexAuthPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function extractCliIdentity(authJson) {
  const idPayload = decodeJwtPayload(authJson?.tokens?.id_token)
  const authClaim = idPayload?.['https://api.openai.com/auth'] ?? {}
  return {
    email: typeof idPayload?.email === 'string' ? idPayload.email : '',
    planType: typeof authClaim?.chatgpt_plan_type === 'string' ? authClaim.chatgpt_plan_type : '',
    accountId: authJson?.tokens?.account_id || authClaim?.chatgpt_account_id || '',
  }
}

export async function fetchCodexWhamUsage(accessToken, accountId, signal, identity = {}) {
  const token = normalizeSecretInput(accessToken)
  if (!token) {
    return { ok: false, status: 401, message: '未检测到有效的 Codex CLI ChatGPT OAuth 凭证' }
  }
  if (isJwtExpired(token)) {
    return { ok: false, status: 401, expired: true, message: 'Codex CLI access_token 已过期' }
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  }
  if (accountId) headers['ChatGPT-Account-Id'] = accountId

  const result = await fetchJson(CODEX_WHAM_USAGE_URL, {
    method: 'GET',
    headers,
    signal: combineSignals(signal, 10_000),
  }, 'Codex CLI')
  if (result.error) return result.error
  const { response, body, html } = result
  if (html || response.status === 401 || response.status === 403) {
    return { ok: false, status: 401, message: 'Codex CLI 登录已失效，请在终端运行 `codex login` 重新登录' }
  }
  if (!response.ok || !body || typeof body !== 'object') {
    const errMsg = body?.detail || body?.error?.message || body?.message || `Codex CLI 额度读取失败 (HTTP ${response.status})`
    return { ok: false, status: response.status, message: scrubSecrets(errMsg) }
  }

  const rateLimit = body.rate_limit ?? null
  const primary = normalizeWindow(rateLimit?.primary_window, 'wham')
  const secondary = normalizeWindow(rateLimit?.secondary_window, 'wham')
  if (!rateLimit && !body.credits) {
    return { ok: false, status: 401, message: 'Codex CLI 响应未包含额度信息，请检查登录状态' }
  }
  const effective = primary ?? secondary ?? {
    usedPercent: rateLimit?.limit_reached ? 100 : 0,
    remainingPercent: rateLimit?.limit_reached ? 0 : 100,
    windowSeconds: 0,
    windowLabel: '',
    resetAtMs: null,
  }
  const creditsObj = body.credits ?? {}
  const creditBalance = parseOptionalFiniteNumber(creditsObj.balance)
  const resetCreditsCount = parseOptionalFiniteNumber(body.rate_limit_reset_credits?.available_count) ?? 0

  return {
    ok: true,
    data: {
      provider: 'codex-cli',
      planType: String(body.plan_type || identity.planType || ''),
      email: String(body.email || identity.email || ''),
      accountId: String(body.account_id || accountId || ''),
      allowed: rateLimit?.allowed !== false,
      limitReached: Boolean(rateLimit?.limit_reached),
      remainingPercent: effective.remainingPercent,
      usedPercent: effective.usedPercent,
      primaryWindow: primary,
      secondaryWindow: secondary,
      codeReviewWindow: normalizeWindow(body.code_review_rate_limit?.primary_window, 'wham'),
      hasCredits: Boolean(creditsObj.has_credits),
      unlimitedCredits: Boolean(creditsObj.unlimited),
      creditBalance,
      resetCreditsCount,
      fetchedAt: Date.now(),
      webUrl: CODEX_WEB_URL,
    },
  }
}

export async function fetchCodexViaAppServer(signal) {
  if (signal?.aborted) return { ok: false, status: 0, message: 'Codex CLI 请求已取消' }
  const envPath = [
    process.env.PATH ?? '',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(homedir(), '.local', 'bin'),
  ].filter(Boolean).join(delimiter)

  return await new Promise((resolve) => {
    let settled = false
    const child = spawn('codex', ['app-server'], {
      env: { ...process.env, PATH: envPath },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    })

    let accountResult = null
    let accountReceived = false
    let rateLimitsResult = null
    let rateLimitsReceived = false
    let buffer = ''
    let stderr = ''
    let initialized = false
    let exited = false
    let killTimer = null

    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (!exited) {
        try { child.kill('SIGTERM') } catch {}
        killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 400)
        killTimer.unref?.()
      }
      resolve(outcome)
    }

    const tryFinishBoth = () => {
      if (!accountReceived || !rateLimitsReceived) return
      const limits = rateLimitsResult?.rateLimits ?? {}
      const primary = normalizeWindow(limits.primary, 'rpc')
      const secondary = normalizeWindow(limits.secondary, 'rpc')
      const acct = accountResult?.account ?? {}
      if (!acct.type && !primary && !secondary) {
        finish({
          ok: false,
          status: 401,
          message: 'Codex CLI 尚未登录，请在终端运行 `codex login`',
        })
        return
      }
      const effective = primary ?? secondary ?? {
        usedPercent: 0,
        remainingPercent: 100,
        windowSeconds: 0,
        windowLabel: '',
        resetAtMs: null,
      }
      const creditsObj = limits.credits ?? {}
      const balance = parseOptionalFiniteNumber(creditsObj.balance)
      finish({
        ok: true,
        data: {
          provider: 'codex-cli',
          planType: String(limits.planType || acct.planType || ''),
          email: String(acct.email || ''),
          accountId: String(rateLimitsResult?.accountId || accountResult?.workspaceRouting?.chatgptAccountId || ''),
          allowed: rateLimitsResult?.ordinaryUsageAllowed !== false,
          limitReached: effective.usedPercent >= 100,
          remainingPercent: effective.remainingPercent,
          usedPercent: effective.usedPercent,
          primaryWindow: primary,
          secondaryWindow: secondary,
          codeReviewWindow: null,
          hasCredits: Boolean(creditsObj.hasCredits),
          unlimitedCredits: Boolean(creditsObj.unlimited),
          creditBalance: balance,
          resetCreditsCount: parseOptionalFiniteNumber(rateLimitsResult?.rateLimitResetCredits?.availableCount) ?? 0,
          fetchedAt: Date.now(),
          webUrl: CODEX_WEB_URL,
        },
      })
    }

    const onAbort = () => finish({ ok: false, status: 0, message: 'Codex CLI 请求已取消' })
    signal?.addEventListener('abort', onAbort, { once: true })

    const timer = setTimeout(() => {
      finish({ ok: false, status: 0, message: 'codex app-server 读取超时（10 秒）' })
    }, 10_000)
    timer.unref?.()

    child.on('error', (error) => {
      exited = true
      if (error?.code === 'ENOENT') {
        finish({ ok: false, status: 404, missingCli: true, message: '未检测到 codex CLI 命令，请确认已安装 Codex CLI 并登录' })
      } else {
        finish({ ok: false, status: 0, message: scrubSecrets(`无法启动 codex app-server: ${error.message}`) })
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let msg = null
        try { msg = JSON.parse(trimmed) } catch { continue }
        if (msg.id === 1 && !initialized) {
          if (msg.error) {
            finish({ ok: false, status: 500, message: scrubSecrets(msg.error.message || 'codex app-server 初始化失败') })
            return
          }
          initialized = true
          try {
            child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
            child.stdin.write(JSON.stringify({ id: 2, method: 'account/read', params: {} }) + '\n')
            child.stdin.write(JSON.stringify({ id: 3, method: 'account/rateLimits/read', params: {} }) + '\n')
          } catch (error) {
            finish({ ok: false, status: 500, message: scrubSecrets(error instanceof Error ? error.message : String(error)) })
          }
        } else if (msg.id === 2) {
          accountReceived = true
          accountResult = msg.error ? { error: msg.error } : msg.result
          tryFinishBoth()
        } else if (msg.id === 3) {
          if (msg.error) {
            finish({
              ok: false,
              status: 401,
              message: scrubSecrets(msg.error.message || 'Codex CLI 尚未登录或无法读取额度'),
            })
            return
          }
          rateLimitsReceived = true
          rateLimitsResult = msg.result
          tryFinishBoth()
        }
      }
    })

    child.on('close', (code) => {
      exited = true
      if (killTimer) {
        clearTimeout(killTimer)
        killTimer = null
      }
      if (!settled) {
        finish({
          ok: false,
          status: 401,
          message: scrubSecrets(stderr.trim() || `codex app-server 提前退出 (code=${code})`),
        })
      }
    })

    try {
      child.stdin.write(JSON.stringify({
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'dsh-codex-credit-hub', version: '1.2.1' } },
      }) + '\n')
    } catch (error) {
      finish({ ok: false, status: 500, message: scrubSecrets(error instanceof Error ? error.message : String(error)) })
    }
  })
}

async function fetchOpenAiCreditBalance(sessionKey, organizationId = '', signal) {
  const key = normalizeSecretInput(sessionKey)
  if (!key.startsWith('sess-')) {
    return { ok: false, status: 401, message: 'OpenAI Platform 登录态无效，请重新同步' }
  }
  const headers = {
    Authorization: 'Bearer ' + key,
    Accept: 'application/json',
  }
  if (organizationId) headers['OpenAI-Organization'] = organizationId

  const result = await fetchJson(OPENAI_CREDIT_GRANTS_URL, {
    method: 'GET',
    headers,
    signal: combineSignals(signal, 10_000),
  }, 'OpenAI Billing')
  if (result.error) return result.error
  const { response, body, html } = result
  if (html || response.status === 401 || response.status === 403) {
    return { ok: false, status: 401, message: 'OpenAI Platform 登录态已失效，请重新同步' }
  }
  if (!response.ok || !body || typeof body !== 'object') {
    const message = body?.error?.message || body?.message || ('OpenAI Billing 请求失败 (HTTP ' + response.status + ')')
    return { ok: false, status: response.status, message: scrubSecrets(message) }
  }
  return await fetchOpenAiCreditBalanceFromBody(body, organizationId)
}

async function fetchOpenAiCreditBalanceFromBody(body, organizationId = '') {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 502, message: 'OpenAI Billing 返回了空响应' }
  }
  if (body.object && body.object !== 'credit_summary') {
    return { ok: false, status: 502, message: 'OpenAI Billing 返回了无法识别的响应格式' }
  }
  if (body.total_granted === undefined || body.total_used === undefined) {
    return { ok: false, status: 502, message: 'OpenAI Billing 响应缺少余额字段，请重新同步登录态' }
  }

  const granted = parseOptionalFiniteNumber(body.total_granted) ?? 0
  const used = parseOptionalFiniteNumber(body.total_used) ?? 0
  const available = Math.max(0, parseOptionalFiniteNumber(body.total_available)
    ?? parseOptionalFiniteNumber(body.total_paid_available)
    ?? Math.max(0, granted - used))
  const remainingPercent = granted > 0
    ? Math.max(0, Math.min(100, Number(((available / granted) * 100).toFixed(2))))
    : 0
  const usedPercent = granted > 0
    ? Math.max(0, Math.min(100, Number(((used / granted) * 100).toFixed(2))))
    : 0
  const grants = Array.isArray(body.grants?.data)
    ? body.grants.data.map(item => {
        const grantAmount = parseOptionalFiniteNumber(item?.grant_amount) ?? 0
        const usedAmount = parseOptionalFiniteNumber(item?.used_amount) ?? 0
        const effectiveAt = parseOptionalFiniteNumber(item?.effective_at)
        const expiresAt = parseOptionalFiniteNumber(item?.expires_at)
        return {
          grantAmount,
          usedAmount,
          remainingAmount: Math.max(0, grantAmount - usedAmount),
          effectiveAtMs: effectiveAt ? effectiveAt * 1000 : null,
          expiresAtMs: expiresAt ? expiresAt * 1000 : null,
        }
      })
    : []

  return {
    ok: true,
    data: {
      provider: 'codex-api',
      mode: 'openai-platform',
      currency: 'USD',
      organizationId: organizationId || null,
      totalGrantedUsd: Number(granted.toFixed(4)),
      totalUsedUsd: Number(used.toFixed(4)),
      remainingUsd: Number(available.toFixed(4)),
      remainingPercent,
      usedPercent,
      grants,
      fetchedAt: Date.now(),
      webUrl: OPENAI_API_WEB_URL,
    },
  }
}

let openAiBrowserSyncInFlight = null
let openAiBrowserSyncLastAttempt = 0
let openAiBrowserSyncLastError = ''
let openAiBrowserSyncLastErrorCode = ''
let openAiLoginPending = null
const OPENAI_SYNC_SCRIPT = readFileSync(new URL('./openai-sync.inc.js', import.meta.url), 'utf8')

function buildEgoBrowserPath() {
  if (process.env.CODEX_DISABLE_EGO_BROWSER === '1') return process.env.PATH ?? ''
  return [
    process.env.PATH ?? '',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(homedir(), '.local', 'bin'),
    join(homedir(), '.ego-lite', 'bin'),
  ].filter(Boolean).join(delimiter)
}

async function syncOpenAiSessionFromEgoBrowserOnce(signal, allowHandoff = false) {
  if (process.env.CODEX_DISABLE_EGO_BROWSER === '1') {
    return { code: 'no-ego-browser', error: '未检测到 Ego Lite / ego-browser' }
  }
  return await new Promise((resolve) => {
    const script = OPENAI_SYNC_SCRIPT.replace('__ALLOW_HANDOFF__', allowHandoff ? 'true' : 'false')

    const envPath = buildEgoBrowserPath()

    const child = spawn('ego-browser', ['nodejs', '-e', script], {
      env: { ...process.env, PATH: envPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => {
      try { child.kill('SIGKILL') } catch {}
      finish({ error: 'OpenAI 浏览器同步已取消' })
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish({ error: 'OpenAI 浏览器同步超时（65 秒），请检查网络或代理后重试' })
    }, 65_000)
    timer.unref?.()
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
    child.on('error', error => {
      finish({
        code: error?.code === 'ENOENT' ? 'no-ego-browser' : 'ego-launch-failed',
        error: error?.code === 'ENOENT'
          ? '未检测到 Ego Lite / ego-browser'
          : scrubSecrets('无法启动 Ego Lite: ' + error.message),
      })
    })
    child.on('close', () => {
      const output = `${stdout}\n${stderr}`
      const marker = output.lastIndexOf('__CODEX_OPENAI_SYNC__')
      if (marker < 0) {
        finish({ error: 'OpenAI 浏览器同步未完成，请确认 Ego Lite 已启动并可访问 platform.openai.com' })
        return
      }
      try {
        const jsonText = output.slice(marker + '__CODEX_OPENAI_SYNC__'.length).trim().split('\n')[0]
        const parsed = JSON.parse(jsonText)
        if (parsed?.error) parsed.error = scrubSecrets(parsed.error)
        finish(parsed)
      } catch {
        finish({ error: 'OpenAI 浏览器同步返回格式异常，请重试' })
      }
    })
  })
}

function subscribeOpenAiBrowserSync(entry, signal) {
  return new Promise((resolve) => {
    let settled = false
    const subscriber = { onAbort: null }
    const finish = (value) => {
      if (settled) return
      settled = true
      entry.subscribers.delete(subscriber)
      if (signal && subscriber.onAbort) signal.removeEventListener('abort', subscriber.onAbort)
      resolve(value)
    }
    subscriber.onAbort = () => {
      entry.subscribers.delete(subscriber)
      if (entry.subscribers.size === 0 && !entry.abortTimer) {
        // A forced refresh may cancel the old caller just before its replacement
        // subscribes. Defer the shared child kill so the replacement can take over.
        entry.abortTimer = setTimeout(() => {
          entry.abortTimer = null
          if (entry.subscribers.size === 0) {
            try { entry.controller.abort() } catch {}
          }
        }, 250)
        entry.abortTimer.unref?.()
      }
      finish({ error: 'OpenAI 浏览器同步已取消' })
    }
    if (entry.abortTimer) {
      clearTimeout(entry.abortTimer)
      entry.abortTimer = null
    }
    entry.subscribers.add(subscriber)
    if (signal) {
      if (signal.aborted) {
        subscriber.onAbort()
        return
      }
      signal.addEventListener('abort', subscriber.onAbort, { once: true })
    }
    entry.promise.then(finish, () => finish({ error: 'OpenAI 浏览器同步失败，请稍后重试' }))
  })
}

const OPENAI_OAUTH_EXPIRY_MARGIN_MS = 3 * 60 * 1000
const OPENAI_PLATFORM_AUTH_KEY = 'oai-auth:onboard'

function decodeJwtExpMs(token) {
  const payload = decodeJwtPayload(token)
  const exp = Number(payload?.exp ?? 0)
  if (!Number.isFinite(exp) || exp <= 0) return 0
  return exp > 1e12 ? exp : exp * 1000
}

function isTokenUsable(token, expiresAtMs = 0, skewMs = OPENAI_OAUTH_EXPIRY_MARGIN_MS) {
  if (typeof token !== 'string' || !token.trim()) return false
  const effectiveExp = expiresAtMs > 0 ? expiresAtMs : decodeJwtExpMs(token)
  if (!effectiveExp) return !isJwtExpired(token, skewMs)
  return Date.now() + skewMs < effectiveExp
}

async function exchangeOpenAiAccessTokenForSession(accessToken, signal) {
  const token = normalizeSecretInput(accessToken)
  if (!token) {
    return { ok: false, status: 401, code: 'login-required', message: '缺少 OpenAI Platform 访问令牌，请重新同步' }
  }
  const result = await fetchJson(OPENAI_ONBOARDING_LOGIN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: '{}',
    signal: combineSignals(signal, 12_000),
  }, 'OpenAI Onboarding')
  if (result.error) return result.error
  const { response, body, html } = result
  if (html || response.status === 401 || response.status === 403) {
    return { ok: false, status: 401, code: 'login-required', message: 'OpenAI Platform 访问令牌已失效，请重新同步' }
  }
  if (!response.ok || !body || typeof body !== 'object') {
    const message = body?.error?.message || body?.message || ('OpenAI 登录态兑换失败 (HTTP ' + response.status + ')')
    return { ok: false, status: response.status, message: scrubSecrets(message) }
  }
  const sessionKey = normalizeSecretInput(body?.user?.session?.sensitive_id)
  if (!sessionKey.startsWith('sess-')) {
    return { ok: false, status: 502, code: 'session-missing', message: 'OpenAI 登录态兑换未返回有效会话' }
  }
  const orgs = Array.isArray(body?.user?.orgs?.data) ? body.user.orgs.data : []
  const org = orgs.find(item => item.personal) || orgs[0]
  return {
    ok: true,
    sessionKey,
    organizationId: typeof org?.id === 'string' ? org.id.trim() : '',
  }
}

async function refreshOpenAiPlatformOAuthToken(refreshToken, deviceId = '', signal) {
  const token = normalizeSecretInput(refreshToken)
  if (!token) {
    return { ok: false, status: 401, code: 'login-required', message: '缺少 OpenAI Platform 刷新令牌，请重新同步' }
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (deviceId) headers['oai-did'] = deviceId
  const result = await fetchJson(OPENAI_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      client_id: OPENAI_PLATFORM_CLIENT_ID,
      refresh_token: token,
      grant_type: 'refresh_token',
      resource: OPENAI_PLATFORM_RESOURCE,
    }),
    signal: combineSignals(signal, 12_000),
  }, 'OpenAI OAuth')
  if (result.error) return result.error
  const { response, body, html } = result
  if (html) {
    return { ok: false, status: 502, network: true, message: 'OpenAI OAuth 返回了非 JSON 页面响应' }
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    const oauthErr = typeof body?.error === 'string' ? body.error : body?.error?.code
    const terminal = oauthErr === 'invalid_grant' || oauthErr === 'unauthorized_client' || oauthErr === 'invalid_client' || response.status === 401 || response.status === 403
    const msg = body?.error_description || body?.error?.message || body?.error || ('OpenAI OAuth 续期失败 (HTTP ' + response.status + ')')
    return {
      ok: false,
      status: terminal ? 401 : response.status,
      code: terminal ? 'login-required' : 'oauth-refresh-failed',
      message: scrubSecrets(msg),
    }
  }
  if (!response.ok || !body || typeof body !== 'object') {
    const message = body?.error_description || body?.error?.message || ('OpenAI OAuth 续期失败 (HTTP ' + response.status + ')')
    return { ok: false, status: response.status, message: scrubSecrets(message) }
  }
  const accessToken = normalizeSecretInput(body.access_token)
  const nextRefreshToken = normalizeSecretInput(body.refresh_token) || token
  if (!accessToken) {
    return { ok: false, status: 502, message: 'OpenAI OAuth 续期未返回访问令牌' }
  }
  const expiresInSec = parseOptionalFiniteNumber(body.expires_in)
  const accessExpiresAt = decodeJwtExpMs(accessToken) || (expiresInSec ? Date.now() + expiresInSec * 1000 : 0)
  return {
    ok: true,
    accessToken,
    refreshToken: nextRefreshToken,
    accessExpiresAt,
  }
}

function findLocalChromiumBrowser() {
  const envCustom = typeof process.env.CODEX_CREDIT_BROWSER_PATH === 'string'
    ? process.env.CODEX_CREDIT_BROWSER_PATH.trim()
    : ''
  const candidates = []
  if (envCustom) candidates.push({ name: 'Chromium', path: envCustom })
  if (process.platform === 'darwin') {
    candidates.push(
      { name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { name: 'Google Chrome', path: join(homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome') },
      { name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { name: 'Microsoft Edge', path: join(homedir(), 'Applications', 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge') },
      { name: 'Brave Browser', path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { name: 'Brave Browser', path: join(homedir(), 'Applications', 'Brave Browser.app', 'Contents', 'MacOS', 'Brave Browser') },
      { name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' },
      { name: 'Chromium', path: join(homedir(), 'Applications', 'Chromium.app', 'Contents', 'MacOS', 'Chromium') },
    )
  } else if (process.platform === 'win32') {
    const pf = process.env.PROGRAMFILES || 'C:\\Program Files'
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    candidates.push(
      { name: 'Google Chrome', path: join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Google Chrome', path: join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') },
      { name: 'Microsoft Edge', path: join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Microsoft Edge', path: join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') },
      { name: 'Brave Browser', path: join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') },
    )
  } else {
    candidates.push(
      { name: 'Google Chrome', path: '/usr/bin/google-chrome' },
      { name: 'Google Chrome', path: '/usr/bin/google-chrome-stable' },
      { name: 'Chromium', path: '/usr/bin/chromium' },
      { name: 'Chromium', path: '/usr/bin/chromium-browser' },
      { name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' },
      { name: 'Brave Browser', path: '/usr/bin/brave-browser' },
    )
  }
  return candidates.find(item => item.path && existsSync(item.path)) ?? null
}

function getDedicatedBrowserProfileDir() {
  const base = (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim())
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  return join(base, 'codex-credit-hub-browser')
}

export async function syncOpenAiSessionFromSystemBrowserOnce(signal, options = {}) {
  const browser = findLocalChromiumBrowser()
  if (!browser) {
    return {
      code: 'no-browser',
      error: '未检测到 Ego Lite 或 Chrome / Edge 等本地浏览器，请安装 Chrome / Edge 或 Ego Lite 后重试',
    }
  }
  if (typeof WebSocket !== 'function') {
    return {
      code: 'no-websocket',
      error: '当前运行环境不支持本地浏览器 DevTools 连接，请使用 Ego Lite 重试',
    }
  }

  const profileDir = getDedicatedBrowserProfileDir()
  await mkdir(profileDir, { recursive: true, mode: 0o700 })
  const portPath = join(profileDir, 'DevToolsActivePort')
  let existingPort = ''
  try {
    const [port] = (await readFile(portPath, 'utf8')).trim().split('\n')
    if (/^\d+$/.test(port || '')) {
      const alive = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(1200),
      }).then(r => r.ok).catch(() => false)
      if (alive) existingPort = port
    }
  } catch {}
  if (!existingPort) await rm(portPath, { force: true }).catch(() => {})

  return await new Promise((resolve) => {
    let settled = false
    let ws = null
    let pollTimer = null
    let timeoutTimer = null
    let child = null
    let launched = false

    const closeAttachedBrowser = async (port) => {
      if (!port) return
      try {
        const version = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1500),
        }).then(r => r.json())
        const browserWs = version?.webSocketDebuggerUrl
        if (!browserWs) return
        const socket = new WebSocket(browserWs)
        await new Promise((resolveClose) => {
          let closed = false
          const done = () => {
            if (closed) return
            closed = true
            clearTimeout(timer)
            resolveClose()
          }
          const timer = setTimeout(done, 1500)
          timer.unref?.()
          socket.onopen = () => {
            try { socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })) } catch { done() }
          }
          socket.onmessage = (event) => {
            try {
              const msg = JSON.parse(String(event.data))
              if (msg.id === 1) done()
            } catch {}
          }
          socket.onerror = done
          socket.onclose = done
        })
        try { socket.close() } catch {}
      } catch {}
    }

    const ensurePageTarget = async (port, targets) => {
      if (!Array.isArray(targets)) return null
      const platformPage = targets.find(t => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('https://platform.openai.com'))
      if (platformPage) return platformPage
      const authPage = targets.find(t => t.type === 'page' && typeof t.url === 'string' && (
        t.url.startsWith('https://auth.openai.com')
        || t.url.startsWith('https://chatgpt.com')
        || t.url.startsWith('https://accounts.google.com')
        || t.url.startsWith('https://login.microsoftonline.com')
        || t.url.startsWith('https://appleid.apple.com')
      ))
      if (authPage) return null
      const blankOrOther = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (blankOrOther?.webSocketDebuggerUrl) {
        await evalPage(blankOrOther.webSocketDebuggerUrl, `location.replace(${JSON.stringify(OPENAI_PLATFORM_HOME_URL)})`).catch(() => {})
        return null
      }
      await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(OPENAI_PLATFORM_HOME_URL)}`, {
        method: 'PUT',
        signal: AbortSignal.timeout(2000),
      }).catch(() => fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(OPENAI_PLATFORM_HOME_URL)}`, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => {}))
      return null
    }

    const cleanup = async (value) => {
      if (pollTimer) { clearTimeout(pollTimer); pollTimer = null }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
      signal?.removeEventListener('abort', onAbort)
      if (ws) { try { ws.close() } catch {} ws = null }
      if (launched && child) {
        if (child.exitCode !== null || child.signalCode) return
        await new Promise((resolveExit) => {
          let done = false
          const finishExit = () => {
            if (done) return
            done = true
            clearTimeout(forceTimer)
            resolveExit()
          }
          const forceTimer = setTimeout(() => {
            try { child.kill('SIGKILL') } catch {}
            finishExit()
          }, 900)
          forceTimer.unref?.()
          child.once('exit', finishExit)
          try { child.kill('SIGTERM') } catch { finishExit() }
        })
      } else if (value?.ok && existingPort) {
        await closeAttachedBrowser(existingPort)
      }
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      void cleanup(value).finally(() => resolve(value))
    }
    const onAbort = () => finish({ code: 'aborted', error: 'OpenAI 浏览器登录已取消' })
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const timeoutMs = options.timeoutMs ?? 180_000
    timeoutTimer = setTimeout(() => {
      finish({ code: 'login-timeout', error: `等待 ${browser.name} 登录 OpenAI Platform 超时（${Math.round(timeoutMs / 1000)} 秒），请重试` })
    }, timeoutMs)
    timeoutTimer.unref?.()

    if (!existingPort) {
      const args = [
        `--user-data-dir=${profileDir}`,
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--new-window',
      ]
      if (options.headless) args.push('--headless=new')
      args.push(OPENAI_PLATFORM_HOME_URL)
      launched = true
      child = spawn(browser.path, args, { stdio: 'ignore', windowsHide: false })
      child.on('error', (error) => {
        finish({ code: 'browser-launch-failed', error: scrubSecrets(`无法启动 ${browser.name}: ${error.message}`) })
      })
      child.on('exit', () => {
        if (!settled) finish({ code: 'login-cancelled', error: `${browser.name} 登录窗口已关闭，尚未完成 OpenAI Platform 登录` })
      })
    }

    const evalPage = (targetWsUrl, expression) => new Promise((resolveEval, rejectEval) => {
      const targetWs = new WebSocket(targetWsUrl)
      ws = targetWs
      let done = false
      const finishEval = (fn, value) => {
        if (done) return
        done = true
        clearTimeout(reqTimer)
        try { targetWs.close() } catch {}
        if (ws === targetWs) ws = null
        fn(value)
      }
      const reqTimer = setTimeout(() => finishEval(rejectEval, new Error('CDP evaluate timeout')), 25_000)
      reqTimer.unref?.()
      targetWs.onopen = () => {
        targetWs.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }))
      }
      targetWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data))
          if (msg.id !== 1) return
          if (msg.error) finishEval(rejectEval, new Error(msg.error.message || 'CDP error'))
          else finishEval(resolveEval, msg.result?.result?.value)
        } catch {}
      }
      targetWs.onerror = () => finishEval(rejectEval, new Error('CDP websocket error'))
      targetWs.onclose = () => {
        if (!done) finishEval(rejectEval, new Error('CDP websocket closed'))
      }
    })

    let emptyChecks = 0
    let reloginRedirected = false
    const pollOnce = async () => {
      if (settled) return
      try {
        const port = existingPort || (await readFile(portPath, 'utf8').catch(() => '')).trim().split('\n')[0]
        if (port && /^\d+$/.test(port)) {
          const targetsRes = await fetch(`http://127.0.0.1:${port}/json/list`, {
            signal: AbortSignal.timeout(2000),
          }).catch(() => null)
          if (!targetsRes?.ok) {
            if (existingPort) {
              finish({ code: 'login-cancelled', error: `${browser.name} 登录窗口已关闭，尚未完成 OpenAI Platform 登录` })
              return
            }
          } else {
            const targets = await targetsRes.json().catch(() => [])
            const pageCount = Array.isArray(targets) ? targets.filter(t => t.type === 'page').length : 0
            if (pageCount === 0) {
              emptyChecks += 1
              if (launched && emptyChecks >= 2) {
                finish({ code: 'login-cancelled', error: `${browser.name} 登录窗口已关闭，尚未完成 OpenAI Platform 登录` })
                return
              }
            } else {
              emptyChecks = 0
            }
            const pageTarget = await ensurePageTarget(port, targets)
            if (pageTarget?.webSocketDebuggerUrl) {
              const payload = await evalPage(pageTarget.webSocketDebuggerUrl, `(async () => {
                const request = async (url, init) => {
                  const controller = new AbortController();
                  const timer = setTimeout(() => controller.abort(), 18000);
                  try { return await fetch(url, { ...init, signal: controller.signal }); }
                  finally { clearTimeout(timer); }
                };
                const raw = localStorage.getItem(${JSON.stringify(OPENAI_PLATFORM_AUTH_KEY)});
                const auth = raw ? JSON.parse(raw) : null;
                const accessToken = typeof auth?.accessToken === "string" ? auth.accessToken : "";
                const refreshToken = typeof auth?.refreshToken === "string" ? auth.refreshToken : "";
                if (!accessToken) return null;
                let accessExpiresAt = 0;
                let deviceId = "";
                try {
                  const parts = accessToken.split(".");
                  if (parts[1]) {
                    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
                    const padded = b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=");
                    const p = JSON.parse(atob(padded));
                    if (typeof p?.exp === "number") accessExpiresAt = p.exp > 1e12 ? p.exp : p.exp * 1000;
                  }
                  const didMatch = /(?:^|;\\s*)oai-did=([^;\\s]+)/.exec(document.cookie || "");
                  if (didMatch?.[1]) deviceId = decodeURIComponent(didMatch[1]);
                } catch {}
                const readJson = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return null; } };
                const login = await request(${JSON.stringify(OPENAI_ONBOARDING_LOGIN_URL)}, {
                  method: "POST",
                  headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
                  body: "{}",
                });
                const loginBody = await readJson(login);
                if (login.status === 401 || login.status === 403) {
                  try { localStorage.removeItem(${JSON.stringify(OPENAI_PLATFORM_AUTH_KEY)}); } catch {}
                  return { authExpired: true };
                }
                if (!login.ok || !loginBody) return { retry: true };
                const sessionKey = loginBody?.user?.session?.sensitive_id;
                if (typeof sessionKey !== "string" || !sessionKey.startsWith("sess-")) return { retry: true };
                const orgs = Array.isArray(loginBody?.user?.orgs?.data) ? loginBody.user.orgs.data : [];
                const org = orgs.find(x => x.personal) || orgs[0];
                const organizationId = typeof org?.id === "string" ? org.id : "";
                const billing = await request(${JSON.stringify(OPENAI_CREDIT_GRANTS_URL)}, {
                  method: "GET",
                  headers: {
                    Authorization: "Bearer " + sessionKey,
                    Accept: "application/json",
                    ...(organizationId ? { "OpenAI-Organization": organizationId } : {}),
                  },
                });
                const billingBody = await readJson(billing);
                if (billing.status === 401 || billing.status === 403) {
                  try { localStorage.removeItem(${JSON.stringify(OPENAI_PLATFORM_AUTH_KEY)}); } catch {}
                  return { authExpired: true };
                }
                if (!billing.ok || !billingBody || billingBody.total_granted === undefined || billingBody.total_used === undefined) {
                  return { retry: true };
                }
                return {
                  ok: true,
                  source: "openai-platform-system-browser",
                  sessionKey,
                  organizationId,
                  accessToken,
                  refreshToken,
                  accessExpiresAt,
                  deviceId,
                  balance: billingBody,
                };
              })()`)
              if (payload?.ok && payload.sessionKey) {
                finish(payload)
                return
              }
              if (payload?.authExpired && !reloginRedirected) {
                reloginRedirected = true
                await evalPage(pageTarget.webSocketDebuggerUrl, `location.replace(${JSON.stringify(OPENAI_PLATFORM_HOME_URL)})`).catch(() => {})
              }
            }
          }
        }
      } catch {}
      if (!settled) {
        pollTimer = setTimeout(() => { void pollOnce() }, 1000)
        pollTimer.unref?.()
      }
    }

    pollTimer = setTimeout(() => { void pollOnce() }, options.headless ? 100 : 800)
    pollTimer.unref?.()
  })
}

function abortOpenAiBrowserSyncState() {
  if (openAiBrowserSyncInFlight) {
    if (openAiBrowserSyncInFlight.abortTimer) {
      clearTimeout(openAiBrowserSyncInFlight.abortTimer)
      openAiBrowserSyncInFlight.abortTimer = null
    }
    try { openAiBrowserSyncInFlight.controller.abort() } catch {}
    openAiBrowserSyncInFlight = null
  }
  openAiLoginPending = null
}

async function syncOpenAiSessionFromBrowser(force = false, signal, options = {}) {
  const allowSystemBrowser = options.allowSystemBrowser !== false
  if (openAiBrowserSyncInFlight) {
    if (force && allowSystemBrowser && !openAiBrowserSyncInFlight.allowSystemBrowser) {
      // Do not let a background silent check block an explicit user Sync click
      // from opening the system browser fallback when Ego Lite is unavailable.
      if (openAiBrowserSyncInFlight.abortTimer) {
        clearTimeout(openAiBrowserSyncInFlight.abortTimer)
        openAiBrowserSyncInFlight.abortTimer = null
      }
      try { openAiBrowserSyncInFlight.controller.abort() } catch {}
      openAiBrowserSyncInFlight = null
    } else {
      return await subscribeOpenAiBrowserSync(openAiBrowserSyncInFlight, signal)
    }
  }
  if (!force && openAiLoginPending) {
    return {
      code: 'login-required',
      needsLogin: true,
      taskSpaceId: openAiLoginPending.taskSpaceId,
      error: 'OpenAI 登录页已打开，请先完成登录，再点击「同步 OpenAI 登录态」；后台不会打断登录',
    }
  }
  const cooldownMs = openAiBrowserSyncLastErrorCode === 'login-required'
    ? OPENAI_BROWSER_SYNC_COOLDOWN_MS
    : 10_000
  if (!force && openAiBrowserSyncLastAttempt > 0 && openAiBrowserSyncLastError && Date.now() - openAiBrowserSyncLastAttempt < cooldownMs) {
    return { code: openAiBrowserSyncLastErrorCode, error: openAiBrowserSyncLastError }
  }
  openAiBrowserSyncLastAttempt = Date.now()
  openAiBrowserSyncLastError = ''
  openAiBrowserSyncLastErrorCode = ''
  const entry = {
    controller: new AbortController(),
    subscribers: new Set(),
    abortTimer: null,
    allowSystemBrowser,
    promise: null,
  }
  entry.promise = (async () => {
    const egoResult = await syncOpenAiSessionFromEgoBrowserOnce(entry.controller.signal, false)
    if (egoResult?.sessionKey) return egoResult
    if (!allowSystemBrowser) {
      if (egoResult?.code === 'no-ego-browser' || egoResult?.code === 'login-required') {
        return {
          code: 'login-required',
          error: 'OpenAI Platform 登录态已过期，请点击「同步 OpenAI 登录态」重新登录',
        }
      }
      return egoResult
    }
    const systemResult = await syncOpenAiSessionFromSystemBrowserOnce(entry.controller.signal)
    // If no Chromium browser exists but Ego Lite is present, use its login
    // page as the final fallback instead of leaving the user without a path.
    if (systemResult?.code === 'no-browser' && egoResult?.code === 'login-required') {
      return await syncOpenAiSessionFromEgoBrowserOnce(entry.controller.signal, true)
    }
    return systemResult
  })()
    .then(result => {
      if (openAiBrowserSyncInFlight !== entry) return result
      openAiBrowserSyncLastError = result?.error ? scrubSecrets(result.error) : ''
      openAiBrowserSyncLastErrorCode = result?.error ? (result?.code || 'sync-failed') : ''
      openAiLoginPending = result?.needsLogin && result?.taskSpaceId
        ? { taskSpaceId: result.taskSpaceId }
        : null
      return result
    })
    .catch(() => {
      const result = { code: 'sync-failed', error: 'OpenAI 浏览器同步失败，请稍后重试' }
      if (openAiBrowserSyncInFlight === entry) {
        openAiBrowserSyncLastError = result.error
        openAiBrowserSyncLastErrorCode = result.code
      }
      return result
    })
    .finally(() => {
      if (entry.abortTimer) {
        clearTimeout(entry.abortTimer)
        entry.abortTimer = null
      }
      if (openAiBrowserSyncInFlight === entry) openAiBrowserSyncInFlight = null
    })
  openAiBrowserSyncInFlight = entry
  return await subscribeOpenAiBrowserSync(entry, signal)
}

export class CodexCliQuotaService {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.cached = null
    this.inFlight = null
    this.generation = 0
    this.disposed = false
    this.controllers = new Set()
    this.failureCount = 0
  }

  dispose() {
    this.disposed = true
    ++this.generation
    for (const controller of this.controllers) {
      try { controller.abort() } catch {}
    }
    this.controllers.clear()
  }

  getPreferences() {
    return {
      refreshIntervalSec: readVolatile(this.config.refreshIntervalSec, 60),
      displayFormat: readVolatile(this.config.displayFormat, 'both'),
    }
  }

  commit(generation, state) {
    if (generation === this.generation) {
      if (state?.status === 'ok' && !state.error) this.failureCount = 0
      this.cached = state
    }
    return this.cached ?? state
  }

  commitFailure(generation, failure) {
    if (generation !== this.generation) return this.cached ?? {
      status: failure.status || 'error',
      error: failure.error,
      webUrl: CODEX_WEB_URL,
      preferences: this.getPreferences(),
    }
    this.failureCount += 1
    const retryAfterSec = failure.status === 'unauthorized'
      ? 60
      : Math.min(60, 15 * (2 ** Math.min(this.failureCount - 1, 2)))
    if (this.cached?.quota && failure.status !== 'unauthorized') {
      const { retryAfterSec: _prevRetry, stale: _prevStale, error: _prevErr, ...rest } = this.cached
      return this.commit(generation, {
        ...rest,
        status: 'ok',
        stale: true,
        error: failure.error,
        retryAfterSec,
        preferences: this.getPreferences(),
      })
    }
    return this.commit(generation, {
      status: failure.status || 'error',
      error: failure.error,
      retryAfterSec,
      webUrl: CODEX_WEB_URL,
      preferences: this.getPreferences(),
    })
  }

  async getQuota(options = {}) {
    const { force = false, signal } = options
    if (!force && this.cached && this.cached.status === 'ok' && !this.cached.stale && !this.cached.error) {
      const ageMs = Date.now() - (this.cached.quota?.fetchedAt ?? 0)
      if (ageMs < 10_000) return { ...this.cached, preferences: this.getPreferences() }
    }
    if (this.inFlight && !force) return await this.inFlight.run(signal)
    if (this.inFlight && force) {
      this.inFlight.abort()
      ++this.generation
    }

    const generation = this.generation
    const controller = new AbortController()
    this.controllers.add(controller)
    const run = {
      abort: () => controller.abort(),
      run: async (callerSignal) => {
        if (!callerSignal) return await promise
        if (callerSignal.aborted) {
          return { status: 'error', error: 'Codex CLI 请求已取消', webUrl: CODEX_WEB_URL, preferences: this.getPreferences() }
        }
        let onAbort
        const cancelled = new Promise(resolve => {
          onAbort = () => resolve({ status: 'error', error: 'Codex CLI 请求已取消', webUrl: CODEX_WEB_URL, preferences: this.getPreferences() })
          callerSignal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          return await Promise.race([promise, cancelled])
        } finally {
          callerSignal.removeEventListener('abort', onAbort)
        }
      },
    }
    const promise = this._resolveQuota(controller.signal, generation).finally(() => {
      this.controllers.delete(controller)
      if (this.inFlight === run) this.inFlight = null
    })
    this.inFlight = run
    return await run.run(signal)
  }

  async _resolveQuota(signal, generation) {
    const authJson = await readCodexAuthFile()
    const identity = extractCliIdentity(authJson)
    const accessToken = authJson?.tokens?.access_token
    let lastError = ''

    if (accessToken) {
      const direct = await fetchCodexWhamUsage(accessToken, identity.accountId, signal, identity)
      if (direct.ok) {
        return this.commit(generation, {
          status: 'ok',
          source: 'codex-auth.json',
          quota: direct.data,
          preferences: this.getPreferences(),
        })
      }
      lastError = direct.message
    }

    // Fallback: ask `codex app-server` (supports refreshed tokens / keychain / headless daemon).
    const rpc = await fetchCodexViaAppServer(signal)
    if (rpc.ok) {
      return this.commit(generation, {
        status: 'ok',
        source: 'codex-app-server',
        quota: rpc.data,
        preferences: this.getPreferences(),
      })
    }

    const isUnauth = !authJson?.tokens?.access_token && (rpc.status === 401 || rpc.missingCli === true)
    return this.commitFailure(generation, {
      status: isUnauth ? 'unauthorized' : 'error',
      error: rpc.message || lastError || '未检测到 Codex CLI 登录态，请在终端运行 `codex login`',
    })
  }
}

export class CodexApiQuotaService {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.key = credentialKey(RECORD_SCOPE, RECORD_ID_API)
    this.cached = null
    this.inFlight = null
    this.generation = 0
    this.disposed = false
    this.controllers = new Set()
    this.failureCount = 0
    this.oauthInFlight = null
  }

  dispose() {
    this.disposed = true
    ++this.generation
    for (const controller of this.controllers) {
      try { controller.abort() } catch {}
    }
    this.controllers.clear()
    abortOpenAiBrowserSyncState()
  }

  getPreferences() {
    return {
      refreshIntervalSec: readVolatile(this.config.refreshIntervalSec, 60),
      displayFormat: readVolatile(this.config.displayFormat, 'both'),
    }
  }

  commit(generation, state) {
    if (generation === this.generation) {
      if (state?.status === 'ok' && !state.error) this.failureCount = 0
      this.cached = state
    }
    return this.cached ?? state
  }

  commitFailure(generation, failure) {
    if (generation !== this.generation) return this.cached ?? {
      status: failure.status || 'error',
      error: failure.error,
      canSync: true,
      webUrl: OPENAI_API_WEB_URL,
      preferences: this.getPreferences(),
    }
    this.failureCount += 1
    const retryAfterSec = failure.code === 'login-required'
      ? 60
      : Math.min(60, 15 * (2 ** Math.min(this.failureCount - 1, 2)))
    if (this.cached?.quota) {
      const { retryAfterSec: _prevRetry, stale: _prevStale, error: _prevErr, ...rest } = this.cached
      return this.commit(generation, {
        ...rest,
        status: 'ok',
        stale: true,
        error: failure.error,
        retryAfterSec,
        canSync: true,
        preferences: this.getPreferences(),
      })
    }
    return this.commit(generation, {
      status: failure.status || 'error',
      error: failure.error,
      retryAfterSec,
      canSync: true,
      webUrl: OPENAI_API_WEB_URL,
      preferences: this.getPreferences(),
    })
  }

  async readStoredSession() {
    try {
      const record = await this.ctx.credentials.readRecord(this.key)
      if (record?.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') return null
      const sessionKey = normalizeSecretInput(record.payload.sessionKey)
      const accessToken = normalizeSecretInput(record.payload.accessToken)
      const refreshToken = normalizeSecretInput(record.payload.refreshToken)
      if (!sessionKey && !accessToken && !refreshToken) return null
      const expires = Number(record.payload.accessExpiresAt)
      return {
        sessionKey,
        organizationId: typeof record.payload.organizationId === 'string' ? record.payload.organizationId.trim() : '',
        accessToken,
        refreshToken,
        accessExpiresAt: Number.isFinite(expires) ? expires : 0,
        deviceId: typeof record.payload.deviceId === 'string' ? record.payload.deviceId.trim() : '',
      }
    } catch {
      return null
    }
  }

  async saveCredentials(patch, expectedRefreshToken = '') {
    if (this.disposed) throw new Error('Codex API 服务已卸载')
    let applied = true
    await this.ctx.credentials.modifyRecord(this.key, async current => {
      if (this.disposed) {
        applied = false
        return current
      }
      if (expectedRefreshToken && current?.payload?.refreshToken !== expectedRefreshToken) {
        applied = false
        return current
      }
      const previous = current?.kind === 'grant' && current.payload && typeof current.payload === 'object'
        ? current.payload
        : {}
      return {
        kind: 'grant',
        payload: { ...previous, ...patch },
      }
    })
    return applied
  }

  async getQuota(options = {}) {
    const { force = false, signal } = options
    if (!force && this.cached && this.cached.status === 'ok' && !this.cached.stale && !this.cached.error) {
      const ageMs = Date.now() - (this.cached.quota?.fetchedAt ?? 0)
      if (ageMs < 10_000) return { ...this.cached, preferences: this.getPreferences() }
    }
    if (this.inFlight && !force) return await this.inFlight.run(signal)
    if (this.inFlight && force) {
      this.inFlight.abort()
      ++this.generation
    }

    const generation = this.generation
    const controller = new AbortController()
    this.controllers.add(controller)
    const run = {
      abort: () => controller.abort(),
      run: async (callerSignal) => {
        if (!callerSignal) return await promise
        if (callerSignal.aborted) {
          return { status: 'error', error: 'Codex API 请求已取消', canSync: true, webUrl: OPENAI_API_WEB_URL, preferences: this.getPreferences() }
        }
        let onAbort
        const cancelled = new Promise(resolve => {
          onAbort = () => resolve({ status: 'error', error: 'Codex API 请求已取消', canSync: true, webUrl: OPENAI_API_WEB_URL, preferences: this.getPreferences() })
          callerSignal.addEventListener('abort', onAbort, { once: true })
        })
        try {
          return await Promise.race([promise, cancelled])
        } finally {
          callerSignal.removeEventListener('abort', onAbort)
        }
      },
    }
    const promise = this._resolveQuota(controller.signal, generation).finally(() => {
      this.controllers.delete(controller)
      if (this.inFlight === run) this.inFlight = null
    })
    this.inFlight = run
    return await run.run(signal)
  }

  async _resolveQuota(signal, generation) {
    const stored = await this.readStoredSession()
    if (!stored) {
      return this.commit(generation, {
        status: 'unauthorized',
        error: '尚未连接 OpenAI Platform。点击「同步 OpenAI 登录态」开始连接；无需输入 API Key',
        canSync: true,
        webUrl: OPENAI_API_WEB_URL,
        preferences: this.getPreferences(),
      })
    }

    if (stored.sessionKey.startsWith('sess-')) {
      const result = await fetchOpenAiCreditBalance(stored.sessionKey, stored.organizationId, signal)
      if (result.ok) {
        return this.commit(generation, {
          status: 'ok',
          source: 'openai-platform-session',
          quota: result.data,
          preferences: this.getPreferences(),
        })
      }
      if (result.status !== 401 && result.status !== 403 && !result.network) {
        return this.commitFailure(generation, { status: 'error', error: result.message })
      }
    }

    let oauthFailure = null
    if (stored.accessToken || stored.refreshToken) {
      const oauth = await this._resolveViaOAuth(stored, signal)
      if (oauth.ok) {
        return this.commit(generation, {
          status: 'ok',
          source: 'openai-platform-oauth',
          quota: oauth.data,
          preferences: this.getPreferences(),
        })
      }
      oauthFailure = oauth
      // If pure Node requests hit a network/proxy wall (e.g. browser has VPN/PAC
      // while Node direct fetch times out), allow silent Ego Lite fallback below.
      if (oauth.code !== 'login-required' && oauth.code !== 'no-oauth' && !oauth.network) {
        return this.commitFailure(generation, { status: 'error', code: oauth.code, error: oauth.message })
      }
    }

    // Background recovery may reuse an already logged-in Ego Lite profile, but
    // never opens a new system browser window without an explicit user action.
    const synced = await this.syncFromBrowser({
      internal: true,
      allowSystemBrowser: false,
      signal,
      expectedGeneration: generation,
    })
    if (synced.ok) return synced.state
    if (oauthFailure?.network && synced.code === 'login-required') {
      return this.commitFailure(generation, {
        status: 'error',
        code: 'network',
        error: oauthFailure.message || 'OpenAI 网络连接超时，将在后台自动重试',
      })
    }
    return this.commitFailure(generation, {
      status: synced.code === 'login-required' ? 'unauthorized' : 'error',
      code: synced.code,
      error: synced.error || 'OpenAI Platform 登录态已过期，请点击「同步 OpenAI 登录态」重新登录',
    })
  }

  async _resolveViaOAuth(stored, signal) {
    if (this.oauthInFlight) return await this._waitForOAuth(this.oauthInFlight, signal)
    const entry = {
      controller: new AbortController(),
      subscribers: new Set(),
      abortTimer: null,
      promise: null,
    }
    this.controllers.add(entry.controller)
    entry.promise = this._resolveViaOAuthOnce(stored, entry.controller.signal).finally(() => {
      if (entry.abortTimer) {
        clearTimeout(entry.abortTimer)
        entry.abortTimer = null
      }
      this.controllers.delete(entry.controller)
      if (this.oauthInFlight === entry) this.oauthInFlight = null
    })
    this.oauthInFlight = entry
    return await this._waitForOAuth(entry, signal)
  }

  async _waitForOAuth(entry, signal) {
    if (entry.abortTimer) {
      clearTimeout(entry.abortTimer)
      entry.abortTimer = null
    }
    const sub = {}
    entry.subscribers.add(sub)
    if (!signal) {
      try {
        return await entry.promise
      } finally {
        entry.subscribers.delete(sub)
      }
    }
    if (signal.aborted) {
      entry.subscribers.delete(sub)
      if (entry.subscribers.size === 0 && !entry.abortTimer) {
        entry.abortTimer = setTimeout(() => {
          entry.abortTimer = null
          if (entry.subscribers.size === 0) {
            try { entry.controller.abort() } catch {}
          }
        }, 250)
        entry.abortTimer.unref?.()
      }
      return { ok: false, code: 'aborted', message: 'OpenAI OAuth 请求已取消' }
    }
    let onAbort
    const cancelled = new Promise(resolve => {
      onAbort = () => {
        entry.subscribers.delete(sub)
        if (entry.subscribers.size === 0 && !entry.abortTimer) {
          entry.abortTimer = setTimeout(() => {
            entry.abortTimer = null
            if (entry.subscribers.size === 0) {
              try { entry.controller.abort() } catch {}
            }
          }, 250)
          entry.abortTimer.unref?.()
        }
        resolve({ ok: false, code: 'aborted', message: 'OpenAI OAuth 请求已取消' })
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([entry.promise, cancelled])
    } finally {
      entry.subscribers.delete(sub)
      signal.removeEventListener('abort', onAbort)
    }
  }

  async _resolveViaOAuthOnce(stored, signal) {
    // Re-read credentials in case another refresh rotated tokens just before us.
    const latest = await this.readStoredSession()
    let accessToken = latest?.accessToken || stored.accessToken
    let refreshToken = latest?.refreshToken || stored.refreshToken
    let accessExpiresAt = latest?.accessExpiresAt ?? stored.accessExpiresAt
    const deviceId = latest?.deviceId || stored.deviceId || ''
    let didRefresh = false

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!isTokenUsable(accessToken, accessExpiresAt)) {
        if (!refreshToken) return { ok: false, code: 'no-oauth', message: '缺少可用的 OpenAI Platform OAuth 令牌' }
        const expectedRefresh = refreshToken
        const refreshed = await refreshOpenAiPlatformOAuthToken(refreshToken, deviceId, signal)
        if (!refreshed.ok) return refreshed
        accessToken = refreshed.accessToken
        refreshToken = refreshed.refreshToken
        accessExpiresAt = refreshed.accessExpiresAt
        didRefresh = true
        try {
          // Persist a rotated refresh token before any subsequent network call.
          const applied = await this.saveCredentials({ accessToken, refreshToken, accessExpiresAt }, expectedRefresh)
          if (!applied) return { ok: false, code: 'credential-changed', message: 'OpenAI 凭证已被其他同步更新，请重试' }
        } catch (error) {
          return { ok: false, code: 'credential-write-failed', message: scrubSecrets(error instanceof Error ? error.message : String(error)) }
        }
      }

      const exchanged = await exchangeOpenAiAccessTokenForSession(accessToken, signal)
      if (!exchanged.ok) {
        if (exchanged.code === 'login-required' && refreshToken && !didRefresh) {
          accessToken = ''
          accessExpiresAt = 0
          continue
        }
        return exchanged
      }

      const balance = await fetchOpenAiCreditBalance(exchanged.sessionKey, exchanged.organizationId, signal)
      if (!balance.ok) {
        // Save the valid exchanged session so the next retry skips onboarding/login.
        await this.saveCredentials({
          sessionKey: exchanged.sessionKey,
          organizationId: exchanged.organizationId,
          accessToken,
          refreshToken,
          accessExpiresAt,
        }, refreshToken).catch(() => {})
        return balance
      }
      try {
        const applied = await this.saveCredentials({
          sessionKey: exchanged.sessionKey,
          organizationId: exchanged.organizationId,
          accessToken,
          refreshToken,
          accessExpiresAt,
        }, refreshToken)
        if (!applied) return { ok: false, code: 'credential-changed', message: 'OpenAI 凭证已被其他同步更新，请重试' }
      } catch (error) {
        return { ok: false, code: 'credential-write-failed', message: scrubSecrets(error instanceof Error ? error.message : String(error)) }
      }
      return { ok: true, data: balance.data }
    }
    return { ok: false, code: 'login-required', message: 'OpenAI Platform OAuth 令牌已失效，请重新同步' }
  }

  async syncFromBrowser(options = {}) {
    const generation = options.expectedGeneration ?? this.generation
    if (generation !== this.generation || this.disposed) {
      return { ok: false, error: '同步已被更新或取消，请重试' }
    }
    const synced = await syncOpenAiSessionFromBrowser(Boolean(options.force), options.signal, {
      allowSystemBrowser: options.allowSystemBrowser !== false,
    })
    if (generation !== this.generation || this.disposed) {
      return { ok: false, error: '同步已被更新或取消，请重试' }
    }
    if (!synced?.sessionKey) {
      return { ok: false, code: synced?.code || '', error: scrubSecrets(synced?.error || '未能同步 OpenAI Platform 登录态') }
    }
    return await this.saveSession(synced, { ...options, expectedGeneration: generation })
  }

  async saveSession(session, options = {}) {
    if (options.expectedGeneration !== undefined && options.expectedGeneration !== this.generation) {
      return { ok: false, error: '同步已被更新或取消，请重试' }
    }
    const generation = ++this.generation
    if (!options.internal) {
      this.inFlight?.abort()
      openAiLoginPending = null
    }
    const sessionKey = normalizeSecretInput(session.sessionKey)
    const organizationId = typeof session.organizationId === 'string' ? session.organizationId.trim() : ''
    if (!sessionKey.startsWith('sess-')) return { ok: false, error: 'OpenAI Platform 登录态无效，请重新同步' }

    const controller = new AbortController()
    this.controllers.add(controller)
    const onAbort = () => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    let probe
    try {
      if (session.balance && typeof session.balance === 'object') {
        probe = await fetchOpenAiCreditBalanceFromBody(session.balance, organizationId)
      } else {
        probe = await fetchOpenAiCreditBalance(sessionKey, organizationId, controller.signal)
      }
    } catch (error) {
      probe = { ok: false, error: scrubSecrets(error instanceof Error ? error.message : String(error)) }
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      this.controllers.delete(controller)
    }
    if (generation !== this.generation || this.disposed) return { ok: false, error: '同步已被更新或取消，请重试' }
    if (!probe.ok) return { ok: false, error: probe.message || probe.error || 'OpenAI 余额校验失败，请重试' }

    const payload = {
      sessionKey,
      organizationId,
    }
    if (session.accessToken) payload.accessToken = session.accessToken
    if (session.refreshToken) payload.refreshToken = session.refreshToken
    if (session.accessExpiresAt) payload.accessExpiresAt = session.accessExpiresAt
    if (session.deviceId) payload.deviceId = session.deviceId
    try {
      await this.saveCredentials(payload)
    } catch (error) {
      return { ok: false, error: '会话已验证，但保存到 DSH 凭证库失败: ' + scrubSecrets(error instanceof Error ? error.message : String(error)) }
    }
    if (generation !== this.generation || this.disposed) return { ok: false, error: '同步已被更新或取消，请重试' }

    const state = {
      status: 'ok',
      source: session.source || 'openai-platform-browser',
      quota: probe.data,
      preferences: this.getPreferences(),
    }
    this.failureCount = 0
    this.cached = state
    return { ok: true, state }
  }
}

export function apply(ctx, config) {
  const cliService = new CodexCliQuotaService(ctx, config)
  const apiService = new CodexApiQuotaService(ctx, config)
  ctx.effect(() => () => {
    cliService.dispose()
    apiService.dispose()
  }, 'codex-credit-hub: service cleanup')

  const handleRequest = async (endpoint, payload, signal) => {
    try {
      const body = payload && typeof payload === 'object' ? payload : {}
      switch (endpoint) {
        case 'cli/quota/get': {
          const state = await cliService.getQuota({ force: Boolean(body.force), signal })
          return { ok: true, value: state }
        }
        case 'api/quota/get': {
          const state = await apiService.getQuota({ force: Boolean(body.force), signal })
          return { ok: true, value: state }
        }
        case 'api/session/sync': {
          const res = await apiService.syncFromBrowser({ force: true, signal })
          if (!res.ok) {
            return {
              ok: false,
              error: { code: 'codex-credit-hub/session-sync-failed', message: res.error, details: {} },
            }
          }
          return { ok: true, value: res.state }
        }
        default:
          return {
            ok: false,
            error: { code: 'gateway/bad-request', message: `Unknown endpoint: ${endpoint}`, details: {} },
          }
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'gateway/internal',
          message: scrubSecrets(error instanceof Error ? error.message : String(error)),
          details: {},
        },
      }
    }
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/codex-credit-hub',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await request.json()
        const result = await handleRequest(body?.endpoint, body?.payload, request.signal)
        return Response.json(result)
      } catch (error) {
        return Response.json({
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: scrubSecrets(error instanceof Error ? error.message : String(error)),
            details: {},
          },
        }, { status: 400 })
      }
    },
  }), 'codex-credit-hub: HTTP API')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'codex_cli_quota',
    description: 'Query or refresh live Codex subscription rate-limit remaining percentage, reset window, and credits.',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'refresh'],
        description: 'Operation to perform: "status" returns cached quota within 10s, "refresh" forces an immediate API/app-server refresh.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'ok'
          ? `Codex (${value.quota.planType || 'ChatGPT'}): ${value.quota.remainingPercent.toFixed(2)}% remaining (${value.quota.usedPercent.toFixed(2)}% used)${value.quota.primaryWindow?.windowLabel ? `, window ${value.quota.primaryWindow.windowLabel}` : ''}.${value.stale ? ` [stale: ${value.error || 'retrying'}]` : ''}`
          : `Codex Quota: ${value.error || value.status}`,
      }],
    },
    isConcurrencySafe: () => true,
    timeoutMs: 30_000,
    async execute(args, exec) {
      return await cliService.getQuota({
        force: (args.action ?? 'status') === 'refresh',
        signal: exec.signal,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'refresh' ? 'Refresh Codex CLI quota' : 'Check Codex CLI quota',
      kind: 'read',
      rawInput: args,
    }),
  })), 'codex-credit-hub: CLI tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'codex_api_quota',
    description: 'Query or refresh the live OpenAI / Codex API current credit balance and grant usage from the local OpenAI Platform login session.',
    parameters: {
      action: {
        type: 'string',
        enum: ['status', 'refresh', 'sync_browser'],
        description: 'Operation to perform: "status" returns cached API usage within 10s, "refresh" forces an immediate refresh, and "sync_browser" refreshes the local OpenAI Platform login session.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.status === 'ok'
          ? `Codex API: $${value.quota.remainingUsd.toFixed(2)} remaining (${value.quota.remainingPercent.toFixed(2)}%), $${value.quota.totalUsedUsd.toFixed(2)} used of $${value.quota.totalGrantedUsd.toFixed(2)}.${value.stale ? ` [stale: ${value.error || 'retrying'}]` : ''}`
          : `Codex API Quota: ${value.error || value.status}`,
      }],
    },
    isConcurrencySafe: (args) => args?.action !== 'sync_browser',
    timeoutMs: 200_000,
    async execute(args, exec) {
      const action = args.action ?? 'status'
      if (action === 'sync_browser') {
        const res = await apiService.syncFromBrowser({ force: true, signal: exec.signal })
        if (!res.ok) throw new Error(res.error)
        return res.state
      }
      return await apiService.getQuota({
        force: action === 'refresh',
        signal: exec.signal,
      })
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.action === 'refresh' ? 'Refresh Codex API usage' : args.action === 'sync_browser' ? 'Sync OpenAI Platform login' : 'Check Codex API usage',
      kind: 'read',
      rawInput: args,
    }),
  })), 'codex-credit-hub: API tool')
}
