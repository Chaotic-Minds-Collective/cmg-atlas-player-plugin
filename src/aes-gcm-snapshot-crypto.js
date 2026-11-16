import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "AES-256-GCM";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_STATE_BYTES = 1_048_576;
const SNAPSHOT_KINDS = new Set(["inventory", "tame", "ship"]);
const SNAPSHOT_REASONS = new Set(["scheduled", "pre-loss", "manual", "reconciliation"]);

function requiredString(value, field, maxLength = 200) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${field} must be a non-empty string of at most ${maxLength} characters`);
  }
  return value;
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("snapshot metadata must be an object");
  }
  const normalized = {
    snapshotId: requiredString(metadata.snapshotId, "snapshotId"),
    clusterId: requiredString(metadata.clusterId, "clusterId"),
    gridId: requiredString(metadata.gridId, "gridId"),
    serverId: requiredString(metadata.serverId, "serverId"),
    kind: requiredString(metadata.kind, "kind"),
    assetId: requiredString(metadata.assetId, "assetId"),
    ownerId: requiredString(metadata.ownerId, "ownerId"),
    capturedAt: requiredString(metadata.capturedAt, "capturedAt"),
    reason: requiredString(metadata.reason, "reason"),
    schemaVersion: metadata.schemaVersion,
    stateBytes: metadata.stateBytes
  };
  if (!SNAPSHOT_KINDS.has(normalized.kind)) throw new TypeError("kind is unsupported");
  if (!SNAPSHOT_REASONS.has(normalized.reason)) throw new TypeError("reason is unsupported");
  if (normalized.schemaVersion !== 1) throw new TypeError("schemaVersion must be 1");
  if (!Number.isSafeInteger(normalized.stateBytes) || normalized.stateBytes < 1 || normalized.stateBytes > MAX_STATE_BYTES) {
    throw new RangeError("stateBytes must be between 1 byte and 1 MiB");
  }
  return Object.freeze(normalized);
}

function additionalAuthenticatedData(metadata) {
  const value = normalizeMetadata(metadata);
  return Buffer.from(JSON.stringify([
    value.snapshotId,
    value.clusterId,
    value.gridId,
    value.serverId,
    value.kind,
    value.assetId,
    value.ownerId,
    value.capturedAt,
    value.reason,
    value.schemaVersion,
    value.stateBytes
  ]), "utf8");
}

function normalizeKey(value) {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw new TypeError("snapshot key provider must return 32 bytes");
  }
  const key = Buffer.from(value);
  if (key.byteLength !== 32) throw new TypeError("snapshot key provider must return 32 bytes");
  return key;
}

function decodeBase64(value, field, expectedBytes) {
  if (typeof value !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError(`${field} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) throw new TypeError(`${field} must be canonical base64`);
  if (expectedBytes !== undefined && decoded.byteLength !== expectedBytes) {
    throw new TypeError(`${field} has an invalid byte length`);
  }
  return decoded;
}

/**
 * AES-256-GCM snapshot crypto with externally supplied key management.
 * Core receives only ciphertext; key material remains with the host.
 *
 * getCurrentKey() returns { keyId, key: Buffer|Uint8Array }.
 * getKeyById(keyId) returns the corresponding Buffer|Uint8Array.
 */
export function createAesGcmSnapshotCrypto({
  getCurrentKey,
  getKeyById,
  randomBytesImpl = randomBytes
}) {
  if (typeof getCurrentKey !== "function") throw new TypeError("getCurrentKey must be a function");
  if (typeof getKeyById !== "function") throw new TypeError("getKeyById must be a function");
  if (typeof randomBytesImpl !== "function") throw new TypeError("randomBytesImpl must be a function");

  async function encryptSnapshot({ stateJson, metadata } = {}) {
    if (typeof stateJson !== "string") throw new TypeError("stateJson must be a string");
    const plaintext = Buffer.from(stateJson, "utf8");
    const normalized = normalizeMetadata(metadata);
    if (plaintext.byteLength !== normalized.stateBytes) {
      throw new Error("serialized state size does not match snapshot metadata");
    }

    let current;
    try {
      current = await getCurrentKey();
    } catch {
      throw new Error("snapshot encryption key is unavailable");
    }
    if (!current || typeof current !== "object") throw new Error("snapshot encryption key is unavailable");
    const keyId = requiredString(current.keyId, "keyId");
    const key = normalizeKey(current.key);
    const nonce = Buffer.from(randomBytesImpl(NONCE_BYTES));
    if (nonce.byteLength !== NONCE_BYTES) throw new Error("snapshot nonce generator returned an invalid value");

    const cipher = createCipheriv(ALGORITHM.toLowerCase(), key, nonce);
    cipher.setAAD(additionalAuthenticatedData(normalized));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return Object.freeze({
      algorithm: ALGORITHM,
      keyId,
      nonce: nonce.toString("base64"),
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64")
    });
  }

  async function decryptSnapshot({ encryption, metadata } = {}) {
    const normalized = normalizeMetadata(metadata);
    if (!encryption || typeof encryption !== "object" || Array.isArray(encryption)) {
      throw new TypeError("encrypted snapshot envelope is required");
    }
    if (encryption.algorithm !== ALGORITHM) throw new TypeError("snapshot encryption algorithm is unsupported");
    const keyId = requiredString(encryption.keyId, "keyId");
    const nonce = decodeBase64(encryption.nonce, "nonce", NONCE_BYTES);
    const authTag = decodeBase64(encryption.authTag, "authTag", AUTH_TAG_BYTES);
    const ciphertext = decodeBase64(encryption.ciphertext, "ciphertext");
    if (ciphertext.byteLength !== normalized.stateBytes || ciphertext.byteLength > MAX_STATE_BYTES) {
      throw new Error("encrypted snapshot size does not match metadata");
    }

    let keyMaterial;
    try {
      keyMaterial = await getKeyById(keyId);
    } catch {
      throw new Error("snapshot decryption key is unavailable");
    }
    if (!keyMaterial) throw new Error("snapshot decryption key is unavailable");
    const key = normalizeKey(keyMaterial);

    let plaintext;
    try {
      const decipher = createDecipheriv(ALGORITHM.toLowerCase(), key, nonce);
      decipher.setAAD(additionalAuthenticatedData(normalized));
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error("snapshot authentication failed");
    }

    if (plaintext.byteLength !== normalized.stateBytes) throw new Error("decrypted snapshot size does not match metadata");
    let state;
    try {
      state = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("decrypted snapshot is not valid JSON");
    }
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("decrypted snapshot state must be a JSON object");
    }
    return state;
  }

  return Object.freeze({ encryptSnapshot, decryptSnapshot });
}
