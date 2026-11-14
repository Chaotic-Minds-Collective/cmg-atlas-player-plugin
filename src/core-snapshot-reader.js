const MAX_TIMEOUT_MS = 30_000;
const SNAPSHOT_KINDS = Object.freeze(["inventory", "tame", "ship"]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function normalizeOrigin(value) {
  requiredString(value, "coreOrigin");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("coreOrigin must be a valid HTTPS origin");
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("coreOrigin must be an HTTPS origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateMetadata(item, serverId) {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Core snapshot listing returned an invalid item");
  }
  requiredString(item.snapshotId, "snapshot.snapshotId");
  if (!SNAPSHOT_KINDS.includes(item.kind)) throw new Error("Core snapshot listing returned an unsupported kind");
  requiredString(item.assetId, "snapshot.assetId");
  requiredString(item.ownerId, "snapshot.ownerId");
  requiredString(item.gridId, "snapshot.gridId");
  requiredString(item.capturedAt, "snapshot.capturedAt");
  requiredString(item.reason, "snapshot.reason");
  if (!Number.isSafeInteger(item.stateBytes) || item.stateBytes < 1 || item.stateBytes > 16 * 1024 * 1024) {
    throw new Error("Core snapshot listing returned an invalid state size");
  }
  return deepFreeze({
    snapshotId: item.snapshotId,
    kind: item.kind,
    assetId: item.assetId,
    ownerId: item.ownerId,
    scope: { serverId, gridId: item.gridId },
    capturedAt: item.capturedAt,
    stateBytes: item.stateBytes,
    reason: item.reason
  });
}

function validateSnapshot(item, serverId) {
  const metadata = validateMetadata(item, serverId);
  if (typeof item.clusterId !== "string" || item.clusterId.trim().length === 0) {
    throw new Error("Core snapshot read returned an invalid cluster scope");
  }
  if (item.serverId !== serverId) {
    throw new Error("Core snapshot read returned a different server scope");
  }
  if (!item.state || typeof item.state !== "object" || Array.isArray(item.state)) {
    throw new Error("Core snapshot read returned invalid state");
  }
  return deepFreeze({
    ...metadata,
    scope: { clusterId: item.clusterId, gridId: item.gridId, serverId },
    state: item.state
  });
}

/**
 * Create an explicitly invoked, read-only client for Core recovery snapshots.
 * The server ID is fixed at construction so callers cannot widen the scope.
 */
export function createCoreSnapshotReader({
  coreOrigin,
  serverId,
  serviceToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000
}) {
  const origin = normalizeOrigin(coreOrigin);
  requiredString(serverId, "serverId");
  requiredString(serviceToken, "serviceToken");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError("timeoutMs must be between 1 and 30000");
  }

  const basePath = `${origin}/integrations/servers/${encodeURIComponent(serverId)}/recovery/snapshots`;

  async function request(url, operation) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${serviceToken}`,
          accept: "application/json"
        },
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const failure = new Error(`Core snapshot ${operation} request failed`);
      failure.cause = error;
      throw failure;
    }

    if (response.status < 200 || response.status >= 300 || response.status === 304) {
      throw new Error(`Core snapshot ${operation} returned HTTP ${response.status}`);
    }
    try {
      return await response.json();
    } catch (error) {
      const failure = new Error(`Core snapshot ${operation} returned invalid JSON`);
      failure.cause = error;
      throw failure;
    }
  }

  async function list({ kind, assetId, ownerId, limit = 25 } = {}) {
    if (kind !== undefined && !SNAPSHOT_KINDS.includes(kind)) {
      throw new TypeError("kind must be inventory, tame, or ship");
    }
    if (assetId !== undefined) requiredString(assetId, "assetId");
    if (ownerId !== undefined) requiredString(ownerId, "ownerId");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError("limit must be an integer between 1 and 100");
    }

    const url = new URL(basePath);
    if (kind !== undefined) url.searchParams.set("kind", kind);
    if (assetId !== undefined) url.searchParams.set("assetId", assetId);
    if (ownerId !== undefined) url.searchParams.set("ownerId", ownerId);
    url.searchParams.set("limit", String(limit));

    const body = await request(url.toString(), "listing");
    if (!Array.isArray(body?.data)) {
      throw new Error("Core snapshot listing returned an invalid response");
    }
    return Object.freeze(body.data.map((item) => validateMetadata(item, serverId)));
  }

  async function get(snapshotId) {
    requiredString(snapshotId, "snapshotId");
    const body = await request(`${basePath}/${encodeURIComponent(snapshotId)}`, "read");
    if (!body?.data || typeof body.data !== "object" || Array.isArray(body.data)) {
      throw new Error("Core snapshot read returned an invalid response");
    }
    return validateSnapshot(body.data, serverId);
  }

  return Object.freeze({ list, get });
}
