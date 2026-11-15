# Breeding cooldown expiry notifications

## Purpose

Notify a tame's owner once its 30-minute coloring-related breeding restriction has ended. This module is provider-neutral: it does not call an ATLAS command, game SDK, or chat API.

## Runtime contract

Create the worker with:

- `store.claimExpired({ now, leaseMs, limit })`: atomically lease due, unnotified cooldown records and return records containing `cooldownId`, `tameId`, `ownerId`, optional `tameName`, `expiresAt`, and `leaseToken`.
- `store.markNotified({ cooldownId, leaseToken, notifiedAt, deliveryReceipt, idempotencyKey })`: atomically acknowledge a delivered notification for the matching lease.
- `store.releaseClaim({ cooldownId, leaseToken })`: release a claim after delivery or acknowledgement failure; if release fails, the lease must expire naturally.
- `sendMessage({ recipientId, message, metadata, idempotencyKey })`: deliver a private server message to the owner and return a non-empty `{ receipt }`.
- Optional `clock()`: return a Date or timestamp. The host controls scheduling and should invoke `processExpired()` periodically.

The store must exclude already-notified records, enforce lease ownership, and use durable persistence. The message adapter must honor the stable idempotency key (`cmg:breeding-ready:v1:<cooldownId>`) so a retry after a worker crash cannot create a duplicate message. If the eventual ATLAS messaging provider cannot deduplicate deliveries, exactly-once chat delivery cannot be guaranteed; the provider integration must document its actual delivery semantics.

## Message

The default owner message is:

> Your tame <name> is ready to breed again! The 30-minute coloring cooldown has ended, and breeding is available.

The tame name falls back to its stable tame ID. Delivery is addressed to the recorded owner ID, not a display name.

## Restart and scheduling behavior

The worker contains no in-memory timer and does not own persistence. The host should poll it on a bounded interval (for example, every 15–30 seconds). Expired cooldowns remain eligible after restart because the store owns expiry and notification state. Atomic claims prevent concurrent workers from processing the same record at the same time. Durable acknowledgement plus provider idempotency protects retries.

A cooldown should be created by the color workflow after a successful tame color application, with `expiresAt = successfulColorChangeAt + 30 minutes`. This notification worker does not create, extend, or shorten cooldowns.

## Safety boundary

No native ATLAS chat callback, player lookup API, or game command is assumed. The real server adapter must be implemented and verified against the exact server build and loader before enabling player-facing delivery. No live-server changes are included.
