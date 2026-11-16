# Core Snapshot Reader

The Player Core snapshot reader is an explicitly invoked, read-only client for Core's encrypted asset snapshot API. It complements the encrypted snapshot sink; it does not connect to the database and does not perform restoration.

## Configuration

Create a dedicated server-scoped service identity with the Core `asset_snapshot_reader` role and `snapshots.read` permission. This role is read-only; do not reuse the writer credential.

```sh
npm run service:create -- atlas-player-snapshot-reader --role asset_snapshot_reader --scope-type server --scope-id <SERVER_UUID>
```

Configure the reader with:

- `coreOrigin`: HTTPS origin only, with no path, credentials, query, or fragment
- `serverId`: the one server UUID to which the service token is scoped
- `serviceToken`: dedicated read-only token
- `decryptSnapshot`: an injected decryption function using the external key provider
- `fetchImpl`: optional injected Fetch-compatible implementation
- `timeoutMs`: optional bounded timeout from 1 to 30,000 ms (default 10,000)

## API

```js
import { createAesGcmSnapshotCrypto } from "./aes-gcm-snapshot-crypto.js";
import { createCoreSnapshotReader } from "./core-snapshot-reader.js";

const snapshotCrypto = createAesGcmSnapshotCrypto({
  getCurrentKey: keyProvider.getCurrentKey,
  getKeyById: keyProvider.getKeyById
});
const reader = createCoreSnapshotReader({
  coreOrigin: config.coreOrigin,
  serverId: config.serverId,
  serviceToken: secrets.playerSnapshotReaderToken,
  decryptSnapshot: snapshotCrypto.decryptSnapshot
});

const metadata = await reader.list({
  kind: "tame",
  assetId: "provider-tame-id",
  ownerId: "provider-owner-id",
  limit: 25
});
const snapshot = await reader.get(metadata[0].snapshotId);
```

- `list({ kind, assetId, ownerId, before?, limit? })` calls the fixed server-scoped list endpoint. Kind, asset ID, and owner ID are required. The limit defaults to 25 and is bounded to 1–100. Results contain metadata only; no ciphertext or plaintext state is returned by list.
- `get(snapshotId)` retrieves one encrypted envelope, verifies the server scope, decrypts with AES-256-GCM, and returns validated state.

Returned objects are detached and deeply frozen. The reader validates response shape, snapshot kind, owner, asset, schema version, byte limits, cluster/grid scope, and the server ID against its fixed configuration. The crypto adapter authenticates snapshot metadata as AAD and rejects tampering, wrong keys, and invalid JSON. The reader refuses redirects, disables caching, and applies a bounded timeout.

## Safety boundary

- The reader is read-only. It has no restore, delete, update, scheduling, or game-server operation.
- Core independently enforces `snapshots.read` and the service identity's exact server scope.
- Core stores no encryption keys and never decrypts snapshots; key material stays with the external key provider.
- A successful read proves that the stored ciphertext authenticated and decrypted. It does not prove that a source adapter captured authentic ATLAS state.
- Use the snapshot with the existing recovery evidence policy. Never infer lost inventory, tame, or ship state from a loss event alone.
- Native source callbacks and restore APIs remain unverified pending isolated live-server testing.
