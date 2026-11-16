import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createAesGcmSnapshotCrypto } from "../src/aes-gcm-snapshot-crypto.js";
import { createCoreSnapshotSink } from "../src/core-snapshot-sink.js";

const serverId = "00000000-0000-4000-8000-000000000003";
const clusterId = "00000000-0000-4000-8000-000000000002";
const snapshotId = "00000000-0000-4000-8000-000000000001";
const state = { items: [{ itemId: "item-1", quantity: 2 }] };
const stateBytes = Buffer.byteLength(JSON.stringify(state));
const snapshot = Object.freeze({
  schemaVersion: 1,
  snapshotId,
  kind: "inventory",
  assetId: "character-42",
  ownerId: "steam-42",
  scope: Object.freeze({ clusterId, gridId: "A1", serverId }),
  capturedAt: "2026-11-14T12:00:00.000Z",
  reason: "pre-loss",
  state: Object.freeze(state),
  stateBytes
});

function response(status, body) {
  return { status, async json() { return body; } };
}

function cryptoAdapter() {
  const key = randomBytes(32);
  const crypto = createAesGcmSnapshotCrypto({
    getCurrentKey: async () => ({ keyId: "test-key-v1", key }),
    getKeyById: async () => key
  });
  return crypto;
}

test("persists only an AES-256-GCM envelope to Core and maps the strict API fields", async () => {
  const crypto = cryptoAdapter();
  let request;
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId,
    serviceToken: "test-secret-token",
    encryptSnapshot: crypto.encryptSnapshot,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(201, { data: { snapshotId, durable: true, receipt: "core-receipt-1" } });
    }
  });

  const result = await sink.persist(snapshot);
  assert.equal(result.durable, true);
  assert.equal(result.receipt, "core-receipt-1");
  assert.equal(request.url, `https://core.example.test/integrations/servers/${serverId}/snapshots`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "manual");
  assert.equal(request.options.headers.authorization, "Bearer test-secret-token");
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(payload).sort(), [
    "assetId", "capturedAt", "clusterId", "encryption", "gridId", "kind",
    "ownerId", "reason", "schemaVersion", "serverId", "snapshotId", "stateBytes"
  ]);
  assert.equal("state" in payload, false);
  assert.equal(payload.encryption.algorithm, "AES-256-GCM");
  const recovered = await crypto.decryptSnapshot({
    encryption: payload.encryption,
    metadata: {
      snapshotId, clusterId, gridId: "A1", serverId, kind: "inventory",
      assetId: "character-42", ownerId: "steam-42", capturedAt: snapshot.capturedAt,
      reason: "pre-loss", schemaVersion: 1, stateBytes
    }
  });
  assert.deepEqual(recovered, state);
});

test("normalizes uppercase UUID scope values before persistence", async () => {
  const crypto = cryptoAdapter();
  let payload;
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId,
    serviceToken: "test-token",
    encryptSnapshot: crypto.encryptSnapshot,
    fetchImpl: async (_url, options) => {
      payload = JSON.parse(options.body);
      return response(201, { data: { snapshotId, durable: true, receipt: "uppercase-receipt" } });
    }
  });
  const uppercase = {
    ...snapshot,
    scope: { ...snapshot.scope, serverId: serverId.toUpperCase(), clusterId: clusterId.toUpperCase() }
  };
  await sink.persist(uppercase);
  assert.equal(payload.serverId, serverId);
  assert.equal(payload.clusterId, clusterId);
});

test("accepts Core's idempotent duplicate receipt", async () => {
  const crypto = cryptoAdapter();
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test", serverId, serviceToken: "test-token",
    encryptSnapshot: crypto.encryptSnapshot,
    fetchImpl: async () => response(200, { data: { snapshotId, durable: true, receipt: "existing-receipt", duplicate: true } })
  });
  assert.equal((await sink.persist(snapshot)).receipt, "existing-receipt");
});

test("rejects mismatched server scope before encryption or network access", async () => {
  let encryptCalls = 0;
  let fetchCalls = 0;
  const crypto = cryptoAdapter();
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId: "00000000-0000-4000-8000-000000000099",
    serviceToken: "test-token",
    encryptSnapshot: async (args) => { encryptCalls += 1; return crypto.encryptSnapshot(args); },
    fetchImpl: async () => { fetchCalls += 1; return response(201, {}); }
  });
  await assert.rejects(sink.persist(snapshot), /server scope does not match/);
  assert.equal(encryptCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("rejects non-HTTPS origins, credentials, and origin paths", () => {
  const crypto = cryptoAdapter();
  for (const coreOrigin of ["http://core.example.test", "https://user:pass@core.example.test", "https://core.example.test/api"]) {
    assert.throws(() => createCoreSnapshotSink({
      coreOrigin, serverId, serviceToken: "test-token", encryptSnapshot: crypto.encryptSnapshot
    }), /HTTPS origin/);
  }
});

test("rejects HTTP errors and does not follow redirects", async () => {
  const crypto = cryptoAdapter();
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test", serverId, serviceToken: "test-token",
    encryptSnapshot: crypto.encryptSnapshot,
    fetchImpl: async (_url, options) => { assert.equal(options.redirect, "manual"); return response(307, {}); }
  });
  await assert.rejects(sink.persist(snapshot), /HTTP 307/);
});

test("rejects malformed or non-durable Core receipts", async () => {
  const crypto = cryptoAdapter();
  for (const body of [
    {},
    { data: { snapshotId: "other", durable: true, receipt: "receipt" } },
    { data: { snapshotId, durable: false, receipt: "receipt" } },
    { data: { snapshotId, durable: true, receipt: " " } }
  ]) {
    const sink = createCoreSnapshotSink({
      coreOrigin: "https://core.example.test", serverId, serviceToken: "test-token",
      encryptSnapshot: crypto.encryptSnapshot,
      fetchImpl: async () => response(201, body)
    });
    await assert.rejects(sink.persist(snapshot), /invalid durable receipt/);
  }
});

test("rejects state larger than Core's 1 MiB limit before encryption or network access", async () => {
  let encryptCalls = 0;
  let fetchCalls = 0;
  const crypto = cryptoAdapter();
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test", serverId, serviceToken: "test-token",
    encryptSnapshot: async (args) => { encryptCalls += 1; return crypto.encryptSnapshot(args); },
    fetchImpl: async () => { fetchCalls += 1; return response(201, {}); }
  });
  const oversizedState = { value: "x".repeat(1_048_576) };
  const oversized = { ...snapshot, state: oversizedState, stateBytes: Buffer.byteLength(JSON.stringify(oversizedState)) };
  await assert.rejects(sink.persist(oversized), /1 MiB/);
  assert.equal(encryptCalls, 0);
  assert.equal(fetchCalls, 0);
});

test("validates required configuration and envelope output", async () => {
  const crypto = cryptoAdapter();
  assert.throws(() => createCoreSnapshotSink({ coreOrigin: "https://core.example.test", serverId: "", serviceToken: "x", encryptSnapshot: crypto.encryptSnapshot }), /serverId/);
  assert.throws(() => createCoreSnapshotSink({ coreOrigin: "https://core.example.test", serverId, serviceToken: "", encryptSnapshot: crypto.encryptSnapshot }), /serviceToken/);
  assert.throws(() => createCoreSnapshotSink({ coreOrigin: "https://core.example.test", serverId, serviceToken: "x" }), /encryptSnapshot/);
  const invalid = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test", serverId, serviceToken: "test-token",
    encryptSnapshot: async () => ({ algorithm: "none" }),
    fetchImpl: async () => response(201, {})
  });
  await assert.rejects(invalid.persist(snapshot), /unsupported envelope/);
});

test("does not expose credentials in transport failure messages", async () => {
  const crypto = cryptoAdapter();
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test", serverId, serviceToken: "secret-value",
    encryptSnapshot: crypto.encryptSnapshot,
    fetchImpl: async () => { throw new Error("network failure"); }
  });
  await assert.rejects(sink.persist(snapshot), (error) => {
    assert.equal(error.message, "Core encrypted snapshot persistence request failed");
    assert.equal(error.message.includes("secret-value"), false);
    return true;
  });
});
