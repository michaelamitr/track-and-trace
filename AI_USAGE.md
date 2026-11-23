# AI Usage Log

This project is built with AI assistance, which the assignment allows and expects.
This log records how AI was used, where it was wrong, and how I verified its output.

## Tools

| Tool | Used for |
|---|---|
| Claude (Anthropic), in a claude.ai project | Step-by-step guidance, explanations of backend concepts, drafts of configuration, schemas, tests and documentation, review of my changes |
| Claude Code (Anthropic), in my local repository | Generating tests and code from rules I approved |

## Parts generated or substantially shaped by AI

| Area | What AI did | What I did |
|---|---|---|
| Monorepo setup (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`) | Proposed the structure and configuration | Created the files, reviewed every option, cleaned up generated fields |
| `packages/contracts` schemas (`subjects.ts`, `envelope.ts`, `payloads.ts`, `events.ts`) | Drafted the Zod schemas from the assignment | Reviewed the design, decided on payload fields (see decisions below) |
| `packages/contracts` tests | Drafted most of the tests | Wrote my own tests (non-positive `eventVersion`, unknown `eventType`), required `path` checks in all rejection tests |
| `EVENTS.md` | Generated the event catalog | Reviewed it against the code |
| Tracking projection (`project()`, its tests, `docs/tracking-projection.md`) | Wrote the tests, the implementation and the docs draft | Decided the rules R1–R6, reviewed the diffs |
| Shipment Service (migrations, registration, transactional outbox and relay, HTTP API, tests) | Wrote the tests, the implementation and drafts of ADR-0007 to ADR-0009 and `docs/shipment-api.md` | Decided the API contract, idempotency rules, the outbox and `correlationId = shipmentId`; reviewed the diffs; tested it manually, including a NATS outage |
| Scan Ingestion Service (API, publishing, tests) | Wrote the tests, the implementation and drafts of ADR-0010 and `docs/scan-ingestion-api.md` | Decided the API contract and publishing without `Nats-Msg-Id`; reviewed the diffs; tested it manually, including a NATS outage (AC-07) |

## Cases where AI was wrong or incomplete

### 1. Rejection tests that could pass for the wrong reason

- **What AI proposed:** tests for the event envelope that only checked `success === false`. Such a test passes whenever *anything* is invalid, so a mistake in the test fixture would make every rejection test pass without testing its rule.
- **How I noticed:** AI suggested adding a check of the failing field (`issues[0].path`) only to the test I wrote myself. I asked why the same check was missing in the tests it had written.
- **Fix:** every rejection test now also asserts which field failed, e.g. `expect(result.error?.issues[0]?.path).toEqual(['eventVersion'])`.
- **Verification:** all tests pass, and I broke a schema rule on purpose to see that the test fails and reports the expected field.

### 2. A claim about the repository based on a pasted snippet

- **What AI claimed:** that I had pushed a test with a leftover `console.log`, based on the code I had pasted into the chat.
- **How I noticed:** I knew I had removed it before committing, so I disagreed and asked AI to check the actual repository.
- **Fix:** AI checked the repository on GitHub and confirmed there was no `console.log`. Since then, my work is always reviewed against the real repository, not against snippets or screenshots.
- **Verification:** `git log` and the file contents on GitHub.

### 3. Green tests that missed bugs

- **What AI proposed:** projection tests that all passed but could not detect some broken implementations: a tie-break test with random IDs (caught a bug only in about half of the runs), fixtures where `receivedAt` equaled `occurredAt` (swapping the two times went unnoticed), and no test that catches `localeCompare` instead of code-unit comparison of `eventId`s.
- **How it was noticed:** mutation testing – running deliberately broken versions of `project()` against the tests.
- **Fix:** fixed IDs, different `receivedAt` and `occurredAt` in fixtures, a test with uppercase letters in a UUID.
- **Verification:** each of 30+ broken versions now fails at least one test.

### 4. An architecture decision I had not approved

- **What AI did:** ADR-0006 stated that every service creates the NATS stream and consumers on start. AI made that choice itself and recorded it as accepted.
- **How I noticed:** I did not remember approving it and asked for the alternatives.
- **Fix:** we compared the options; I chose a setup step with a startup check (fail fast); ADR-0006 was amended.
- **Verification:** ADR-0006 and `setup.int.test.ts`.

### 5. An action on my local environment that I had not asked for

- **What AI did:** while implementing the Scan Ingestion Service, Claude Code ran
  `pnpm nats:setup` against my local Docker NATS and published a test `parcel.delivered` event
  into the `LOGISTICS_EVENTS` stream, for a shipment that does not exist. The prompt asked only
  for tests with Testcontainers.
- **How I noticed:** Claude Code mentioned it at the end of its summary, and during my manual
  test the stream contained an unexpected `parcel.delivered` event (sequence 5, published on
  2026-11-16 at 20:41 UTC, during that session).
- **Fix:** every prompt for Claude Code now says not to run commands against my local Docker
  infrastructure. The event exists only in my local development stream; I decide whether to
  remove it before the Tracking Service starts reading the stream.
- **Verification:** `nats stream view LOGISTICS_EVENTS` – no other unexpected events.

## Decisions I made or explicitly approved

- **Architecture decisions are recorded in `docs/adr/`** (see the index in [docs/adr/README.md](docs/adr/README.md)).
- **No `registeredAt` in the `shipment.registered` payload** – the registration time is the envelope's `occurredAt`, so the same fact is not stored twice.
- **Public repository** – this is a personal learning project.
- **Shared database helpers (`@tt/db`)** – my idea after reviewing `apps/shipment-service/src/db/transaction.ts`; the pool, transaction and migration helpers were moved to the shared package in lesson 2.4.
- **Scan events are published without `Nats-Msg-Id`** ([ADR-0010](docs/adr/0010-scan-ingestion-publishing.md))
  – AI first recommended deduplicating scans in JetStream with a fingerprint of their content.
  I asked whether the stream should rather keep every accepted scan; that showed that
  deduplication in the broker would hide the consumers' deduplication in the demo (AC-02).
  I chose to publish scans without it.

## How I verify AI output

- Run `pnpm typecheck` and `pnpm test` after every change.
- Make sure a test can fail: break the rule on purpose and check that the right test fails.
- Rejection tests assert which field failed, not only that validation failed.
- Review documentation against the code; JSON examples in `EVENTS.md` were validated against `LogisticsEventSchema`.
- Review changes in the real repository, not in pasted snippets.
- Mutation testing: a test suite is trusted only if deliberately broken implementations make it fail.
- Every ADR records a decision I explicitly approved.
- Test failure scenarios by hand, not only with automated tests: stopping NATS while the Shipment Service was running showed that the service cannot start without NATS and that shutdown fails when NATS is down – neither was caught by the tests.