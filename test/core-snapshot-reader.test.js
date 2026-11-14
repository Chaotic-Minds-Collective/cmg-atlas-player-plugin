import test from "node:test";
import assert from "node:assert/strict";
import { createCoreSnapshotReader } from "../src/core-snapshot-reader.js";

const serverId = "00000000-0000-4000-8000-000000000001";
const clusterId = "00000000-0000-4000-8000-000000000002";
const token = "cg_srv_test_reader_token";
const metadata = {
  snapshotId: "snapshot-1",
  kind: "inventory",
  assetId: "character-1",
  ownerId: "steam-1",
  gridId: "A1",
  capturedAt: "2026-11-14T20:00:00.000Z",
  stateBytes: 32,
  reason: "scheduled"
};
const fullSnapshot = {
  ...metadata,
  clusterId,
  serverId,
  state: { slots: [{ itemId: "item-1", quantity: 2 }] }
};

function response(data, status = 200) {
  return { status, async json() { return { data, requestId: "request-1" }; } };
}

function reader(fetchImpl, options = {}) {
  return createCoreSnapshotReader({
    coreOrigin: "https://core.example.test",
    serverId,
    serviceToken: token,
    fetchImpl,
    ...options
  });
}

test("lists metadata using fixed server scope and encoded filters", async () => {
  let called;
  const client = reader(async (url, options) => {
    called = { url: new URL(url), options };
    return response([metadata]);
  });
  const result = await client.list({
    kind: "inventory",
    assetId: "character/1",
    ownerId: "steam 1",
    limit: 10
  });

  assert.equal(called.url.pathname, `/integrations/servers/${serverId}/recovery/snapshots`);
  assert.equal(called.url.searchParams.get("kind"), "inventory");
  assert.equal(called.url.searchParams.get("assetId"), "character/1");
  assert.equal(called.url.searchParams.get("ownerId"), "steam 1");
  assert.equal(called.url.searchParams.get("limit"), "10");
  assert.equal(called.options.method, "GET");
  assert.equal(called.options.redirect, "manual");
  assert.equal(called.options.cache, "no-store");
  assert.equal(called.options.headers.authorization, `Bearer ${token}`);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].scope, { serverId, gridId: "A1" });
  assert.equal("state" in result[0], false);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result[0]), true);
});

test("lists without filters and applies the bounded default limit", async () => {
  let requested;
  const client = reader(async (url) => {
    requested = new URL(url);
    return response([]);
  });
  assert.deepEqual(await client.list(), []);
  assert.equal(requested.searchParams.get("limit"), "25");
  assert.equal(requested.searchParams.has("kind"), false);
});

test("reads full state and verifies returned server and cluster scope", async () => {
  let requested;
  const client = reader(async (url) => {
    requested = new URL(url);
    return response(fullSnapshot);
  });
  const result = await client.get("snapshot/1");
  assert.equal(requested.pathname.endsWith("/snapshot%2F1"), true);
  assert.deepEqual(result.scope, { clusterId, gridId: "A1", serverId });
  assert.deepEqual(result.state, fullSnapshot.state);
  assert.equal(Object.isFrozen(result.state.slots[0]), true);
});

test("rejects a snapshot returned for another server", async () => {
  const client = reader(async () => response({ ...fullSnapshot, serverId: "other-server" }));
  await assert.rejects(client.get("snapshot-1"), /different server scope/);
});

test("rejects malformed cluster scope and state", async () => {
  const badCluster = reader(async () => response({ ...fullSnapshot, clusterId: "" }));
  await assert.rejects(badCluster.get("snapshot-1"), /cluster scope/);
  const badState = reader(async () => response({ ...fullSnapshot, state: [] }));
  await assert.rejects(badState.get("snapshot-1"), /invalid state/);
});

test("rejects malformed list responses and metadata", async () => {
  const badList = reader(async () => response({ items: [] }));
  await assert.rejects(badList.list(), /invalid response/);
  const badItem = reader(async () => response([{ ...metadata, stateBytes: -1 }]));
  await assert.rejects(badItem.list(), /invalid state size/);
});

test("rejects invalid configuration and query filters before network access", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response([]); };
  assert.throws(() => createCoreSnapshotReader({
    coreOrigin: "http://core.example.test", serverId, serviceToken: token, fetchImpl
  }), /HTTPS origin/);
  assert.throws(() => reader(fetchImpl, { timeoutMs: 30_001 }), /timeoutMs/);
  const client = reader(fetchImpl);
  await assert.rejects(client.list({ kind: "unknown" }), /kind must be/);
  await assert.rejects(client.list({ limit: 101 }), /limit must be/);
  await assert.rejects(client.list({ assetId: " " }), /assetId/);
  await assert.rejects(client.get(" "), /snapshotId/);
  assert.equal(calls, 0);
});

test("surfaces HTTP failures without reading or exposing response content", async () => {
  const client = reader(async () => ({ status: 403, async json() { throw new Error(token); } }));
  await assert.rejects(client.list(), /HTTP 403/);
});

test("does not follow redirects", async () => {
  let options;
  const client = reader(async (_url, requestOptions) => {
    options = requestOptions;
    return response([], 302);
  });
  await assert.rejects(client.list(), /HTTP 302/);
  assert.equal(options.redirect, "manual");
});

test("sanitizes transport failures while retaining the cause", async () => {
  const client = reader(async () => { throw new Error(`failed with ${token}`); });
  await assert.rejects(client.list(), (error) => {
    assert.equal(error.message, "Core snapshot listing request failed");
    assert.equal(error.message.includes(token), false);
    assert.match(error.cause.message, /cg_srv_test_reader_token/);
    return true;
  });
});

test("rejects invalid JSON responses", async () => {
  const client = reader(async () => ({ status: 200, async json() { throw new SyntaxError("bad json"); } }));
  await assert.rejects(client.list(), /invalid JSON/);
});
