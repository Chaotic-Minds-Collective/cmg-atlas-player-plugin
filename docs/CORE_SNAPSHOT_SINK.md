# Core Snapshot Sink

## Purpose

`createCoreSnapshotSink(options)` implements the Player capture coordinator's injected `sink.persist(snapshot)` contract using Core's ATLAS recovery snapshot API.

It is an explicit adapter only. It does not create a capture source, schedule captures, or invoke game callbacks.

## Configuration

Supply configuration from the host's secret/configuration system:

- `coreOrigin`: HTTPS origin only, with no path, query, fragment, or embedded credentials.
- `serverId`: the Core server UUID registered for this ATLAS instance.
- `serviceToken`: token for a dedicated service identity with only `recovery.snapshots.write` on that server.
- `timeoutMs`: optional bounded request timeout, default 10 seconds and maximum 30 seconds.
- `fetchImpl`: optional injected Fetch-compatible implementation for tests.

Do not commit service tokens, put them in logs, or reuse a broad administrative credential. No environment variables or global process configuration are read by this module.

## Request behavior

The adapter posts to:

`POST /integrations/servers/{serverId}/recovery/snapshots`

It maps the capture snapshot to Core's strict request schema and deliberately omits local-only `schemaVersion` and `stateBytes` fields. It uses bearer authentication, JSON content negotiation, a bounded timeout, and manual redirect handling. Non-2xx responses, network failures, invalid JSON, and invalid durable receipts fail closed.

Core's `201` creation response and `200` identical-duplicate response are both accepted only when the returned snapshot ID matches and `durable: true` plus a non-empty receipt are present.

## Example

```js
import { createCoreSnapshotSink } from "./core-snapshot-sink.js";
import { createSnapshotCapture } from "./snapshot-capture.js";

const sink = createCoreSnapshotSink({
  coreOrigin: config.coreOrigin,
  serverId: config.serverId,
  serviceToken: secrets.playerSnapshotWriterToken
});

const capture = createSnapshotCapture({
  source: verifiedAtlasSource,
  sink,
  createSnapshotId: createStableSnapshotId
});

// Capture remains an explicit caller action.
await capture.capture({ kind: "inventory", assetId, scope, reason: "pre-loss-checkpoint" });
```

The example's `verifiedAtlasSource`, stable ID generator, host configuration, and secrets provider must be supplied by a verified host integration; they are not included or fabricated here.

## Limits

- The sink validates the configured HTTPS origin, server scope, state shape, and 16 MiB JSON size bound.
- Core independently validates the registered server/cluster/grid topology and service permission.
- Core storage is not application-encrypted. Confirm database encryption-at-rest, network restrictions, backups, retention, and access controls before storing real player data.
- A successful sink receipt proves Core accepted the payload durably; it does not prove the payload is authentic or that capture happened before a loss.
