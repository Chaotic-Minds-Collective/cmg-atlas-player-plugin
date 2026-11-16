import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createAesGcmSnapshotCrypto } from "../src/aes-gcm-snapshot-crypto.js";
import { createCoreSnapshotReader } from "../src/core-snapshot-reader.js";

const serverId = "00000000-0000-4000-8000-000000000003";
const clusterId = "00000000-0000-4000-8000-000000000002";
const snapshotId = "00000000-0000-4000-8000-000000000001";
const token = "cg_srv_test_reader_token";
const state = { slots: [{ itemId: "item-1", quantity: 2 }] };
const stateJson = JSON.stringify(state);
const stateBytes = Buffer.byteLength(stateJson);
const metadata = {
  snapshotId,
  clusterId,
  gridId: "A1",
  serverId,
  kind: "inventory",
  assetId: "character-1",
  ownerId: "steam-1",
  capturedAt: "2026-11-14T20:00:00.000Z",
  reason: "scheduled",
  schemaVersion: 1,
  stateBytes
};

const key = randomBytes(32);
const crypto = createAesGcmSnapshotCrypto({
  getCurrentKey: async () => ({ keyId: "test-key-v1", key }),
  getKeyById: async (keyId) => keyId === "test-key-v1" ? key : null
});
const encryption = await crypto.encryptSnapshot({ stateJson, metadata });
const fullSnapshot = {
  ...metadata,
  algorithm: encryption.algorithm,
  keyId: encryption.keyId,
  nonce: encryption.nonce,
  authTag: encryption.authTag,
  ciphertext: encryption.ciphertext
};

function response(data, status = 200) {
  return { status, async json() { return { data, requestId: "request-1" }; } };
}

function reader(fetchImpl, options = {}) {
  return createCoreSnapshotReader({
    coreOrigin: "https://core.example.test",
    serverId,
    serviceToken: token,
    decryptSnapshot: crypto.decryptSnapshot,
    fetchImpl,
    ...options
  });
}

test("lists encrypted snapshot metadata with fixed server scope and owner filters", async () => {
  let called;
  const client = reader(async (url, options) => {
    called = { url: new URL(url), options };
    return response([{ ...metadata, assetId: "character/1" }]);
  });
  const result = await client.list({
    kind: "inventory",
    assetId: "character/1",
    ownerId: "steam-1",
    limit: 10
  });

  assert.equal(called.url.pathname, `/integrations/servers/${serverId}/snapshots`);
  assert.equal(called.url.searchParams.get("kind"), "inventory");
  assert.equal(called.url.searchParams.get("assetId"), "character/1");
  assert.equal(called.url.searchParams.get("ownerId"), "steam-1");
  assert.equal(called.url.searchParams.get("limit"), "10");
  assert.equal(called.options.method, "GET");
  assert.equal(called.options.redirect, "manual");
  assert.equal(called.options.cache, "no-store");
  assert.equal(called.options.headers.authorization, `Bearer ${token}`);
  assert.equal(result.length, 1);
  assert.equal(result[0].ownerId, "steam-1");
  assert.deepEqual(result[0].scope, { clusterId, gridId: "A1", serverId });
  assert.equal("state" in result[0], false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
});

test("rejects a Core listing that violates the requested owner filter", async () => {
  const otherOwner = { ...metadata, snapshotId: "00000000-0000-4000-8000-000000000004", ownerId: "steam-2" };
  const client = reader(async () => response([metadata, otherOwner]));
  await assert.rejects(
    client.list({ kind: "inventory", assetId: "character-1", ownerId: "steam-1" }),
    /different owner scope/
  );
});

test("lists require asset kind, asset ID, and owner ID", async () => {
  let calls = 0;
  const client = reader(async () => { calls += 1; return response([]); });
  await assert.rejects(client.list(), /kind must be/);
  await assert.rejects(client.list({ kind: "inventory" }), /assetId/);
  await assert.rejects(client.list({ kind: "inventory", assetId: "character-1" }), /ownerId/);
  assert.equal(calls, 0);
});

test("reads and decrypts snapshot state after verifying server, cluster, and metadata", async () => {
  let requested;
  const client = reader(async (url, options) => {
    requested = { url: new URL(url), options };
    return response(fullSnapshot);
  });
  const result = await client.get(snapshotId);
  assert.equal(requested.url.pathname, `/integrations/servers/${serverId}/snapshots/${snapshotId}`);
  assert.equal(requested.options.cache, "no-store");
  assert.deepEqual(result.scope, { clusterId, gridId: "A1", serverId });
  assert.deepEqual(result.state, state);
  assert.equal(Object.isFrozen(result.state.slots[0]), true);
  assert.equal("ciphertext" in result, false);
});

test("rejects a snapshot returned for another server or invalid scope", async () => {
  const wrongServer = reader(async () => response({ ...fullSnapshot, serverId: "00000000-0000-4000-8000-000000000099" }));
  await assert.rejects(wrongServer.get(snapshotId), /different server scope/);
  const wrongCluster = reader(async () => response({ ...fullSnapshot, clusterId: "00000000-0000-4000-8000-000000000099" }));
  await assert.rejects(wrongCluster.get(snapshotId), /authentication failed/);
});

test("rejects tampered ciphertext and malformed envelope fields", async () => {
  const tampered = Buffer.from(encryption.ciphertext, "base64");
  tampered[0] ^= 1;
  const badCiphertext = reader(async () => response({ ...fullSnapshot, ciphertext: tampered.toString("base64") }));
  await assert.rejects(badCiphertext.get(snapshotId), /authentication failed/);
  const badNonce = reader(async () => response({ ...fullSnapshot, nonce: "not-base64" }));
  await assert.rejects(badNonce.get(snapshotId), /invalid nonce/);
  const badTag = reader(async () => response({ ...fullSnapshot, authTag: "bad" }));
  await assert.rejects(badTag.get(snapshotId), /invalid authentication tag/);
});

test("rejects invalid metadata and plaintext sizes", async () => {
  const badSize = reader(async () => response({ ...fullSnapshot, stateBytes: 1 }));
  await assert.rejects(badSize.get(snapshotId), /size does not match metadata|authentication failed/);
  const badReason = reader(async () => response({ ...fullSnapshot, reason: "unknown" }));
  await assert.rejects(badReason.get(snapshotId), /unsupported reason/);
  const badState = reader(async () => response({ ...fullSnapshot, ciphertext: Buffer.from("[]").toString("base64"), stateBytes: 2 }));
  await assert.rejects(badState.get(snapshotId), /state must be a JSON object|authentication failed/);
});

test("rejects invalid configuration and query filters before network access", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response([]); };
  assert.throws(() => createCoreSnapshotReader({
    coreOrigin: "http://core.example.test", serverId, serviceToken: token,
    decryptSnapshot: crypto.decryptSnapshot, fetchImpl
  }), /HTTPS origin/);
  assert.throws(() => reader(fetchImpl, { timeoutMs: 30_001 }), /timeoutMs/);
  const client = reader(fetchImpl);
  await assert.rejects(client.list({ kind: "unknown", assetId: "x", ownerId: "y" }), /kind must be/);
  await assert.rejects(client.list({ kind: "inventory", assetId: " ", ownerId: "y" }), /assetId/);
  await assert.rejects(client.list({ kind: "inventory", assetId: "x", ownerId: " " }), /ownerId/);
  await assert.rejects(client.list({ kind: "inventory", assetId: "x", ownerId: "y", limit: 101 }), /limit/);
  await assert.rejects(client.get("not-a-uuid"), /UUID/);
  assert.equal(calls, 0);
});

test("surfaces HTTP failures without reading response content", async () => {
  const client = reader(async () => ({ status: 403, async json() { throw new Error(token); } }));
  await assert.rejects(client.list({ kind: "inventory", assetId: "x", ownerId: "y" }), /HTTP 403/);
});

test("does not follow redirects", async () => {
  let options;
  const client = reader(async (_url, requestOptions) => {
    options = requestOptions;
    return response([], 302);
  });
  await assert.rejects(client.list({ kind: "inventory", assetId: "x", ownerId: "y" }), /HTTP 302/);
  assert.equal(options.redirect, "manual");
});

test("sanitizes transport failures while retaining the cause", async () => {
  const client = reader(async () => { throw new Error(`failed with ${token}`); });
  await assert.rejects(client.list({ kind: "inventory", assetId: "x", ownerId: "y" }), (error) => {
    assert.equal(error.message, "Core encrypted snapshot listing request failed");
    assert.equal(error.message.includes(token), false);
    assert.match(error.cause.message, /cg_srv_test_reader_token/);
    return true;
  });
});

for (const mismatch of [{ kind: "ship" }, { assetId: "ship-2" }]) {
  test(`rejects a listing with mismatched ${Object.keys(mismatch)[0]}`, async () => {
    const client = reader(async () => response([metadata, { ...metadata, ...mismatch }]));
    await assert.rejects(
      client.list({ kind: "inventory", assetId: "character-1", ownerId: "steam-1" }),
      /different kind or asset scope/
    );
  });
}

test("rejects a different authenticated snapshot from the same server", async () => {
  const otherMetadata = { ...metadata, snapshotId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const otherEncryption = await crypto.encryptSnapshot({ stateJson, metadata: otherMetadata });
  const client = reader(async () => response({ ...otherMetadata, ...otherEncryption }));
  await assert.rejects(client.get(snapshotId), /different snapshot ID/);
  const result = await client.get(otherMetadata.snapshotId.toUpperCase());
  assert.equal(result.snapshotId, otherMetadata.snapshotId);
  assert.deepEqual(result.state, state);
});
