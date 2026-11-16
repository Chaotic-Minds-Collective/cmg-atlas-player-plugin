# Core Snapshot Sink

## Purpose

`createCoreSnapshotSink(options)` implements the Player capture coordinator's injected `sink.persist(snapshot)` contract using Core's encrypted ATLAS asset snapshot API.

It is an explicit adapter only. It does not create a capture source, schedule captures, or invoke game callbacks.

## Configuration

Supply configuration from the host's secret and key-management systems:

- `coreOrigin`: HTTPS origin only, with no path, query, fragment, or embedded credentials.
- `serverId`: the Core server UUID registered for this ATLAS instance.
- `serviceToken`: token for a dedicated service identity with only `snapshots.write` on that server (the Core `asset_snapshot_manager` role).
- `encryptSnapshot`: an injected encryption function. Use `createAesGcmSnapshotCrypto` with an external key provider; do not store keys in Core or this repository.
- `timeoutMs`: optional bounded request timeout, default 10 seconds and maximum 30 seconds.
- `fetchImpl`: optional injected Fetch-compatible implementation for tests.

Do not commit service tokens or encryption keys, put them in logs, or reuse a broad administrative credential. No environment variables or global process configuration are read by this module.

## Request behavior

The adapter posts to:

`POST /integrations/servers/{serverId}/snapshots`

It serializes the validated JSON state, encrypts it with AES-256-GCM, and sends only the encrypted envelope plus scope and metadata. The plaintext state is never included in the HTTP body. The encryption adapter binds the ciphertext to snapshot ID, owner, asset, kind, server, cluster, grid, timestamp, reason, and schema version using authenticated additional data (AAD).

The sink requires UUID snapshot/server/cluster IDs, a valid capture timestamp, one of the supported snapshot kinds and reasons, and a state size no larger than 1 MiB. It validates the encryption envelope before making the request. Core independently validates the registered server/cluster topology and service permission.

Core's 201 creation response and 200 identical-duplicate response are both accepted only when the returned snapshot ID matches and `durable: true` plus a non-empty receipt are present.

## Example

```js
import { createAesGcmSnapshotCrypto } from "./aes-gcm-snapshot-crypto.js";
import { createCoreSnapshotSink } from "./core-snapshot-sink.js";

const snapshotCrypto = createAesGcmSnapshotCrypto({
  getCurrentKey: keyProvider.getCurrentKey,
  getKeyById: keyProvider.getKeyById
});
const sink = createCoreSnapshotSink({
  coreOrigin: config.coreOrigin,
  serverId: config.serverId,
  serviceToken: secrets.playerSnapshotWriterToken,
  encryptSnapshot: snapshotCrypto.encryptSnapshot
});
```

The host's `keyProvider`, source adapter, stable UUID generator, configuration, and secrets provider must be supplied by a verified host integration; they are not included or fabricated here.

## Safety boundary

- The sink encrypts before transmission; Core stores opaque ciphertext only.
- Encryption keys remain outside Core and the database. Key rotation and old-key retrieval are the host's responsibility.
- A successful sink receipt proves Core accepted the ciphertext durably; it does not prove the payload is authentic or that capture happened before a loss.
- The current native adapter still needs verified ATLAS state sources before real captures can be enabled.
