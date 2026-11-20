window.__ModuleLoader__.load({
  id: 'dsh-codex-credit-hub',
  factory(require) {
    const React = require('react')
    const { createPortal } = require('react-dom')
    const h = React.createElement
    const NS = 'codex-credit-hub'
    const API_PATH = 'api/codex-credit-hub'
    const CODEX_WEB_URL = 'https://chatgpt.com/codex/settings/usage'
    const OPENAI_WEB_URL = 'https://platform.openai.com/home'

    async function callApi(endpoint, payload, signal) {
      const response = await fetch(API_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint, payload }),
        signal,
      })
      if (!response.ok) throw new Error(`Codex Credit request failed: HTTP ${response.status}`)
      return await response.json()
    }

    const en = {
      loading: 'Loading…', unavailable: 'Unavailable', notConfigured: 'Not connected',
      cliLabel: 'Codex', cliTitle: 'Codex', cliSubtitle: 'Codex subscription rate limits',
      apiLabel: 'Codex API', apiTitle: 'Codex API', apiSubtitle: 'OpenAI Platform credit balance',
      remaining: 'remaining', used: 'used', primaryWindow: 'Primary window', secondaryWindow: 'Secondary window',
      resetsAt: 'Resets', resetCredits: 'Reset credits', creditsBalance: 'Credits balance', unlimited: 'Unlimited',
      totalGranted: 'Total granted', totalUsed: 'Total used', remainingCredit: 'Credit remaining',
      nextExpiry: 'Next expiry', updated: 'Updated', refresh: 'Refresh', refreshing: 'Refreshing…',
      manage: 'Manage usage', close: 'Close quota details', error: 'Unable to load Codex quota', retry: 'Try again',
      syncBrowser: 'Sync OpenAI login', syncingBrowser: 'Syncing…',
      stale: 'Showing the last successful balance; retrying in the background.',
      apiHint: 'Uses Ego Lite when available, or opens a dedicated Chrome / Edge login window once. Later refreshes run in the background. No API key is required.',
      cliHint: 'Reads ~/.codex/auth.json (read-only) or `codex app-server`. Run `codex login` in terminal to sign in.',
    }
    const zh = {
      loading: '读取中…', unavailable: '暂不可用', notConfigured: '未连接',
      cliLabel: 'Codex', cliTitle: 'Codex', cliSubtitle: 'Codex 订阅额度与限流窗口',
      apiLabel: 'Codex API', apiTitle: 'Codex API', apiSubtitle: 'OpenAI 平台真实余额',
      remaining: '剩余', used: '已用', primaryWindow: '主限额窗口', secondaryWindow: '次级限额窗口',
      resetsAt: '重置时间', resetCredits: '重置次数券', creditsBalance: '附加积分余额', unlimited: '无限制',
      totalGranted: '总额度', totalUsed: '已用额度', remainingCredit: '剩余余额',
      nextExpiry: '最近到期', updated: '更新于', refresh: '刷新', refreshing: '刷新中…',
      manage: '管理用量', close: '关闭额度详情', error: '暂时无法读取 Codex 额度', retry: '重试',
      syncBrowser: '同步 OpenAI 登录态', syncingBrowser: '同步中…',
      stale: '显示上次成功读取的余额，后台正在自动重试。',
      apiHint: '优先复用 Ego Lite；没有时会用系统 Chrome / Edge 打开一次专用登录窗口。后续在后台自动续期，无需输入 API Key。',
      cliHint: '自动只读读取 ~/.codex/auth.json 或 codex app-server；若未登录请在终端执行 `codex login`。',
    }

    const CSS = `
.cxh-hubs{display:flex;flex-direction:column;width:100%;gap:2px}.cxh-hubsRail{width:36px;gap:8px}.cxh-root{position:relative;display:flex;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}.cxh-rootWide{width:100%}.cxh-rootRail{width:36px;justify-content:center}.cxh-trigger{display:flex;align-items:center;gap:8px;box-sizing:border-box;border:0;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer;background:transparent}.cxh-triggerWide{width:100%;min-height:36px;padding:6px calc(var(--dsh-sidebar-row-padding,12px) - var(--dsh-sidebar-paint-inset,3px));border-inline:var(--dsh-sidebar-paint-inset,3px) solid transparent;border-radius:var(--dsw-radius-md);background-clip:padding-box}.cxh-triggerRail{width:36px;height:36px;justify-content:center;padding:0;border-radius:var(--dsw-radius-md)}.cxh-trigger:hover,.cxh-trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.cxh-trigger:focus-visible,.cxh-close:focus-visible,.cxh-refresh:focus-visible,.cxh-manage:focus-visible,.cxh-retry:focus-visible,.cxh-linkBtn:focus-visible,.cxh-primary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}.cxh-ring{flex:none;width:16px;height:16px}.cxh-triggerRail .cxh-ring{width:18px;height:18px}.cxh-track{fill:none;stroke:var(--dsw-alias-border-l3);stroke-width:1.8}.cxh-fill{fill:none;stroke:var(--cxh-color,var(--dsw-alias-state-business-primary));stroke-width:1.8;stroke-linecap:round}.cxh-name{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px}.cxh-values{display:flex;align-items:baseline;gap:6px;min-width:0;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}.cxh-amountCompact{overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}.cxh-percentCompact{flex:none;color:var(--cxh-color,var(--dsw-alias-state-business-primary));font-size:11px}.cxh-panel{box-sizing:border-box;width:min(312px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow-y:auto;padding:16px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}body[data-ds-dark-theme] .cxh-panel{--dsw-elevation-stroke-color:var(--dsw-alias-border-l3)}.cxh-panel:focus{outline:none}.cxh-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.cxh-title{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}.cxh-subtitle{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow-wrap:anywhere}.cxh-close{display:grid;place-items:center;flex:none;width:24px;height:24px;margin:-4px -4px 0 0;padding:0;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}.cxh-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.cxh-hero{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;margin-top:20px}.cxh-bigAmount{color:var(--dsw-alias-label-primary);font-size:28px;font-weight:600;line-height:32px;letter-spacing:-.5px;font-variant-numeric:tabular-nums}.cxh-available{margin-top:3px;color:var(--dsw-alias-label-tertiary);font-size:11px}.cxh-percentBadge{flex:none;margin-bottom:4px;padding:2px 7px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);color:var(--cxh-color,var(--dsw-alias-state-business-primary));font-size:11px;font-weight:500;font-variant-numeric:tabular-nums}.cxh-progress{display:flex;gap:2px;height:4px;margin:14px 0 16px;border-radius:999px;corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);overflow:hidden}.cxh-progressUsed{background:var(--dsw-alias-border-l4)}.cxh-progressLeft{background:var(--cxh-color,var(--dsw-alias-state-business-primary))}.cxh-facts{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}.cxh-factLabel{color:var(--dsw-alias-label-tertiary);font-size:11px}.cxh-factValue{margin-top:3px;color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;font-variant-numeric:tabular-nums}.cxh-factSub{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;font-variant-numeric:tabular-nums}.cxh-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.cxh-updated{color:var(--dsw-alias-label-tertiary);font-size:10px;font-variant-numeric:tabular-nums}.cxh-footerActions{display:flex;align-items:center;gap:8px}.cxh-refresh,.cxh-linkBtn{display:inline-flex;align-items:center;gap:4px;padding:2px 5px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}.cxh-refresh:hover:not(:disabled),.cxh-linkBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.cxh-refresh:disabled,.cxh-linkBtn:disabled{opacity:.45;cursor:default}.cxh-manage{display:flex;align-items:center;justify-content:space-between;width:100%;margin-top:12px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:500;cursor:pointer}.cxh-manage:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-dimmed)}.cxh-error{margin:12px 0 0;color:var(--dsw-alias-state-error-primary);font-size:11px;line-height:17px;overflow-wrap:anywhere}.cxh-errorActions{display:flex;gap:8px;margin-top:12px}.cxh-retry{padding:5px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer}.cxh-retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.cxh-retry:disabled{opacity:.45;cursor:default}.cxh-loading{margin:22px 0 8px;color:var(--dsw-alias-label-tertiary);text-align:center}.cxh-help{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.cxh-primary{box-sizing:border-box;width:100%;min-height:30px;margin-top:12px;padding:6px 12px;border:1px solid transparent;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color,#fff);font:inherit;font-size:12px;font-weight:500;cursor:pointer}.cxh-primary:hover:not(:disabled){opacity:.9}.cxh-primary:disabled{opacity:.45;cursor:default}
`

    function createStore(ctx, endpoint) {
      let snapshot = { status: 'loading' }
      let disposed = false
      let timer = null
      let generation = 0
      let mutating = false
      let activeController = null
      const listeners = new Set()
      const emit = (next) => { snapshot = next; for (const listener of [...listeners]) listener() }
      const cancelActive = () => {
        if (activeController) {
          try { activeController.abort() } catch {}
          activeController = null
        }
      }
      const schedule = (state) => {
        if (disposed) return
        if (timer !== null) clearTimeout(timer)
        const seconds = state?.retryAfterSec ?? state?.preferences?.refreshIntervalSec ?? 60
        timer = setTimeout(() => { void load(false) }, Math.max(15, seconds) * 1000)
      }
      const load = async (force = false) => {
        // Never let a background timer or connection reset supersede an active
        // interactive login sync initiated by the user.
        if (mutating) return
        if (timer !== null) { clearTimeout(timer); timer = null }
        cancelActive()
        const current = ++generation
        const controller = new AbortController()
        activeController = controller
        if (snapshot.status === 'ok') emit({ ...snapshot, error: undefined })
        else emit({ ...snapshot, status: 'loading', error: undefined })
        try {
          const result = await callApi(endpoint, { force }, controller.signal)
          if (disposed || current !== generation) return
          if (result.ok) { emit(result.value); schedule(result.value) }
          else {
            const next = snapshot.status === 'ok' ? { ...snapshot, error: result.error.message } : { status: 'error', error: result.error.message }
            emit(next); schedule(next)
          }
        } catch (error) {
          if (disposed || current !== generation || error?.name === 'AbortError') return
          const message = error instanceof Error ? error.message : String(error)
          const next = snapshot.status === 'ok' ? { ...snapshot, error: message } : { status: 'error', error: message }
          emit(next); schedule(next)
        } finally {
          if (activeController === controller) activeController = null
        }
      }
      const mutate = async (mutEndpoint, payload) => {
        if (timer !== null) { clearTimeout(timer); timer = null }
        cancelActive()
        const current = ++generation
        mutating = true
        const controller = new AbortController()
        activeController = controller
        const previous = snapshot
        emit({ ...snapshot, error: undefined })
        try {
          const result = await callApi(mutEndpoint, payload, controller.signal)
          if (!result.ok) {
            const message = result.error.message
            if (!disposed && current === generation) {
              const next = previous.status === 'ok' ? { ...previous, error: message } : { ...previous, status: previous.status === 'unauthorized' ? 'unauthorized' : 'error', error: message }
              emit(next)
              schedule(next)
            }
            throw new Error(message)
          }
          if (disposed || current !== generation) return result.value
          emit(result.value); schedule(result.value)
          return result.value
        } catch (error) {
          if (!disposed && current === generation && error?.name !== 'AbortError' && snapshot.error === undefined) {
            const message = error instanceof Error ? error.message : String(error)
            const next = previous.status === 'ok' ? { ...previous, error: message } : { ...previous, status: previous.status === 'unauthorized' ? 'unauthorized' : 'error', error: message }
            emit(next)
            schedule(next)
          }
          throw error
        } finally {
          if (activeController === controller) activeController = null
          if (current === generation) mutating = false
        }
      }
      const initializedAt = Date.now()
      const offReset = ctx.on('connection/reset', () => { if (Date.now() - initializedAt > 3000) void load(true) })
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
        loadInitial: () => load(false),
        refresh: () => load(true), mutate,
        dispose: () => { disposed = true; mutating = false; if (timer !== null) clearTimeout(timer); cancelActive(); offReset(); listeners.clear() },
      }
    }

    function formatUsd(value) {
      const n = Number(value ?? 0)
      return Number.isFinite(n) ? `$${n.toFixed(2)}` : '$0.00'
    }
    function formatResetTime(resetAtMs) {
      if (!resetAtMs) return '—'
      const d = new Date(resetAtMs)
      return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    }
    function Ring({ percent }) {
      const radius = 5.7, circumference = 2 * Math.PI * radius
      const safe = Math.max(0, Math.min(100, Number(percent ?? 0)))
      return h('svg', { className: 'cxh-ring', viewBox: '0 0 16 16', 'aria-hidden': true },
        h('circle', { className: 'cxh-track', cx: 8, cy: 8, r: radius }),
        h('circle', { className: 'cxh-fill', cx: 8, cy: 8, r: radius, strokeDasharray: `${circumference * safe / 100} ${circumference}`, transform: 'rotate(-90 8 8)' }))
    }
    function RefreshIcon() {
      return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M13.2 5.2A5.5 5.5 0 1 0 13 11M13.2 5.2V1.8m0 3.4H9.8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    function CodexPill({ store, kind, t, wide, label, title, subtitle, open, onOpenChange, fallbackUrl }) {
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const [busy, setBusy] = React.useState('')
      const [actionError, setActionError] = React.useState('')
      const [position, setPosition] = React.useState({ left: 12, top: 12 })
      const rootRef = React.useRef(null), triggerRef = React.useRef(null), panelRef = React.useRef(null)
      const quota = state.status === 'ok' ? state.quota : null
      const isCli = kind === 'cli'
      const percent = quota ? Number(quota.remainingPercent ?? 0) : 0
      const low = quota && percent <= 20
      const format = state.preferences?.displayFormat ?? 'both'
      let amountText = state.status === 'loading' ? t('loading') : (state.status === 'unauthorized' ? t('notConfigured') : t('unavailable'))
      let percentText = ''
      if (quota) {
        if (isCli) {
          amountText = format === 'percent' ? `${percent.toFixed(0)}%` : (quota.planType ? quota.planType.toUpperCase() : 'Codex')
          percentText = format === 'remaining' || format === 'percent' ? '' : `${percent.toFixed(0)}%`
        } else {
          amountText = format === 'percent' ? `${percent.toFixed(0)}%` : formatUsd(quota.remainingUsd)
          percentText = format === 'remaining' || format === 'percent' ? '' : `${percent.toFixed(0)}%`
        }
      }
      const fullLabel = quota ? `${title}: ${isCli ? `${percent.toFixed(1)}% ${t('remaining')}` : `${formatUsd(quota.remainingUsd)} (${percent.toFixed(1)}%)`}` : `${title}: ${amountText}`

      React.useLayoutEffect(() => {
        if (!open) return
        const update = () => {
          if (!rootRef.current) return
          const rect = rootRef.current.getBoundingClientRect(), width = panelRef.current?.offsetWidth ?? 312, height = panelRef.current?.offsetHeight ?? 320
          const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
          let top
          if (rect.top - height - 8 >= 12) top = rect.top - height - 8
          else if (rect.bottom + height + 8 <= window.innerHeight - 12) top = rect.bottom + 8
          else top = Math.max(12, Math.min(rect.top - height - 8, window.innerHeight - height - 12))
          setPosition({ left, top })
        }
        update()
        const observer = typeof ResizeObserver === 'undefined' || !panelRef.current ? null : new ResizeObserver(update)
        observer?.observe(panelRef.current)
        if (rootRef.current) observer?.observe(rootRef.current)
        window.addEventListener('resize', update); window.addEventListener('scroll', update, true)
        return () => { observer?.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true) }
      }, [open, state, actionError, wide])

      React.useEffect(() => {
        if (!open) return
        const previous = document.activeElement, panel = panelRef.current
        panel?.focus()
        const onKey = (event) => {
          if (event.key === 'Escape') { onOpenChange(false); return }
          if (event.key !== 'Tab' || !panel) return
          const focusable = [...panel.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
          if (!focusable.length) { event.preventDefault(); panel.focus(); return }
          const first = focusable[0], last = focusable[focusable.length - 1]
          const activeElement = document.activeElement
          if (event.shiftKey && (activeElement === first || activeElement === panel || !panel.contains(activeElement))) {
            event.preventDefault(); last.focus()
          } else if (!event.shiftKey && (activeElement === last || !panel.contains(activeElement))) {
            event.preventDefault(); first.focus()
          }
        }
        const onPointer = (event) => { if (!rootRef.current?.contains(event.target) && !panelRef.current?.contains(event.target)) onOpenChange(false) }
        document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onPointer, true)
        return () => {
          document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointer, true)
          if (previous instanceof HTMLElement && previous.isConnected && !panel?.contains(previous)) previous.focus()
          else triggerRef.current?.focus()
        }
      }, [open])

      const refresh = async () => {
        setBusy('refresh'); setActionError('')
        try { await store.refresh() } catch (cause) { if (cause?.name !== 'AbortError') setActionError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(prev => prev === 'refresh' ? '' : prev) }
      }
      const sync = async () => {
        setBusy('sync'); setActionError('')
        try { await store.mutate('api/session/sync', {}) } catch (cause) { if (cause?.name !== 'AbortError') setActionError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(prev => prev === 'sync' ? '' : prev) }
      }
      const manage = () => { window.open(quota?.webUrl || state.webUrl || fallbackUrl, '_blank', 'noopener,noreferrer'); onOpenChange(false) }
      const updated = quota ? new Date(quota.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
      const dynamicSubtitle = quota && isCli ? [quota.email, quota.planType?.toUpperCase()].filter(Boolean).join(' · ') || subtitle : subtitle
      const nextExpiry = !isCli && quota?.grants?.filter(g => g.expiresAtMs && g.remainingAmount > 0).sort((a, b) => a.expiresAtMs - b.expiresAtMs)[0]
      const syncButton = h('button', { type: 'button', className: 'cxh-linkBtn', disabled: busy !== '', onClick: sync }, busy === 'sync' ? t('syncingBrowser') : t('syncBrowser'))

      return h('span', { ref: rootRef, className: `cxh-root ${wide ? 'cxh-rootWide' : 'cxh-rootRail'}`, style: { '--cxh-color': low ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-business-primary)' }, 'data-codex-credit-hub': kind },
        h('button', { ref: triggerRef, type: 'button', className: `cxh-trigger ${wide ? 'cxh-triggerWide' : 'cxh-triggerRail'}`, title: fullLabel, 'aria-label': fullLabel, 'aria-haspopup': 'dialog', 'aria-expanded': open, onClick: () => onOpenChange(!open) },
          h(Ring, { percent }), wide && h(React.Fragment, null, h('span', { className: 'cxh-name' }, label), h('span', { className: 'cxh-values' }, h('span', { className: 'cxh-amountCompact' }, amountText), percentText && h('span', { className: 'cxh-percentCompact' }, percentText)))),
        open && createPortal(h('div', { ref: panelRef, className: 'cxh-panel', role: 'dialog', 'aria-label': title, tabIndex: -1, style: { position: 'fixed', left: position.left, top: position.top, zIndex: 1100 } },
          h('div', { className: 'cxh-header' }, h('div', null, h('div', { className: 'cxh-title' }, title), h('div', { className: 'cxh-subtitle' }, dynamicSubtitle)), h('button', { type: 'button', className: 'cxh-close', 'aria-label': t('close'), onClick: () => onOpenChange(false) }, h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true }, h('path', { d: 'm4 4 8 8m0-8-8 8', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' })))),
          quota && isCli && h(React.Fragment, null,
            h('div', { className: 'cxh-hero' }, h('div', null, h('div', { className: 'cxh-bigAmount' }, `${percent.toFixed(1)}%`), h('div', { className: 'cxh-available' }, `${quota.primaryWindow?.windowLabel || ''} ${t('remaining')}`.trim())), h('span', { className: 'cxh-percentBadge' }, `${t('used')} ${quota.usedPercent.toFixed(1)}%`)),
            h('div', { className: 'cxh-progress', role: 'progressbar', 'aria-label': quota.primaryWindow ? t('primaryWindow') : t('secondaryWindow'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent, 'aria-valuetext': `${t('remaining')} ${percent.toFixed(1)}%` }, h('div', { className: 'cxh-progressUsed', style: { width: `${quota.usedPercent}%` } }), h('div', { className: 'cxh-progressLeft', style: { width: `${percent}%` } })),
            h('div', { className: 'cxh-facts' },
              h('div', null, h('div', { className: 'cxh-factLabel' }, t('primaryWindow')), h('div', { className: 'cxh-factValue' }, quota.primaryWindow ? `${quota.primaryWindow.remainingPercent.toFixed(1)}% (${quota.primaryWindow.windowLabel || '—'})` : '—'), quota.primaryWindow?.resetAtMs && h('div', { className: 'cxh-factSub' }, `${t('resetsAt')} ${formatResetTime(quota.primaryWindow.resetAtMs)}`)),
              h('div', null, h('div', { className: 'cxh-factLabel' }, t('secondaryWindow')), h('div', { className: 'cxh-factValue' }, quota.secondaryWindow ? `${quota.secondaryWindow.remainingPercent.toFixed(1)}% (${quota.secondaryWindow.windowLabel || '—'})` : '—'), quota.secondaryWindow?.resetAtMs && h('div', { className: 'cxh-factSub' }, `${t('resetsAt')} ${formatResetTime(quota.secondaryWindow.resetAtMs)}`)),
              h('div', null, h('div', { className: 'cxh-factLabel' }, t('creditsBalance')), h('div', { className: 'cxh-factValue' }, quota.unlimitedCredits ? t('unlimited') : (quota.creditBalance !== null ? formatUsd(quota.creditBalance) : '—'))),
              h('div', null, h('div', { className: 'cxh-factLabel' }, t('resetCredits')), h('div', { className: 'cxh-factValue' }, String(quota.resetCreditsCount ?? 0)))),
            h('div', { className: 'cxh-footer' }, h('span', { className: 'cxh-updated' }, `${t('updated')} ${updated}`), h('button', { type: 'button', className: 'cxh-refresh', disabled: busy !== '', onClick: refresh }, h(RefreshIcon), busy === 'refresh' ? t('refreshing') : t('refresh')))),
          quota && !isCli && h(React.Fragment, null,
            h('div', { className: 'cxh-hero' }, h('div', null, h('div', { className: 'cxh-bigAmount' }, formatUsd(quota.remainingUsd)), h('div', { className: 'cxh-available' }, t('remainingCredit'))), h('span', { className: 'cxh-percentBadge' }, `${t('remaining')} ${percent.toFixed(1)}%`)),
            h('div', { className: 'cxh-progress', role: 'progressbar', 'aria-label': t('remainingCredit'), 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': percent, 'aria-valuetext': `${t('remaining')} ${percent.toFixed(1)}%` }, h('div', { className: 'cxh-progressUsed', style: { width: `${quota.usedPercent}%` } }), h('div', { className: 'cxh-progressLeft', style: { width: `${percent}%` } })),
            h('div', { className: 'cxh-facts' },
              h('div', null, h('div', { className: 'cxh-factLabel' }, t('totalGranted')), h('div', { className: 'cxh-factValue' }, formatUsd(quota.totalGrantedUsd))),
              h('div', null, h('div', { className: 'cxh-factLabel' }, t('totalUsed')), h('div', { className: 'cxh-factValue' }, formatUsd(quota.totalUsedUsd))),
              nextExpiry && h('div', null, h('div', { className: 'cxh-factLabel' }, t('nextExpiry')), h('div', { className: 'cxh-factValue' }, formatResetTime(nextExpiry.expiresAtMs)))),
            h('div', { className: 'cxh-footer' }, h('span', { className: 'cxh-updated' }, `${t('updated')} ${updated}`), h('div', { className: 'cxh-footerActions' }, syncButton, h('button', { type: 'button', className: 'cxh-refresh', disabled: busy !== '', onClick: refresh }, h(RefreshIcon), busy === 'refresh' ? t('refreshing') : t('refresh'))))),
          quota && state.stale && h('p', { className: 'cxh-help', role: 'status' }, t('stale')),
          quota && state.error && !actionError && h('p', { className: 'cxh-error', role: 'status' }, state.error),
          !quota && state.status === 'loading' && h('div', { className: 'cxh-loading' }, t('loading')),
          !quota && state.status !== 'loading' && !actionError && h('p', { className: state.status === 'unauthorized' ? 'cxh-help' : 'cxh-error', role: 'status' }, state.error || t('error')),
          actionError && h('p', { className: 'cxh-error', role: 'status' }, actionError),
          !quota && state.status !== 'loading' && h('p', { className: 'cxh-help' }, isCli ? t('cliHint') : t('apiHint')),
          !quota && state.status !== 'loading' && h('div', { className: 'cxh-errorActions' }, isCli
            ? h('button', { type: 'button', className: 'cxh-retry', disabled: busy !== '', onClick: refresh }, busy === 'refresh' ? t('refreshing') : t('retry'))
            : h('button', { type: 'button', className: 'cxh-primary', disabled: busy !== '', onClick: sync }, busy === 'sync' ? t('syncingBrowser') : t('syncBrowser'))),
          quota && h('button', { type: 'button', className: 'cxh-manage', onClick: manage }, h('span', null, t('manage')), h('span', { 'aria-hidden': true }, '↗')),
        ), document.body),
      )
    }

    function CodexHubs({ cliStore, apiStore, t, wide }) {
      const [active, setActive] = React.useState(null)
      return h('div', { className: `cxh-hubs ${wide ? '' : 'cxh-hubsRail'}` },
        h(CodexPill, { store: cliStore, kind: 'cli', t, wide, label: t('cliLabel'), title: t('cliTitle'), subtitle: t('cliSubtitle'), open: active === 'cli', onOpenChange: value => setActive(value ? 'cli' : null), fallbackUrl: CODEX_WEB_URL }),
        h(CodexPill, { store: apiStore, kind: 'api', t, wide, label: t('apiLabel'), title: t('apiTitle'), subtitle: t('apiSubtitle'), open: active === 'api', onOpenChange: value => setActive(value ? 'api' : null), fallbackUrl: OPENAI_WEB_URL }),
      )
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'codex-credit-hub: locale')
        ctx.effect(() => {
          const tag = document.createElement('style'); tag.dataset.plugin = 'codex-credit-hub'; tag.textContent = CSS; document.head.appendChild(tag)
          const footerTag = document.createElement('style'); footerTag.dataset.plugin = 'codex-credit-hub-footer'; footerTag.textContent = '[data-slot="sidebar.footer.action"],div[class*="footerActions"]:has([data-codex-credit-hub]),div[class*="footerActions"]:has([data-catpaw-credit-hub]){flex-direction:column!important;align-items:stretch}[class*="collapsed"] div[class*="footerActions"]:has([data-codex-credit-hub]),[class*="collapsed"] div[class*="footerActions"]:has([data-catpaw-credit-hub]){align-items:center}'; document.head.appendChild(footerTag)
          return () => { tag.remove(); footerTag.remove() }
        }, 'codex-credit-hub: styles')
        const t = ctx.locale.bind(NS), cliStore = createStore(ctx, 'cli/quota/get'), apiStore = createStore(ctx, 'api/quota/get')
        void cliStore.loadInitial(); void apiStore.loadInitial()
        ctx.effect(() => () => { cliStore.dispose(); apiStore.dispose() }, 'codex-credit-hub: polling')
        const Component = (props) => h(CodexHubs, { ...props, cliStore, apiStore, t })
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'codex-credit-hub', order: 1, locale: NS }, Component))
      },
    }
  },
})
