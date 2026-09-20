# dsh-reconnect

Safe model-request retry for DeepSeek Harness with exponential backoff,
relay/proxy recovery, and an integrated settings panel.

## Overview

`dsh-reconnect` retries recoverable model requests so temporary network,
gateway, or provider failures do not interrupt an agent turn or long-running
task.

The plugin listens to DSH's `agent/request-error` waterfall. After the built-in
`normal` Provider retry policy is exhausted, or when an `always` policy
delegates recovery downstream, ReConnect resubmits the same model request using
its own policy.

## Retry policy

| Condition | Behavior |
| --- | --- |
| `EMPTY_RESPONSE`, `RATE_LIMIT`, `SERVER`, `STREAM_CLOSED`, `TIMEOUT`, `TRANSPORT` | Retry indefinitely |
| Missing or unconfigured model | Retry indefinitely while configuration recovers |
| `QUOTA` | Do not retry by default; enable with `retryQuota` |
| Unknown errors such as `PI_AI_ERROR` | Retry indefinitely by default; disable `retryUnknown` to apply a limit |
| Tool, argument, authentication, credential, context-overflow, and aborted errors | Do not retry |

Tool execution failures in `tool/result` are outside this plugin's retry
boundary. ReConnect uses the machine-readable failure code from
`agent/request-error`; it does not infer model failures from arbitrary tool
output.

## Backoff and cancellation

- Exponential backoff: `1s → 2s → 4s → …`, capped at `60s` by default
- Honors positive Provider `Retry-After` values as an uncapped minimum wait
- Emits standard `llm/retry` and `llm/retry-started` session events
- Shows retry count and countdown in the Harness conversation UI
- Stops immediately when the turn aborts or the plugin unloads
- Drains pending waits safely during hot reload and shutdown

## Settings panel

Open **Settings → Plugins → Plugin configuration → ReConnect automatic retry**.

- **Maximum retry delay**: 1, 2, 5, 10, 30, 60, or 120 seconds, or a custom value
- **Retry quota errors**: disabled by default
- **Retry unknown errors indefinitely**: enabled by default
- **Maximum unknown-error retries**: defaults to 3 and applies only when indefinite unknown retries are disabled

Settings changes take effect immediately.

## Configuration

```yaml
- insert:
    - id: reconnect
      name: dsh-reconnect
      config:
        maxDelayMs: 15000
        retryQuota: false
        retryUnknown: true
        unknownMaxRetries: 3
```

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `maxDelayMs` | integer | `60000` | Maximum local exponential-backoff delay in milliseconds |
| `retryQuota` | boolean | `false` | Retry quota or exhausted-balance errors indefinitely |
| `retryUnknown` | boolean | `true` | Retry unknown error codes indefinitely |
| `unknownMaxRetries` | integer | `3` | Consecutive unknown-error limit when `retryUnknown` is disabled |

`maxDelayMs` limits only the local exponential delay. It does not cap a
Provider `Retry-After` value or the total retry duration.

## Installation

### npm

After the package is published to npm:

```sh
dsh plugin --profile web add dsh-reconnect
```

### GitHub

```sh
dsh plugin --profile web add github:mrbeandev/dsh-reconnect
```

Pin an exact release or commit for reproducible installations:

```sh
dsh plugin --profile web add github:mrbeandev/dsh-reconnect#v2.0.0
```

### Local checkout

```sh
git clone https://github.com/mrbeandev/dsh-reconnect.git
dsh plugin --profile web add ./dsh-reconnect
```

The DSH plugin manager automatically adds packages declaring `dsh.bundle` to
the selected profile. Restart DSH after installing the plugin.

## Requirements

- DeepSeek Harness with the Host settings service
- Node.js `^22.19.0` or `>=24.0.0`
- Web profile for the visual settings card

The client-side settings card never reads credentials.

## Development

```sh
npm test
npm pack --dry-run
```

Publishing runs the test suite through `prepublishOnly`.

## Credits

English edition based on the MIT-licensed
[MistRain-1/dsh-reconnect](https://github.com/MistRain-1/dsh-reconnect)
project. The original copyright notice is retained in [LICENSE](./LICENSE).

## License

MIT
