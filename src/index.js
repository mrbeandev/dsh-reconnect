import z from "@deepseek-ai/schemastery";

/**
 * ReConnect — automatic recovery for failed model requests (Host half).
 *
 * Handles only model failures delivered through agent/request-error. Tool
 * execution results belong to tool/result and stay outside this retry boundary.
 * Settings decide whether unknown model errors are bounded (unbounded by
 * default); missing or unconfigured models are retried while configuration
 * recovers.
 */
export const name = "reconnect";
export const SETTINGS_NAMESPACE = "dsh-reconnect";
// DSH 0.1.5-rc.2 validates namespace strings inside ctx.settings.register().
// Newer DSH builds expose settingsNamespace(); using the literal keeps this
// plugin compatible with the installed release without changing semantics.
const NS = SETTINGS_NAMESPACE;
export const inject = ["settings"];

const DEFAULTS = Object.freeze({
  maxDelayMs: 60000,
  retryQuota: false,
  retryUnknown: true,
  unknownMaxRetries: 3,
});

export const Config = z.object({
  maxDelayMs: z.number().step(1).min(1000).max(2147483647).default(DEFAULTS.maxDelayMs),
  retryQuota: z.boolean().default(DEFAULTS.retryQuota),
  retryUnknown: z.boolean().default(DEFAULTS.retryUnknown),
  unknownMaxRetries: z.number().step(1).min(0).max(100).default(DEFAULTS.unknownMaxRetries),
});

// Transient errors exposed by DSH; STREAM_CLOSED covers abnormal stream endings.
const TRANSIENT_CODES = new Set([
  "EMPTY_RESPONSE",
  "RATE_LIMIT",
  "SERVER",
  "STREAM_CLOSED",
  "TIMEOUT",
  "TRANSPORT",
]);

// Permanent request or execution-environment failures that retries cannot fix.
const PERMANENT_CODES = new Set([
  "ABORTED",
  "ABORTED_BEFORE_DISPATCH",
  "AUTH",
  "CONTEXT_WINDOW_EXCEEDED",
  "INVALID_ARGS",
  "INVALID_CREDENTIAL",
  "INVALID_REQUEST",
  "INVALID_REPLAY_STATE",
  "MISSING_CREDENTIAL",
  "NO_ADAPTER",
  "NO_TOOL",
  "UNKNOWN_TOOL",
  "UNSUPPORTED_CONTENT",
  "UNSUPPORTED_OPTION",
  "UNSUPPORTED_REASONING_EFFORT",
]);

const TOOL_ERROR_CODES = new Set([
  "TOOL_ERROR",
  "TOOL_OUTPUT_ERROR",
  "TOOL_EXECUTION_ERROR",
  "TOOL_CALL_ERROR",
]);

// Missing or unconfigured models retry indefinitely while configuration recovers.
const MODEL_AVAILABILITY_CODES = new Set([
  "MODEL_NOT_FOUND",
  "MODEL_NOT_EXIST",
  "MODEL_NOT_EXISTS",
  "MODEL_NOT_CONFIGURED",
  "MODEL_NOT_AVAILABLE",
  "MODEL_UNAVAILABLE",
  "NO_MODEL",
  "UNKNOWN_MODEL",
]);

// pi-ai reduces some 404 model-routing failures to PI_AI_ERROR. Match only
// stable provider phrases instead of treating every PI_AI_ERROR as availability.
const MODEL_AVAILABILITY_MESSAGE_PATTERNS = [
  /\bmodel[_ -]?not[_ -]?found\b/i,
  /\bmodel[_ -]?not[_ -]?(?:configured|available|exist(?:s)?)\b/i,
  /\bmodel\b[^\r\n]{0,120}\b(?:not found|not available|unavailable)\b/i,
  /\bunknown model\b/i,
  /\bno configured model\b/i,
  /\bno model(?: is)? configured\b/i,
  /\bno such model\b/i,
  /\bmodel\b[^\r\n]{0,120}\b(?:does not exist|doesn't exist|is not supported by any configured account|is not configured|isn't configured|not configured)\b/i,
  /(?:\u6a21\u578b\u4e0d\u5b58\u5728|\u6a21\u578b\u672a\u914d\u7f6e|\u672a\u914d\u7f6e\u6a21\u578b)/i,
];

function normalizeConfig(value = {}) {
  const maxDelayMs = Number.isSafeInteger(value.maxDelayMs) && value.maxDelayMs >= 1000
    ? Math.min(value.maxDelayMs, 2147483647)
    : DEFAULTS.maxDelayMs;
  const unknownMaxRetries = Number.isSafeInteger(value.unknownMaxRetries) && value.unknownMaxRetries >= 0
    ? Math.min(value.unknownMaxRetries, 100)
    : DEFAULTS.unknownMaxRetries;
  return {
    maxDelayMs,
    retryQuota: value.retryQuota === undefined ? DEFAULTS.retryQuota : value.retryQuota === true,
    retryUnknown: value.retryUnknown === undefined ? DEFAULTS.retryUnknown : value.retryUnknown === true,
    unknownMaxRetries,
  };
}

function messageOf(failure) {
  return failure && typeof failure.message === "string" ? failure.message : "";
}

function isModelAvailabilityFailure(failure, code) {
  if (typeof code === "string" && MODEL_AVAILABILITY_CODES.has(code.toUpperCase())) return true;
  if (typeof code !== "string" || code.toUpperCase() !== "PI_AI_ERROR") return false;
  return MODEL_AVAILABILITY_MESSAGE_PATTERNS.some((pattern) => pattern.test(messageOf(failure)));
}

function isPermanentFailure(failure, code) {
  if (isModelAvailabilityFailure(failure, code)) return false;
  return PERMANENT_CODES.has(code) || TOOL_ERROR_CODES.has(code);
}

function copyFailure(failure, code) {
  const snapshot = {
    code,
    message: messageOf(failure) || code,
  };
  if (failure && Number.isInteger(failure.status) && failure.status >= 100 && failure.status <= 599) {
    snapshot.status = failure.status;
  }
  if (failure && typeof failure.providerRetryAfterMs === "number"
    && Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) {
    snapshot.providerRetryAfterMs = failure.providerRetryAfterMs;
  }
  if (failure && typeof failure.requestId === "string" && failure.requestId.length > 0) {
    snapshot.requestId = failure.requestId;
  }
  return snapshot;
}

/** Recover the latest retry in this policy chain from durable session events. */
function previousRetry(session, turn, step, provider, policyKey) {
  const events = session && session.events;
  if (!events || typeof events.length !== "number") return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = event && event.type === "llm/retry" ? event.data : undefined;
    if (data && data.turn === turn && data.step === step && data.provider === provider
      && data.policyKey === policyKey) {
      return data;
    }
  }
  return undefined;
}

function previousPluginRetryInScope(session, turn, step, provider) {
  const events = session && session.events;
  if (!events || typeof events.length !== "number") return undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const data = event && event.type === "llm/retry" ? event.data : undefined;
    if (!sameRetryScope(data, turn, step, provider)) continue;
    return isPluginRetryData(data, turn, step, provider) ? data : undefined;
  }
  return undefined;
}

function sameRetryScope(data, turn, step, provider) {
  return data && data.turn === turn && data.step === step && data.provider === provider;
}

function isPluginRetryData(data, turn, step, provider) {
  return sameRetryScope(data, turn, step, provider)
    && typeof data.policyKey === "string" && data.policyKey.startsWith("reconnect-");
}

function isBoundedUnknownFailure(failure, code) {
  return typeof code === "string"
    && !TRANSIENT_CODES.has(code)
    && code !== "QUOTA"
    && !isModelAvailabilityFailure(failure, code);
}

/** Count the final consecutive unknown-error segment in one model step. */
function previousUnknownStreak(session, turn, step, provider) {
  const events = session && session.events;
  if (!events || typeof events.length !== "number") return 0;
  let streak = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "llm/retry") continue;
    const data = event.data;
    if (!sameRetryScope(data, turn, step, provider)) continue;
    if (!isPluginRetryData(data, turn, step, provider)) break;
    if (typeof data.policyKey !== "string" || !data.policyKey.startsWith("reconnect-unknown-normal-v4:")) break;
    const code = data.failure && typeof data.failure.code === "string" ? data.failure.code : "UNKNOWN";
    if (!isBoundedUnknownFailure(data.failure, code)) break;
    streak += 1;
  }
  return streak;
}

/** Return the policy for an error category; bounded unknown keys are per segment. */
function retryPolicyFor(code, retryUnknown, failure) {
  if (isModelAvailabilityFailure(failure, code)) {
    return { key: "reconnect-model-availability-v4", mode: "always" };
  }
  if (code === "QUOTA") {
    return { key: "reconnect-quota-v3", mode: "always" };
  }
  if (TRANSIENT_CODES.has(code)) {
    return { key: "reconnect-transient-v3", mode: "always" };
  }
  return retryUnknown
    ? { key: "reconnect-unknown-always-v3", mode: "always" }
    : { key: "reconnect-unknown-normal-v3", mode: "normal" };
}

function backoffDelay(retry, maxDelayMs) {
  const exponent = Math.min(Math.max(retry - 1, 0), 31);
  return Math.min(maxDelayMs, 1000 * (2 ** exponent));
}

function providerRetryAfter(failure) {
  if (!failure || typeof failure.providerRetryAfterMs !== "number"
    || !Number.isFinite(failure.providerRetryAfterMs) || failure.providerRetryAfterMs <= 0) {
    return undefined;
  }
  return Math.min(Math.ceil(failure.providerRetryAfterMs), 2147483647);
}

/** Create a backoff wait controlled by both the turn and plugin lifecycle. */
function waitForRetry(delayMs, signals) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      for (const signal of signals) signal?.removeEventListener?.("abort", finish);
      resolve();
    };
    if (signals.some((signal) => signal?.aborted)) {
      finish();
      return;
    }
    for (const signal of signals) signal?.addEventListener?.("abort", finish, { once: true });
    timer = setTimeout(finish, delayMs);
  });
}

/** Install the Host retry listener and register the plugin settings. */
export function apply(ctx, config = {}) {
  let live = normalizeConfig(config);
  let unwatchSettings;
  try {
    // Cordis supplies defaults; the settings service persists user overrides.
    const scope = ctx.settings.register(NS, Config, { base: config || {} });
    live = normalizeConfig(scope.get());
    unwatchSettings = scope.watch(() => {
      live = normalizeConfig(scope.get());
    });
  } catch (error) {
    console.warn(`[ReConnect] settings namespace unavailable, using composition config: ${error?.message || error}`);
  }
  const lifetime = new AbortController();
  const active = new Set();
  let alive = true;

  function nextRetryId() {
    return `reconnect-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function track(operation) {
    active.add(operation);
    const remove = () => active.delete(operation);
    operation.then(remove, remove);
    return operation;
  }

  ctx.effect(() => {
    const disposers = [];

    const handleRequestError = async (payload, next) => {
      const { agent, turn, step, provider, failure, signal } = payload;
      const code = failure && typeof failure.code === "string" ? failure.code : "UNKNOWN";
      const message = messageOf(failure);

      if (!alive || signal?.aborted) return next();
      // The built-in always policy delegates recovery to downstream waterfall
      // listeners. This plugin handles those recoverable failures here.
      if (isPermanentFailure(failure, code)) return next();
      if (code === "QUOTA" && !live.retryQuota) return next();

      const unknown = isBoundedUnknownFailure(failure, code);
      const policy = retryPolicyFor(code, live.retryUnknown, failure);
      const prior = previousRetry(agent.session, turn, step, provider, policy.key);
      const unknownStreak = unknown ? previousUnknownStreak(agent.session, turn, step, provider) : 0;
      if (unknown && !live.retryUnknown && unknownStreak >= live.unknownMaxRetries) {
        console.warn(`[ReConnect] ${provider} ${code} reached the unknown-error retry limit (${live.unknownMaxRetries}); stopping this chain${message ? `: ${message.slice(0, 160)}` : ""}`);
        return next();
      }
      let retryPolicyForRequest = policy;
      let retryPrior = prior;
      if (unknown && !live.retryUnknown) {
        const last = previousPluginRetryInScope(agent.session, turn, step, provider);
        const lastCode = last?.failure && typeof last.failure.code === "string"
          ? last.failure.code
          : "UNKNOWN";
        const sameBoundedSegment = Boolean(last)
          && isBoundedUnknownFailure(last.failure, lastCode)
          && typeof last.policyKey === "string"
          && last.policyKey.startsWith("reconnect-unknown-normal-v4:");
        // A bounded unknown chain continues only the latest consecutive unknown
        // segment. Any intervening policy starts a fresh 1/N chain.
        if (sameBoundedSegment) {
          retryPolicyForRequest = { ...policy, key: last.policyKey };
          retryPrior = last;
        } else {
          retryPolicyForRequest = { ...policy, key: `reconnect-unknown-normal-v4:${nextRetryId()}` };
          retryPrior = undefined;
        }
      }
      const retryPreviousCount = retryPrior && Number.isSafeInteger(retryPrior.retry) && retryPrior.retry >= 0
        ? retryPrior.retry
        : 0;
      const retry = retryPreviousCount >= Number.MAX_SAFE_INTEGER ? retryPreviousCount : retryPreviousCount + 1;
      const retryId = retryPrior && typeof retryPrior.retryId === "string" && retryPrior.retryId.length > 0
        ? retryPrior.retryId
        : nextRetryId();
      const maxDelayMs = live.maxDelayMs;
      const waitMs = providerRetryAfter(failure) ?? backoffDelay(retry, maxDelayMs);
      const retryMode = retryPolicyForRequest.mode;

      agent.session.append("llm/retry", {
        retryId,
        turn,
        step,
        provider,
        mode: retryMode,
        ...(retryMode === "normal" ? { maxRetries: live.unknownMaxRetries } : {}),
        policyKey: retryPolicyForRequest.key,
        retry,
        delayMs: waitMs,
        failure: copyFailure(failure, code),
      });
      console.log(`[ReConnect] ${provider} ${code} failure #${retry}; retrying in ${waitMs}ms (turn ${turn} step ${step}, maxDelayMs=${maxDelayMs})`);

      await waitForRetry(waitMs, [signal, lifetime.signal]);

      if (!alive || signal?.aborted || lifetime.signal.aborted) return next();
      agent.session.append("llm/retry-started", {
        retryId,
        turn,
        step,
        retry,
      });
      return { kind: "retry" };
    };

    disposers.push(ctx.on("agent/request-error", (payload, next) => {
      return track(Promise.resolve(handleRequestError(payload, next)));
    }));

    return () => {
      alive = false;
      lifetime.abort();
      try { unwatchSettings?.(); } catch {}
      for (const dispose of disposers) {
        try { dispose(); } catch {}
      }
      return Promise.allSettled([...active]);
    };
  }, "reconnect: safe model-request recovery");
}
