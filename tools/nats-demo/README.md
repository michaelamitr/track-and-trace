# @tt/nats-demo

Learning tool for observing NATS JetStream behavior by hand. Not production code.

1. Start NATS: `pnpm infra:up` (from the repo root).
2. Create the stream and the durable consumers: `pnpm nats:setup` (from the repo root). Run this first;
   `demo:publish` and `demo:consume` only verify that they exist and exit with an error otherwise.
3. Publish one `parcel.delivered` event: `pnpm --filter @tt/nats-demo demo:publish`
   Running it twice publishes the same eventId (expect `duplicate=true`); set `EVENT_ID=<uuid v4>` for a new one.
4. Consume: `MODE=ok|fail|hang pnpm --filter @tt/nats-demo demo:consume`
   `ok` acks, `fail` naks (immediate redelivery), `hang` never acks: Ctrl+C, restart with `MODE=ok`, and the event comes back once `ack_wait` (30 s) has passed. Stop with Ctrl+C.
