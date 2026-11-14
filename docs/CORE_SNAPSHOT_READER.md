# Core Snapshot Reader

The Player Core snapshot reader is an explicitly invoked, read-only client for the Core recovery snapshot API. It complements the snapshot persistence sink; it does not connect to the database and does not perform restoration.

## Configuration

Create a dedicated server-scoped identity with the `recovery_snapshot_reader` role and `recovery.snapshots.read` permission. Do not reuse the writer credential.

```sh
npm run service:create -- atlas-player-snapshot-reader --role recovery_snapshot_reader --scope-type server --scope-id <SERVER_UUID>
```

Configure the reader with:

- `coreOrigin`: HTTPS origin only, with no path, credentials, query, or fragment
- `serverId`: the one server UUID to which the service token is scoped
- `serviceToken`: dedicated reader token
- `fetchImpl`: optional injected Fetch-compatible implementation
- `timeoutMs`: optional bounded timeout from 1 to 30,000 ms (default 10,000)

## API

```js
import { createCoreSnapshotReader } from "./src/core-snapshot-reader.js";

const reader = createCoreSnapshotReader({
  coreOrigin: "https://core.example.com",
  serverId: "<SERVER_UUID>",
  serviceToken: "<SERVER_SCOPED_READER_TOKEN>"
});

const metadata = await reader.list({
  kind: "inventory",
  assetId: "provider-character-id",
  ownerId: "provider-owner-id",
  limit: 25
});

const snapshot = await reader.get(metadata[0].snapshotId);
```

- `list({ kind?, assetId?, ownerId?, limit? })` calls the server-scoped list endpoint. The limit defaults to 25 and is bounded to 1–100. Results contain metadata only; no snapshot state is returned by the list operation.
- `get(snapshotId)` retrieves one snapshot and its stored state from the same fixed server scope.

Returned objects are detached and deeply frozen. The reader validates response shape, snapshot kind, metadata bounds, cluster scope, state shape, and the server ID against the configured server. It refuses redirects, disables caching, and applies a bounded timeout. Transport errors are surfaced without embedding authorization headers or token values.

## Safety boundary

- The reader is read-only. It has no restore, delete, update, scheduling, or game-server operation.
- The configured server ID is fixed at construction; callers cannot pass a different server to either method.
- Core independently enforces `recovery.snapshots.read` and the service identity's server scope.
- A successful read proves only that Core returned stored data. It does not prove that a source adapter captured authentic ATLAS state.
- Use the snapshot with the existing recovery evidence policy. Never infer lost inventory, tame, or ship state from a loss event alone.
- Native source callbacks and restore APIs remain unverified pending isolated live-server testing.
