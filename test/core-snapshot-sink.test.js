import test from "node:test";
import assert from "node:assert/strict";
import { createCoreSnapshotSink } from "../src/core-snapshot-sink.js";

const snapshot = Object.freeze({
  schemaVersion: 1,
  snapshotId: "snapshot-123",
  kind: "inventory",
  assetId: "character-42",
  ownerId: "steam-42",
  scope: Object.freeze({
    clusterId: "00000000-0000-4000-8000-000000000001",
    gridId: "TheIsland",
    serverId: "00000000-0000-4000-8000-000000000002"
  }),
  capturedAt: "2026-11-14T12:00:00.000Z",
  reason: "pre-loss-checkpoint",
  state: Object.freeze({ items: Object.freeze([{ itemId: "item-1", quantity: 2 }]) }),
  stateBytes: 42
});

function response(status, body) {
  return {
    status,
    async json() { return body; }
  };
}

test("persists a bounded snapshot through Core and maps only the strict API fields", async () => {
  let request;
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId: snapshot.scope.serverId,
    serviceToken: "test-secret-token",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(201, {
        data: { snapshotId: snapshot.snapshotId, durable: true, receipt: "core-receipt-1" }
      });
    }
  });

  const result = await sink.persist(snapshot);
  assert.equal(result.durable, true);
  assert.equal(result.receipt, "core-receipt-1");
  assert.equal(request.url, "https://core.example.test/integrations/servers/00000000-0000-4000-8000-000000000002/recovery/snapshots");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.redirect, "manual");
  assert.equal(request.options.headers.authorization, "Bearer test-secret-token");
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(Object.keys(payload).sort(), [
    "assetId", "capturedAt", "kind", "ownerId", "reason", "scope", "snapshotId", "state"
  ]);
  assert.deepEqual(payload.state, snapshot.state);
  assert.equal(payload.scope.serverId, snapshot.scope.serverId);
  assert.equal("schemaVersion" in payload, false);
  assert.equal("stateBytes" in payload, false);
});

test("accepts Core's idempotent duplicate receipt", async () => {
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId: snapshot.scope.serverId,
    serviceToken: "test-token",
    fetchImpl: async () => response(200, {
      data: { snapshotId: snapshot.snapshotId, durable: true, receipt: "existing-receipt", duplicate: true }
    })
  });
  assert.equal((await sink.persist(snapshot)).receipt, "existing-receipt");
});

test("rejects a mismatched configured server before making a request", async () => {
  let calls = 0;
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId: "00000000-0000-4000-8000-000000000099",
    serviceToken: "test-token",
    fetchImpl: async () => { calls += 1; return response(201, {}); }
  });
  await assert.rejects(sink.persist(snapshot), /server scope does not match/);
  assert.equal(calls, 0);
});

test("rejects non-HTTPS origins, credentials, and origin paths", () => {
  for (const coreOrigin of [
    "http://core.example.test",
    "https://user:pass@core.example.test",
    "https://core.example.test/api"
  ]) {
    assert.throws(() => createCoreSnapshotSink({
      coreOrigin, serverId: snapshot.scope.serverId, serviceToken: "test-token"
    }), /HTTPS origin/);
  }
});

test("rejects redirects and non-success responses without following them", async () => {
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId: snapshot.scope.serverId,
    serviceToken: "test-token",
    fetchImpl: async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return response(307, {});
    }
  });
  await assert.rejects(sink.persist(snapshot), /HTTP 307/);
});

test("rejects malformed or non-durable Core receipts", async () => {
  for (const body of [
    {},
    { data: { snapshotId: "other", durable: true, receipt: "receipt" } },
    { data: { snapshotId: snapshot.snapshotId, durable: false, receipt: "receipt" } },
    { data: { snapshotId: snapshot.snapshotId, durable: true, receipt: " " } }
  ]) {
    const sink = createCoreSnapshotSink({
      coreOrigin: "https://core.example.test",
      serverId: snapshot.scope.serverId,
      serviceToken: "test-token",
      fetchImpl: async () => response(201, body)
    });
    await assert.rejects(sink.persist(snapshot), /invalid durable receipt/);
  }
});

test("does not expose credentials in request failure messages", async () => {
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId: snapshot.scope.serverId,
    serviceToken: "secret-value",
    fetchImpl: async () => { throw new Error("network failure"); }
  });
  await assert.rejects(sink.persist(snapshot), (error) => {
    assert.equal(error.message, "Core snapshot persistence request failed");
    assert.equal(error.message.includes("secret-value"), false);
    return true;
  });
});

test("validates configuration and timeout bounds", () => {
  assert.throws(() => createCoreSnapshotSink({
    coreOrigin: "https://core.example.test", serverId: "", serviceToken: "token"
  }), /serverId/);
  assert.throws(() => createCoreSnapshotSink({
    coreOrigin: "https://core.example.test", serverId: snapshot.scope.serverId, serviceToken: ""
  }), /serviceToken/);
  assert.throws(() => createCoreSnapshotSink({
    coreOrigin: "https://core.example.test", serverId: snapshot.scope.serverId,
    serviceToken: "token", timeoutMs: 30_001
  }), /timeoutMs/);
});

test("rejects state larger than Core's 16 MiB limit before network access", async () => {
  let calls = 0;
  const sink = createCoreSnapshotSink({
    coreOrigin: "https://core.example.test",
    serverId: snapshot.scope.serverId,
    serviceToken: "test-token",
    fetchImpl: async () => { calls += 1; return response(201, {}); }
  });
  const oversized = { ...snapshot, state: { value: "x".repeat(16 * 1024 * 1024) } };
  await assert.rejects(sink.persist(oversized), /16 MiB/);
  assert.equal(calls, 0);
});
