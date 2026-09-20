import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { apply, Config } from "../src/index.js";

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeConsoleLog = console.log;
const nativeConsoleWarn = console.warn;
let timerId = 0;
const pendingTimers = new Map();

before(() => {
  globalThis.setTimeout = (callback) => {
    const id = ++timerId;
    pendingTimers.set(id, callback);
    queueMicrotask(() => {
      const pending = pendingTimers.get(id);
      if (!pending) return;
      pendingTimers.delete(id);
      pending();
    });
    return id;
  };
  globalThis.clearTimeout = (id) => pendingTimers.delete(id);
  console.log = () => {};
  console.warn = () => {};
});

after(() => {
  globalThis.setTimeout = nativeSetTimeout;
  globalThis.clearTimeout = nativeClearTimeout;
  console.log = nativeConsoleLog;
  console.warn = nativeConsoleWarn;
});

function createHarness(config = {}) {
  const listeners = new Map();
  let cleanup;
  const currentConfig = {
    maxDelayMs: 1000,
    retryQuota: false,
    retryUnknown: true,
    unknownMaxRetries: 3,
    ...config,
  };
  const watchers = new Set();
  const settingsScope = {
    get: () => ({ ...currentConfig }),
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    set(field, value) {
      currentConfig[field] = value;
      for (const listener of watchers) listener();
      return Promise.resolve();
    },
  };
  const ctx = {
    settings: {
      register(namespace, schema, options) {
        assert.equal(namespace.key || namespace, "dsh-reconnect");
        assert.ok(schema);
        assert.ok(options);
        return settingsScope;
      },
    },
    on(event, listener) {
      listeners.set(event, listener);
      return () => listeners.delete(event);
    },
    effect(factory) {
      cleanup = factory();
    },
  };
  apply(ctx, config);
  const session = {
    events: [],
    append(type, data) {
      this.events.push({ type, data });
    },
  };
  const agent = { session };
  const signal = new AbortController();
  const requestError = (failure, extra = {}) => listeners.get("agent/request-error")({
    agent,
    turn: 1,
    step: 1,
    provider: "fixture",
    failure,
    signal: extra.signal || signal.signal,
    retryPolicy: extra.retryPolicy,
  }, () => ({ kind: "next" }));
  return {
    agent,
    session,
    settings: settingsScope,
    signal,
    requestError,
    async dispose() {
      await cleanup?.();
    },
  };
}

function failure(code, providerRetryAfterMs = 1, message = "fixture failure") {
  return {
    code,
    message,
    ...(providerRetryAfterMs > 0 ? { providerRetryAfterMs } : {}),
  };
}

describe("ReConnect retry policy", () => {
  it("enables indefinite unknown-error retries by default", () => {
    assert.deepEqual(Config({}), {
      maxDelayMs: 60000,
      retryQuota: false,
      retryUnknown: true,
      unknownMaxRetries: 3,
    });
  });

  it("retries transient errors and recovers its counter from durable events", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    const first = await harness.requestError(failure("SERVER"));
    assert.deepEqual(first, { kind: "retry" });
    const second = await harness.requestError(failure("RATE_LIMIT"));
    assert.deepEqual(second, { kind: "retry" });
    const third = await harness.requestError(failure("STREAM_CLOSED"));
    assert.deepEqual(third, { kind: "retry" });

    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3]);
    assert.equal(retries[0].data.policyKey, "reconnect-transient-v3");
    assert.equal(retries[0].data.retryId, retries[1].data.retryId);
    assert.equal(retries[1].data.retryId, retries[2].data.retryId);
    await harness.dispose();
  });

  it("retries unknown errors indefinitely by default", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    for (let retry = 1; retry <= 4; retry += 1) {
      assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    }

    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3, 4]);
    assert.equal(retries[0].data.mode, "always");
    assert.equal(Object.hasOwn(retries[0].data, "maxRetries"), false);
    await harness.dispose();
  });

  it("applies the finite limit only when indefinite unknown retries are disabled", async () => {
    const harness = createHarness({ maxDelayMs: 1000, retryUnknown: false });

    for (let retry = 1; retry <= 3; retry += 1) {
      assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    }
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "next" });

    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3]);
    assert.equal(retries[0].data.mode, "normal");
    assert.equal(retries[0].data.maxRetries, 3);
    await harness.dispose();
  });

  it("does not let a Provider normal allowlist block the default unknown policy", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR"), {
      retryPolicy: { mode: "normal", retryableCodes: ["SERVER"] },
    }), { kind: "retry" });
    assert.equal(harness.session.events[0].data.mode, "always");
    await harness.dispose();
  });

  it("counts only consecutive unknown failures and resets after a transient error", async () => {
    const harness = createHarness({ maxDelayMs: 1000, retryUnknown: false });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("SERVER")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 1, 1]);
    assert.equal(retries[0].data.policyKey, retries[1].data.policyKey);
    assert.notEqual(retries[0].data.policyKey, retries[3].data.policyKey);
    assert.notEqual(retries[0].data.retryId, retries[3].data.retryId);
    await harness.dispose();
  });

  it("starts a fresh bounded chain after a legacy or indefinite unknown policy", async () => {
    for (const policyKey of ["reconnect-unknown-normal-v3", "reconnect-unknown-always-v3"]) {
      const harness = createHarness({ maxDelayMs: 1000, retryUnknown: false });
      harness.session.append("llm/retry", {
        retryId: "old-chain",
        turn: 1,
        step: 1,
        provider: "fixture",
        mode: policyKey.includes("always") ? "always" : "normal",
        maxRetries: 3,
        policyKey,
        retry: 3,
        delayMs: 1,
        failure: failure("PI_AI_ERROR"),
      });

      assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
      const current = harness.session.events.filter((event) => event.type === "llm/retry").at(-1).data;
      assert.equal(current.retry, 1);
      assert.equal(current.mode, "normal");
      assert.equal(current.maxRetries, 3);
      assert.notEqual(current.retryId, "old-chain");
      assert.match(current.policyKey, /^reconnect-unknown-normal-v4:/);
      await harness.dispose();
    }
  });

  it("uses the indefinite policy for model availability codes and messages", async () => {
    const cases = [
      failure("MODEL_NOT_FOUND", 1),
      failure("model_not_found", 1),
      failure("MODEL_NOT_CONFIGURED", 1),
      failure("UNKNOWN_MODEL", 1),
      failure(
        "PI_AI_ERROR",
        1,
        'OpenAI API error (404): {"message":"Model \\"gpt-5.6-luna\\" is not supported by any configured account in this group","type":"model_not_found"}',
      ),
      failure("PI_AI_ERROR", 1, 'provider response type=model_not_configured for model "gpt-5.6-luna"'),
      failure("pi_ai_error", 1, 'model "gpt-5.6-luna" is not configured for this account'),
      failure("PI_AI_ERROR", 1, 'model "gpt-5.6-luna" is not configured for this account'),
      failure("PI_AI_ERROR", 1, "no model configured for this account"),
    ];

    for (const modelFailure of cases) {
      const harness = createHarness({ maxDelayMs: 1000 });
      for (let retry = 1; retry <= 4; retry += 1) {
        assert.deepEqual(await harness.requestError(modelFailure), { kind: "retry" });
      }
      const retries = harness.session.events.filter((event) => event.type === "llm/retry");
      assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3, 4]);
      assert.equal(new Set(retries.map((event) => event.data.mode)).size, 1);
      assert.equal(retries[0].data.mode, "always");
      assert.equal(retries[0].data.policyKey, "reconnect-model-availability-v4");
      assert.equal(retries[0].data.retryId, retries[3].data.retryId);
      assert.equal(Object.hasOwn(retries[0].data, "maxRetries"), false);
      await harness.dispose();
    }
  });

  it("keeps handling model availability under a Provider always policy", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });
    const retryPolicy = { mode: "always", retryableCodes: ["PI_AI_ERROR"] };
    const modelFailure = failure(
      "PI_AI_ERROR",
      1,
      'OpenAI API error (404): {"message":"model is not configured","type":"model_not_found"}',
    );

    for (let retry = 1; retry <= 4; retry += 1) {
      assert.deepEqual(await harness.requestError(modelFailure, { retryPolicy }), { kind: "retry" });
    }
    const retries = harness.session.events.filter((event) => event.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.retry), [1, 2, 3, 4]);
    assert.equal(retries[0].data.mode, "always");
    assert.equal(retries[0].data.policyKey, "reconnect-model-availability-v4");
    await harness.dispose();
  });

  it("does not create a retry event when unknownMaxRetries is zero", async () => {
    const harness = createHarness({ retryUnknown: false, unknownMaxRetries: 0 });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "next" });
    assert.equal(harness.session.events.length, 0);
    await harness.dispose();
  });

  it("does not retry permanent errors or quota errors by default", async () => {
    const harness = createHarness();

    for (const code of [
      "AUTH",
      "auth",
      "INVALID_REPLAY_STATE",
      "UNSUPPORTED_OPTION",
      "UNSUPPORTED_REASONING_EFFORT",
    ]) {
      assert.deepEqual(await harness.requestError(failure(code)), { kind: "next" });
    }
    assert.deepEqual(await harness.requestError(failure("QUOTA")), { kind: "next" });
    assert.deepEqual(await harness.requestError(failure("quota")), { kind: "next" });
    assert.equal(harness.session.events.length, 0);
    await harness.dispose();
  });

  it("uses the indefinite policy when quota retry is enabled", async () => {
    const harness = createHarness({ retryQuota: true, maxDelayMs: 1000 });

    assert.deepEqual(await harness.requestError(failure("QUOTA")), { kind: "retry" });
    const event = harness.session.events.find((item) => item.type === "llm/retry");
    assert.equal(event.data.mode, "always");
    assert.equal(event.data.policyKey, "reconnect-quota-v3");
    await harness.dispose();
  });

  it("normalizes transient error codes before choosing a retry policy", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    assert.deepEqual(await harness.requestError(failure(" server ")), { kind: "retry" });
    const event = harness.session.events.find((item) => item.type === "llm/retry");
    assert.equal(event.data.failure.code, "SERVER");
    assert.equal(event.data.policyKey, "reconnect-transient-v3");
    await harness.dispose();
  });

  it("honors Provider Retry-After without applying the local backoff cap", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });
    const pending = harness.requestError(failure("SERVER", 120000));
    const event = harness.session.events.find((item) => item.type === "llm/retry");
    assert.equal(event.data.delayMs, 120000);
    harness.signal.abort();
    assert.deepEqual(await pending, { kind: "next" });
    await harness.dispose();
  });

  it("does not let a short Provider Retry-After reduce the local backoff", async () => {
    const harness = createHarness({ maxDelayMs: 5000 });

    assert.deepEqual(await harness.requestError(failure("SERVER", 1)), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("SERVER", 500)), { kind: "retry" });
    const retries = harness.session.events.filter((item) => item.type === "llm/retry");
    assert.deepEqual(retries.map((event) => event.data.delayMs), [1000, 2000]);
    await harness.dispose();
  });

  it("handles recovery delegated by a Provider always policy", async () => {
    const harness = createHarness({ retryUnknown: true });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR"), {
      retryPolicy: { mode: "always", retryableCodes: ["PI_AI_ERROR"] },
    }), { kind: "retry" });
    assert.equal(harness.session.events[0].data.mode, "always");
    await harness.dispose();
  });

  it("does not misclassify a SERVER model failure because its text mentions a tool", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });

    assert.deepEqual(await harness.requestError(failure("SERVER", 0, "tool call gateway returned 502")), { kind: "retry" });
    assert.equal(harness.session.events[0].data.failure.code, "SERVER");
    await harness.dispose();
  });

  it("cancels backoff during disposal without leaving a pending promise", async () => {
    const harness = createHarness({ maxDelayMs: 1000 });
    const pending = harness.requestError(failure("SERVER", 2147483647));

    await harness.dispose();
    assert.deepEqual(await pending, { kind: "next" });
  });

  it("applies settings updates to the unknown-error policy immediately", async () => {
    const harness = createHarness({ maxDelayMs: 1000, retryUnknown: false, unknownMaxRetries: 1 });

    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "next" });
    await harness.settings.set("retryUnknown", true);
    assert.deepEqual(await harness.requestError(failure("PI_AI_ERROR")), { kind: "retry" });
    await harness.dispose();
  });
});
