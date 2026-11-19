import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'codex-credit-hub'
export const inject = ['connection', 'credentials', 'tools', 'webServer']

export const RECORD_SCOPE = 'codex-credit-hub'
export const RECORD_ID_API = 'codex-api'

const CODEX_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_WEB_URL = 'https://chatgpt.com/codex/settings/usage'
const OPENAI_CREDIT_GRANTS_URL = 'https://api.openai.com/v1/dashboard/billing/credit_grants'
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
    .replace(/sess-[A-Za-z0-9_-]{12,}/g, '[redacted-sess]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/rt[._][A-Za-z0-9._~+/=-]{8,}/g, '[redacted-refresh]')
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

async function fetchJson(url, options, label) {
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
        params: { clientInfo: { name: 'dsh-codex-credit-hub', version: '1.0.0' } },
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
const OPENAI_SYNC_SCRIPT = readFileSync(new URL('./openai-sync.inc.js', import.meta.url), 'utf8')

async function syncOpenAiSessionFromEgoBrowserOnce(signal) {
  return await new Promise((resolve) => {
    const script = OPENAI_SYNC_SCRIPT

    const envPath = [
      process.env.PATH ?? '',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      join(homedir(), '.local', 'bin'),
      join(homedir(), '.ego-lite', 'bin'),
    ].filter(Boolean).join(delimiter)

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
        error: error?.code === 'ENOENT'
          ? '未检测到 Ego Lite / ego-browser，请先安装 Ego Lite 并完成初始设置后重试'
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

async function syncOpenAiSessionFromEgoBrowser(force = false, signal) {
  if (openAiBrowserSyncInFlight) return await subscribeOpenAiBrowserSync(openAiBrowserSyncInFlight, signal)
  if (!force && openAiBrowserSyncLastAttempt > 0 && openAiBrowserSyncLastError && Date.now() - openAiBrowserSyncLastAttempt < OPENAI_BROWSER_SYNC_COOLDOWN_MS) {
    return { error: openAiBrowserSyncLastError }
  }
  openAiBrowserSyncLastAttempt = Date.now()
  openAiBrowserSyncLastError = ''
  const entry = {
    controller: new AbortController(),
    subscribers: new Set(),
    abortTimer: null,
    promise: null,
  }
  entry.promise = syncOpenAiSessionFromEgoBrowserOnce(entry.controller.signal)
    .then(result => {
      // A caller-local cancellation is not the shared task's outcome. Record
      // only the browser result, and clear stale errors after a real success.
      openAiBrowserSyncLastError = result?.error ? scrubSecrets(result.error) : ''
      return result
    })
    .catch(() => {
      const result = { error: 'OpenAI 浏览器同步失败，请稍后重试' }
      openAiBrowserSyncLastError = result.error
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
    if (generation === this.generation) this.cached = state
    return this.cached ?? state
  }

  async getQuota(options = {}) {
    const { force = false, signal } = options
    if (!force && this.cached && this.cached.status === 'ok') {
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
    return this.commit(generation, {
      status: isUnauth ? 'unauthorized' : 'error',
      error: rpc.message || lastError || '未检测到 Codex CLI 登录态，请在终端运行 `codex login`',
      webUrl: CODEX_WEB_URL,
      preferences: this.getPreferences(),
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
    if (generation === this.generation) this.cached = state
    return this.cached ?? state
  }

  async readStoredSession() {
    try {
      const record = await this.ctx.credentials.readRecord(this.key)
      if (record?.kind !== 'grant' || !record.payload || typeof record.payload !== 'object') return null
      const sessionKey = normalizeSecretInput(record.payload.sessionKey)
      if (!sessionKey.startsWith('sess-')) return null
      return {
        sessionKey,
        organizationId: typeof record.payload.organizationId === 'string' ? record.payload.organizationId.trim() : '',
      }
    } catch {
      return null
    }
  }

  async getQuota(options = {}) {
    const { force = false, signal } = options
    if (!force && this.cached && this.cached.status === 'ok') {
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
    if (stored) {
      const result = await fetchOpenAiCreditBalance(stored.sessionKey, stored.organizationId, signal)
      if (result.ok) {
        return this.commit(generation, {
          status: 'ok',
          source: 'openai-platform-browser',
          quota: result.data,
          preferences: this.getPreferences(),
        })
      }
      // Browser networking can use a system/VPN proxy that Node's fetch does
      // not inherit. On transport failures, retry through Platform's page.
      if (result.status !== 401 && result.status !== 403 && !result.network) {
        return this.commit(generation, {
          status: 'error',
          error: result.message,
          canSync: true,
          webUrl: OPENAI_API_WEB_URL,
          preferences: this.getPreferences(),
        })
      }
    }

    const synced = await this.syncFromBrowser({ internal: true, signal, expectedGeneration: generation })
    if (synced.ok) return synced.state
    return this.commit(generation, {
      status: synced.code === 'login-required' ? 'unauthorized' : 'error',
      error: synced.error || '未能同步 OpenAI Platform 登录态，请点击同步后重试',
      canSync: true,
      webUrl: OPENAI_API_WEB_URL,
      preferences: this.getPreferences(),
    })
  }

  async syncFromBrowser(options = {}) {
    const generation = options.expectedGeneration ?? this.generation
    if (generation !== this.generation || this.disposed) {
      return { ok: false, error: '同步已被更新或取消，请重试' }
    }
    const synced = await syncOpenAiSessionFromEgoBrowser(Boolean(options.force), options.signal)
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
    if (!options.internal) this.inFlight?.abort()
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
      source: 'openai-platform-browser',
      updatedAt: Date.now(),
    }
    try {
      await this.ctx.credentials.modifyRecord(this.key, async () => ({ kind: 'grant', payload }))
    } catch (error) {
      return { ok: false, error: '会话已验证，但保存到 DSH 凭证库失败: ' + scrubSecrets(error instanceof Error ? error.message : String(error)) }
    }
    if (generation !== this.generation || this.disposed) return { ok: false, error: '同步已被更新或取消，请重试' }

    const state = {
      status: 'ok',
      source: 'openai-platform-browser',
      quota: probe.data,
      preferences: this.getPreferences(),
    }
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
          ? `Codex (${value.quota.planType || 'ChatGPT'}): ${value.quota.remainingPercent.toFixed(2)}% remaining (${value.quota.usedPercent.toFixed(2)}% used)${value.quota.primaryWindow?.windowLabel ? `, window ${value.quota.primaryWindow.windowLabel}` : ''}.`
          : `Codex Quota: ${value.error || value.status}`,
      }],
    },
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
          ? `Codex API: $${value.quota.remainingUsd.toFixed(2)} remaining (${value.quota.remainingPercent.toFixed(2)}%), $${value.quota.totalUsedUsd.toFixed(2)} used of $${value.quota.totalGrantedUsd.toFixed(2)}.`
          : `Codex API Quota: ${value.error || value.status}`,
      }],
    },
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
