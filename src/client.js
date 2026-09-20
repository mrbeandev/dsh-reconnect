window.__ModuleLoader__.load({ id: 'dsh-reconnect', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

  const react = require('react')
  const { useEffect, useState, useSyncExternalStore } = react
  // DSH 0.1.5-rc.2 does not ship the newer dsh-client-web-react helper.
  // Bind the settings scope directly with React's standard external-store hook.
  const bindSnapshotSelector = (source) => {
    const subscribe = (listener) => source.subscribe(listener)
    const getSnapshot = () => source.getSnapshot()
    return (selector) => selector(useSyncExternalStore(subscribe, getSnapshot, getSnapshot))
  }
  const SETTINGS_NAMESPACE = 'dsh-reconnect'

  // Match the official plugin card layout, CSS variables, spacing, and controls.
  const cardStyle = {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-3)',
    borderRadius: 12,
    listStyle: 'none',
    transition: 'border-color .16s, background .16s',
  }
  const headerStyle = {
    appearance: 'none', width: '100%', font: 'inherit', color: 'inherit', textAlign: 'left',
    cursor: 'pointer', background: '0 0', border: '0', borderRadius: 12,
    alignItems: 'center', gap: 12, padding: '14px 16px', display: 'flex',
  }
  const headTextStyle = { flexDirection: 'column', flex: 1, gap: 4, minWidth: 0, display: 'flex' }
  const nameStyle = { color: 'var(--dsw-alias-label-primary)', fontSize: 15, fontWeight: 600, lineHeight: 1.4 }
  const descriptionStyle = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 13, lineHeight: 1.5 }
  const bodyStyle = { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', paddingBottom: 8 }
  const fieldStyle = { flexDirection: 'column', gap: 6, padding: '12px 0', display: 'flex' }
  const fieldLabelStyle = { minWidth: 0, color: 'var(--dsw-alias-label-primary)', flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.5 }
  const inputStyle = {
    border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)',
    height: 34, font: 'inherit', color: 'var(--dsw-alias-label-primary)', borderRadius: 8,
    padding: '0 12px', fontSize: 13, lineHeight: 1.5,
  }
  const hintStyle = { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: 12, lineHeight: 1.5 }
  const footerStyle = {
    borderTop: '1px solid var(--dsw-alias-border-l2)', display: 'flex',
    justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '12px 0 4px',
  }
  const buttonBase = {
    appearance: 'none', font: 'inherit', cursor: 'pointer', border: '1px solid transparent',
    borderRadius: 8, padding: '5px 14px', fontSize: 13, lineHeight: 1.5,
  }
  const discardStyle = { ...buttonBase, borderColor: 'var(--dsw-alias-border-l2)', color: 'var(--dsw-alias-label-secondary)', background: '0 0' }
  const saveStyle = { ...buttonBase, background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-on-brand, #fff)', borderColor: 'transparent' }
  const failedStyle = { minWidth: 0, color: 'var(--dsw-alias-label-error)', flex: 1, margin: 0, fontSize: 12, lineHeight: 1.5 }
  const pendingStyle = {
    whiteSpace: 'nowrap', background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-secondary)', borderRadius: 999, flex: 'none',
    padding: '1px 8px', fontSize: 11, fontWeight: 500, lineHeight: '17px',
  }

  const e = react.createElement

  // Preset seconds, converted to and from maxDelayMs.
  const PRESET_SECONDS = [1, 2, 5, 10, 30, 60, 120]
  const MAX_SECONDS = 2147483
  const CUSTOM = '__custom__'

  function LabeledField(props) {
    return e('div', { style: fieldStyle },
      e('label', { htmlFor: props.id, style: fieldLabelStyle }, props.label),
      props.children,
      props.hint ? e('p', { style: hintStyle }, props.hint) : null)
  }

  function ReConnectCard(props) {
    const { useScope, scope } = props
    const snapshot = useScope((value) => value)
    const [value, setValue] = useState(null)
    const [open, setOpen] = useState(false)
    const [selectedSeconds, setSelectedSeconds] = useState('60')
    const [customSeconds, setCustomSeconds] = useState('60')
    const [retryQuota, setRetryQuota] = useState(false)
    const [retryUnknown, setRetryUnknown] = useState(true)
    const [unknownMax, setUnknownMax] = useState('3')
    const [dirty, setDirty] = useState(false)
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)

    const presetOf = (seconds) => PRESET_SECONDS.indexOf(seconds) !== -1 ? String(seconds) : CUSTOM

    const applyConfig = (config) => {
      const next = config && typeof config === 'object' ? config : {}
      const seconds = Math.max(1, Math.floor(Number(next.maxDelayMs ?? 60000) / 1000))
      const normalizedUnknownMax = Number.isSafeInteger(next.unknownMaxRetries) && next.unknownMaxRetries >= 0
        ? next.unknownMaxRetries
        : 3
      setValue(next)
      setSelectedSeconds(presetOf(seconds))
      setCustomSeconds(String(seconds))
      setRetryQuota(next.retryQuota === true)
      setRetryUnknown(next.retryUnknown === true)
      setUnknownMax(String(normalizedUnknownMax))
    }

    useEffect(() => {
      if (snapshot.status !== 'ready' || dirty) return
      applyConfig(snapshot.value)
      setFailed(false)
    }, [snapshot.status, snapshot.value, dirty])

    const resolvedSeconds = () => {
      if (selectedSeconds === CUSTOM) {
        const parsed = Number(customSeconds)
        return Number.isFinite(parsed) && parsed > 0
          ? Math.min(MAX_SECONDS, Math.max(1, Math.round(parsed)))
          : 60
      }
      return Number(selectedSeconds)
    }

    const save = async () => {
      setSaving(true)
      setFailed(false)
      try {
        const patch = {
          maxDelayMs: resolvedSeconds() * 1000,
          retryQuota,
          retryUnknown,
          unknownMaxRetries: (() => {
            if (String(unknownMax).trim() === '') return 3
            const parsed = Number(unknownMax)
            return Number.isFinite(parsed) && parsed >= 0
              ? Math.min(Math.round(parsed), 100)
              : 3
          })(),
        }
        for (const [field, fieldValue] of Object.entries(patch)) {
          await scope.set(field, fieldValue)
        }
        const accepted = scope.getSnapshot().value
        if (!accepted || accepted.maxDelayMs !== patch.maxDelayMs
          || accepted.retryQuota !== patch.retryQuota
          || accepted.retryUnknown !== patch.retryUnknown
          || accepted.unknownMaxRetries !== patch.unknownMaxRetries) {
          throw new Error('The Host did not accept these settings')
        }
        applyConfig(accepted)
        setDirty(false)
      } catch (error) {
        console.warn('[ReConnect] config save failed:', error)
        setFailed(true)
      } finally {
        setSaving(false)
      }
    }

    const reset = async () => {
      setSaving(true)
      setFailed(false)
      try {
        for (const field of ['maxDelayMs', 'retryQuota', 'retryUnknown', 'unknownMaxRetries']) {
          await scope.unset(field)
        }
        applyConfig(scope.getSnapshot().value)
        setDirty(false)
      } catch (error) {
        console.warn('[ReConnect] config reset failed:', error)
        setFailed(true)
      } finally {
        setSaving(false)
      }
    }

    const discard = () => {
      if (!value) { setDirty(false); return }
      applyConfig(value)
      setFailed(false)
      setDirty(false)
    }

    if (snapshot.status === 'loading') {
      return e('li', { style: cardStyle }, e('span', { style: hintStyle }, 'Loading settings…'))
    }
    if (snapshot.status !== 'ready') {
      return e('li', { style: cardStyle },
        e('div', { style: headerStyle },
          e('span', { style: headTextStyle },
            e('span', { style: nameStyle }, 'ReConnect automatic retry'),
            e('span', { style: descriptionStyle }, 'Automatically retries failed model requests with exponential backoff.'))),
        e('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', padding: '12px 0 8px' } },
          e('p', { style: failedStyle }, 'Settings are unavailable. Open DSH in a local browser.')))
    }

    const title = 'ReConnect automatic retry'
    const description = 'Automatically retries failed model requests with exponential backoff.'

    return e('li', { style: cardStyle },
      e('button', {
        type: 'button',
        style: headerStyle,
        'aria-expanded': open,
        'aria-label': (open ? 'Collapse' : 'Expand') + ': ' + title,
        onClick: () => setOpen(!open),
      },
        e('span', { style: headTextStyle },
          e('span', { style: nameStyle }, title),
          e('span', { style: descriptionStyle }, description)),
        dirty ? e('span', { style: pendingStyle }, 'Unsaved') : null,
        e('span', { style: { transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .16s', color: 'var(--dsw-alias-label-tertiary)', flex: 'none' } }, '▾')),
      open ? e('div', { style: bodyStyle },
        e(LabeledField, {
          id: 'dsh-reconnect-max-delay',
          label: 'Maximum retry delay',
          hint: 'Exponential backoff runs 1s → 2s → 4s … and stays at this limit. Provider Retry-After takes precedence.',
        },
          e('div', { style: fieldStyle },
            e('select', {
              id: 'dsh-reconnect-max-delay',
              style: { ...inputStyle, width: '100%', appearance: 'auto' },
              value: selectedSeconds,
              disabled: saving || !snapshot.writable,
              onChange: (event) => {
                if (event.target.value === CUSTOM) setCustomSeconds(String(resolvedSeconds()))
                setSelectedSeconds(event.target.value)
                setDirty(true)
                setFailed(false)
              },
            },
              PRESET_SECONDS.map((seconds) => e('option', { key: seconds, value: String(seconds) }, `${seconds} seconds`)),
              e('option', { key: CUSTOM, value: CUSTOM }, 'Custom…')),
            selectedSeconds === CUSTOM ? e('input', {
              type: 'number',
              inputMode: 'numeric',
              min: 1,
              max: MAX_SECONDS,
              step: 1,
              style: { ...inputStyle, width: '100%', marginTop: 8 },
              value: customSeconds,
              disabled: saving || !snapshot.writable,
              onChange: (event) => {
                setCustomSeconds(event.target.value)
                setDirty(true)
                setFailed(false)
              },
            }) : null)),
        e(LabeledField, {
          id: 'dsh-reconnect-retry-quota',
          label: 'Retry quota errors',
          hint: 'Disabled by default. When enabled, QUOTA errors such as exhausted balance are retried indefinitely.',
        },
          e('input', {
            id: 'dsh-reconnect-retry-quota',
            type: 'checkbox',
            checked: retryQuota,
            disabled: saving || !snapshot.writable,
            onChange: () => {
              setRetryQuota(!retryQuota)
              setDirty(true)
              setFailed(false)
            },
          })),
        e(LabeledField, {
          id: 'dsh-reconnect-retry-unknown',
          label: 'Retry unknown errors indefinitely',
          hint: 'Enabled by default. Unknown errors such as PI_AI_ERROR keep retrying. Disable it to use the limit below. Missing or unconfigured models always wait for configuration recovery.',
        },
          e('input', {
            id: 'dsh-reconnect-retry-unknown',
            type: 'checkbox',
            checked: retryUnknown,
            disabled: saving || !snapshot.writable,
            onChange: () => {
              setRetryUnknown(!retryUnknown)
              setDirty(true)
              setFailed(false)
            },
          })),
        e(LabeledField, {
          id: 'dsh-reconnect-unknown-max',
          label: 'Maximum unknown-error retries',
          hint: 'Used only when indefinite unknown-error retries are disabled. Default: 3.',
        },
          e('input', {
            id: 'dsh-reconnect-unknown-max',
            type: 'number',
            inputMode: 'numeric',
            min: 0,
            max: 100,
            step: 1,
            style: inputStyle,
            value: unknownMax,
            disabled: saving || !snapshot.writable,
            onChange: (event) => {
              setUnknownMax(event.target.value)
              setDirty(true)
              setFailed(false)
            },
          })),
        e('div', { style: footerStyle },
          failed ? e('p', { style: failedStyle, role: 'status' }, 'The operation failed. Your current input has been preserved.') : null,
          e('button', { type: 'button', style: discardStyle, disabled: saving || !snapshot.writable, onClick: () => { void reset() } }, 'Restore defaults'),
          e('button', { type: 'button', style: discardStyle, disabled: !dirty || saving, onClick: discard }, 'Discard changes'),
          e('button', { type: 'button', style: saveStyle, disabled: !dirty || saving || !snapshot.writable, onClick: () => { void save() } }, saving ? 'Saving…' : 'Save')))
      : null)
  }

  function apply(ctx) {
    const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE })
    const useScope = bindSnapshotSelector(scope)
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
      name: 'settings.plugin.item',
      key: SETTINGS_NAMESPACE,
      inject: () => ({ useScope, scope }),
    }, ReConnectCard), 'dsh-reconnect: plugin settings card')
  }

  const inject = ['slots', 'settingsScope']
  exports.apply = apply
  exports.inject = inject
  return module.exports
} })
