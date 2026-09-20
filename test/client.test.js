import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const nativeConsoleWarn = console.warn;

before(() => {
  console.warn = () => {};
});

after(() => {
  console.warn = nativeConsoleWarn;
});

afterEach(() => {
  delete globalThis.window;
});

function createReactHarness() {
  const states = [];
  let cursor = 0;
  const react = {
    createElement(type, props, ...children) {
      return { type, props: { ...props, children } };
    },
    useEffect(callback) {
      callback();
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], (value) => {
        states[index] = typeof value === "function" ? value(states[index]) : value;
      }];
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      subscribe(() => {});
      return getSnapshot();
    },
  };
  return {
    react,
    render(Component, props) {
      cursor = 0;
      return Component(props);
    },
  };
}

function findNode(node, predicate) {
  if (!node) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node !== "object") return undefined;
  if (predicate(node)) return node;
  return findNode(node.props?.children, predicate);
}

async function flushAsyncHandlers() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("ReConnect client settings card", () => {
  it("registers on the Host plugin settings page and binds the dsh-reconnect namespace", async () => {
    let clientPlugin;
    globalThis.window = {
      __ModuleLoader__: {
        load({ factory }) {
          const module = { exports: {} };
          clientPlugin = factory(() => ({}), module, module.exports);
        },
      },
    };

    await import(`../src/client.js?test=${Date.now()}`);

    let registeredOptions;
    const ctx = {
      slots: {
        inject(name, register) {
          assert.equal(name, "settings.plugin.item");
          register();
        },
        register(options) {
          if (options.name === "settings.plugin.item" && !options.key) {
            throw new Error('keyed slot "settings.plugin.item" requires options.key');
          }
          registeredOptions = options;
        },
      },
      settingsScope: {
        bind(options) {
          assert.deepEqual(options, { namespace: "dsh-reconnect" });
          return { getSnapshot() {}, set() {}, unset() {} };
        },
      },
    };

    clientPlugin.apply(ctx);
    assert.deepEqual({
      name: "settings.plugin.item",
      key: "dsh-reconnect",
    }, {
      name: registeredOptions.name,
      key: registeredOptions.key,
    });
    assert.equal(typeof registeredOptions.inject, "function");
    assert.deepEqual(clientPlugin.inject, ["slots", "settingsScope"]);
  });

  it("saves only edited fields in one revision-fenced mutation", async () => {
    const hooks = createReactHarness();
    let clientPlugin;
    globalThis.window = {
      __ModuleLoader__: {
        load({ factory }) {
          const module = { exports: {} };
          clientPlugin = factory((id) => id === "react" ? hooks.react : {}, module, module.exports);
        },
      },
    };
    await import(`../src/client.js?test=atomic-${Date.now()}`);

    let snapshot = {
      status: "ready",
      value: { maxDelayMs: 60000, retryQuota: false, retryUnknown: true, unknownMaxRetries: 3 },
      revision: 7,
      writable: true,
    };
    const mutations = [];
    const scope = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      async mutate(ops, revision) {
        mutations.push({ ops, revision });
        const value = { ...snapshot.value };
        for (const operation of ops) value[operation.path[0]] = operation.value;
        snapshot = { ...snapshot, value, revision: snapshot.revision + 1 };
      },
    };
    let registeredComponent;
    let registeredOptions;
    const ctx = {
      slots: {
        inject(name, register) {
          assert.equal(name, "settings.plugin.item");
          register();
        },
        register(options, component) {
          registeredOptions = options;
          registeredComponent = component;
        },
      },
      settingsScope: { bind: () => scope },
    };
    clientPlugin.apply(ctx);
    const props = registeredOptions.inject();

    hooks.render(registeredComponent, props);
    let tree = hooks.render(registeredComponent, props);
    findNode(tree, (node) => node.type === "button" && node.props["aria-expanded"] === false).props.onClick();
    tree = hooks.render(registeredComponent, props);
    findNode(tree, (node) => node.type === "input" && node.props?.id === "dsh-reconnect-retry-quota").props.onChange();
    tree = hooks.render(registeredComponent, props);
    findNode(tree, (node) => node.type === "button" && node.props.children.includes("Save")).props.onClick();
    await flushAsyncHandlers();

    assert.deepEqual(mutations, [{
      revision: 7,
      ops: [{ op: "set", path: ["retryQuota"], value: true }],
    }]);
  });

  it("refuses to overwrite settings changed after editing began", async () => {
    const hooks = createReactHarness();
    let clientPlugin;
    globalThis.window = {
      __ModuleLoader__: {
        load({ factory }) {
          const module = { exports: {} };
          clientPlugin = factory((id) => id === "react" ? hooks.react : {}, module, module.exports);
        },
      },
    };
    await import(`../src/client.js?test=conflict-${Date.now()}`);

    let snapshot = {
      status: "ready",
      value: { maxDelayMs: 60000, retryQuota: false, retryUnknown: true, unknownMaxRetries: 3 },
      revision: 10,
      writable: true,
    };
    let mutationCount = 0;
    const scope = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      async mutate() { mutationCount += 1; },
    };
    let registeredComponent;
    let registeredOptions;
    const ctx = {
      slots: {
        inject(_name, register) { register(); },
        register(options, component) {
          registeredOptions = options;
          registeredComponent = component;
        },
      },
      settingsScope: { bind: () => scope },
    };
    clientPlugin.apply(ctx);
    const props = registeredOptions.inject();

    hooks.render(registeredComponent, props);
    let tree = hooks.render(registeredComponent, props);
    findNode(tree, (node) => node.type === "button" && node.props["aria-expanded"] === false).props.onClick();
    tree = hooks.render(registeredComponent, props);
    findNode(tree, (node) => node.type === "input" && node.props?.id === "dsh-reconnect-retry-quota").props.onChange();
    snapshot = { ...snapshot, revision: 11 };
    tree = hooks.render(registeredComponent, props);
    findNode(tree, (node) => node.type === "button" && node.props.children.includes("Save")).props.onClick();
    await flushAsyncHandlers();

    assert.equal(mutationCount, 0);
  });
});
