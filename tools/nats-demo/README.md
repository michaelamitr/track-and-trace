# @tt/nats-demo

Learning tool for observing NATS JetStream behavior by hand. Not production code.

1. Start NATS: `pnpm infra:up` (from the repo root).
2. Create the stream and the `tracking` consumer: `pnpm --filter @tt/nats-demo demo:setup`
3. Publish one `parcel.delivered` event: `pnpm --filter @tt/nats-demo demo:publish`
   Running it twice publishes the same eventId (expect `duplicate=true`); set `EVENT_ID=<uuid v4>` for a new one.
4. Consume: `MODE=ok|fail|hang pnpm --filter @tt/nats-demo demo:consume`
   `ok` acks, `fail` naks (immediate redelivery), `hang` never acks: Ctrl+C, restart with `MODE=ok`, and the event comes back once `ack_wait` (30 s) has passed. Stop with Ctrl+C.
