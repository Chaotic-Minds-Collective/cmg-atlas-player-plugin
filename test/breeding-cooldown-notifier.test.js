import test from "node:test";
import assert from "node:assert/strict";
import { createBreedingCooldownNotifier } from "../src/breeding-cooldown-notifier.js";

function makeCooldown(overrides = {}) {
  return {
    cooldownId: "cooldown-1",
    tameId: "tame-7",
    ownerId: "player-42",
    tameName: "Argentavis",
    expiresAt: "2026-11-15T00:00:00.000Z",
    leaseToken: "lease-1",
    ...overrides
  };
}

function makeStore(records = [makeCooldown()]) {
  const calls = { claims: [], notified: [], released: [] };
  return {
    calls,
    claimExpired: async (input) => {
      calls.claims.push(input);
      return records;
    },
    markNotified: async (input) => calls.notified.push(input),
    releaseClaim: async (input) => calls.released.push(input)
  };
}

test("notifies the tame owner with a stable idempotency key and records receipt", async () => {
  const store = makeStore();
  const messages = [];
  const notifier = createBreedingCooldownNotifier({
    store,
    clock: () => new Date("2026-11-15T00:00:01.000Z"),
    sendMessage: async (message) => {
      messages.push(message);
      return { receipt: "chat-receipt-1" };
    }
  });

  const result = await notifier.processExpired();

  assert.deepEqual(result, { claimed: 1, notified: 1, failed: 0 });
  assert.equal(messages[0].recipientId, "player-42");
  assert.match(messages[0].message, /Argentavis is ready to breed again/);
  assert.equal(messages[0].idempotencyKey, "cmg:breeding-ready:v1:cooldown-1");
  assert.equal(store.calls.notified[0].deliveryReceipt, "chat-receipt-1");
  assert.equal(store.calls.notified[0].leaseToken, "lease-1");
  assert.equal(store.calls.released.length, 0);
});

test("uses tame ID when no display name is available", async () => {
  const store = makeStore([makeCooldown({ tameName: undefined })]);
  let message;
  const notifier = createBreedingCooldownNotifier({
    store,
    sendMessage: async (input) => {
      message = input.message;
      return { receipt: "receipt" };
    }
  });

  await notifier.processExpired();
  assert.match(message, /tame-7 is ready to breed again/);
});

test("releases a claim when message delivery fails", async () => {
  const store = makeStore();
  const notifier = createBreedingCooldownNotifier({
    store,
    sendMessage: async () => {
      throw new Error("chat unavailable");
    }
  });

  const result = await notifier.processExpired();

  assert.deepEqual(result, { claimed: 1, notified: 0, failed: 1 });
  assert.deepEqual(store.calls.released, [{
    cooldownId: "cooldown-1",
    leaseToken: "lease-1"
  }]);
  assert.equal(store.calls.notified.length, 0);
});

test("does not acknowledge a delivery without a receipt", async () => {
  const store = makeStore();
  const notifier = createBreedingCooldownNotifier({
    store,
    sendMessage: async () => ({})
  });

  const result = await notifier.processExpired();

  assert.equal(result.failed, 1);
  assert.equal(store.calls.notified.length, 0);
  assert.equal(store.calls.released.length, 1);
});

test("continues processing other owners when one delivery fails", async () => {
  const store = makeStore([
    makeCooldown(),
    makeCooldown({
      cooldownId: "cooldown-2",
      tameId: "tame-8",
      ownerId: "player-99",
      leaseToken: "lease-2"
    })
  ]);
  const recipients = [];
  const notifier = createBreedingCooldownNotifier({
    store,
    sendMessage: async ({ recipientId }) => {
      recipients.push(recipientId);
      if (recipientId === "player-42") throw new Error("temporary failure");
      return { receipt: "receipt-2" };
    }
  });

  const result = await notifier.processExpired();

  assert.deepEqual(result, { claimed: 2, notified: 1, failed: 1 });
  assert.deepEqual(recipients, ["player-42", "player-99"]);
  assert.equal(store.calls.released.length, 1);
  assert.equal(store.calls.notified.length, 1);
});

test("passes bounded lease and batch settings to the store", async () => {
  const store = makeStore([]);
  const notifier = createBreedingCooldownNotifier({
    store,
    leaseMs: 45_000,
    batchSize: 20,
    sendMessage: async () => ({ receipt: "unused" })
  });

  await notifier.processExpired();

  assert.equal(store.calls.claims[0].leaseMs, 45_000);
  assert.equal(store.calls.claims[0].limit, 20);
  assert.equal(store.calls.claims[0].now, "2026-11-14T00:00:00.000Z");
});

test("rejects invalid configuration and malformed claimed cooldowns", async () => {
  const store = makeStore();

  assert.throws(() => createBreedingCooldownNotifier({
    store,
    leaseMs: 10,
    sendMessage: async () => ({ receipt: "x" })
  }), /leaseMs/);

  const notifier = createBreedingCooldownNotifier({
    store: makeStore([{ cooldownId: "bad" }]),
    sendMessage: async () => ({ receipt: "x" })
  });
  await assert.rejects(notifier.processExpired(), /tameId/);
});

test("requires the store to provide atomic claim, acknowledgement, and release operations", () => {
  assert.throws(() => createBreedingCooldownNotifier({
    store: {},
    sendMessage: async () => ({ receipt: "x" })
  }), /store.claimExpired/);
});
