import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createAesGcmSnapshotCrypto } from "../src/aes-gcm-snapshot-crypto.js";

const metadata = Object.freeze({
  snapshotId: "00000000-0000-4000-8000-000000000001",
  clusterId: "00000000-0000-4000-8000-000000000002",
  gridId: "A1",
  serverId: "00000000-0000-4000-8000-000000000003",
  kind: "tame",
  assetId: "tame-42",
  ownerId: "76561198000000001",
  capturedAt: "2026-11-14T12:00:00.000Z",
  reason: "pre-loss",
  schemaVersion: 1,
  stateBytes: 0
});

function createCrypto() {
  const keys = new Map([["test-key-v1", randomBytes(32)], ["test-key-v2", randomBytes(32)]]);
  return {
    keys,
    crypto: createAesGcmSnapshotCrypto({
      getCurrentKey: async () => ({ keyId: "test-key-v1", key: keys.get("test-key-v1") }),
      getKeyById: async (keyId) => keys.get(keyId)
    })
  };
}

test("encrypts and decrypts snapshot JSON with AES-256-GCM and metadata-bound AAD", async () => {
  const { crypto } = createCrypto();
  const state = { tame: { level: 100, colors: [1, 2, 3] } };
  const stateJson = JSON.stringify(state);
  const boundMetadata = { ...metadata, stateBytes: Buffer.byteLength(stateJson) };
  const encryption = await crypto.encryptSnapshot({ stateJson, metadata: boundMetadata });
  assert.equal(encryption.algorithm, "AES-256-GCM");
  assert.equal(Buffer.from(encryption.nonce, "base64").byteLength, 12);
  assert.equal(Buffer.from(encryption.authTag, "base64").byteLength, 16);
  assert.equal(Buffer.from(encryption.ciphertext, "base64").byteLength, boundMetadata.stateBytes);
  assert.notEqual(encryption.ciphertext, Buffer.from(stateJson).toString("base64"));
  assert.deepEqual(await crypto.decryptSnapshot({ encryption, metadata: boundMetadata }), state);
});

test("rejects metadata substitution even when ciphertext and key are unchanged", async () => {
  const { crypto } = createCrypto();
  const stateJson = JSON.stringify({ ship: { hull: 100 } });
  const boundMetadata = { ...metadata, kind: "ship", assetId: "ship-1", stateBytes: Buffer.byteLength(stateJson) };
  const encryption = await crypto.encryptSnapshot({ stateJson, metadata: boundMetadata });
  await assert.rejects(
    crypto.decryptSnapshot({ encryption, metadata: { ...boundMetadata, ownerId: "76561198000000002" } }),
    /authentication failed/
  );
});

test("rejects tampered ciphertext and authentication tags", async () => {
  const { crypto } = createCrypto();
  const stateJson = JSON.stringify({ inventory: [] });
  const boundMetadata = { ...metadata, stateBytes: Buffer.byteLength(stateJson) };
  const encryption = await crypto.encryptSnapshot({ stateJson, metadata: boundMetadata });
  const tamperedBytes = Buffer.from(encryption.ciphertext, "base64");
  tamperedBytes[0] ^= 1;
  await assert.rejects(
    crypto.decryptSnapshot({ encryption: { ...encryption, ciphertext: tamperedBytes.toString("base64") }, metadata: boundMetadata }),
    /authentication failed/
  );
  await assert.rejects(
    crypto.decryptSnapshot({ encryption: { ...encryption, authTag: randomBytes(16).toString("base64") }, metadata: boundMetadata }),
    /authentication failed/
  );
});

test("supports key rotation by retaining old keys by key ID", async () => {
  const { keys } = createCrypto();
  const crypto = createAesGcmSnapshotCrypto({
    getCurrentKey: async () => ({ keyId: "test-key-v2", key: keys.get("test-key-v2") }),
    getKeyById: async (keyId) => keys.get(keyId)
  });
  const stateJson = JSON.stringify({ inventory: [{ id: "item-1" }] });
  const boundMetadata = { ...metadata, stateBytes: Buffer.byteLength(stateJson) };
  const encryption = await crypto.encryptSnapshot({ stateJson, metadata: boundMetadata });
  assert.equal(encryption.keyId, "test-key-v2");
  assert.deepEqual(await crypto.decryptSnapshot({ encryption, metadata: boundMetadata }), JSON.parse(stateJson));
});

test("fails closed when a key is missing or invalid", async () => {
  const unavailable = createAesGcmSnapshotCrypto({
    getCurrentKey: async () => ({ keyId: "missing", key: randomBytes(16) }),
    getKeyById: async () => null
  });
  const stateJson = JSON.stringify({ tame: {} });
  const boundMetadata = { ...metadata, stateBytes: Buffer.byteLength(stateJson) };
  await assert.rejects(unavailable.encryptSnapshot({ stateJson, metadata: boundMetadata }), /32 bytes/);
  const valid = createAesGcmSnapshotCrypto({
    getCurrentKey: async () => ({ keyId: "key-1", key: randomBytes(32) }),
    getKeyById: async () => null
  });
  const envelope = await valid.encryptSnapshot({ stateJson, metadata: boundMetadata });
  await assert.rejects(valid.decryptSnapshot({ encryption: envelope, metadata: boundMetadata }), /key is unavailable/);
});

test("rejects unsupported metadata and malformed envelopes", async () => {
  const { crypto } = createCrypto();
  const stateJson = JSON.stringify({ tame: {} });
  const boundMetadata = { ...metadata, stateBytes: Buffer.byteLength(stateJson) };
  await assert.rejects(crypto.encryptSnapshot({ stateJson, metadata: { ...boundMetadata, schemaVersion: 2 } }), /schemaVersion/);
  await assert.rejects(crypto.encryptSnapshot({ stateJson, metadata: { ...boundMetadata, stateBytes: 1 } }), /size does not match/);
  await assert.rejects(crypto.decryptSnapshot({ encryption: { algorithm: "none" }, metadata: boundMetadata }), /unsupported/);
});
