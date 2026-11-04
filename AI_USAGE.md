# AI Usage Log

This project is built with AI assistance, which the assignment allows and expects.
This log records how AI was used, where it was wrong, and how I verified its output.

## Tools

| Tool | Used for |
|---|---|
| Claude (Anthropic), in a claude.ai project | Step-by-step guidance, explanations of backend concepts, drafts of configuration, schemas, tests and documentation, review of my changes |

## Parts generated or substantially shaped by AI

| Area | What AI did | What I did |
|---|---|---|
| Monorepo setup (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`) | Proposed the structure and configuration | Created the files, reviewed every option, cleaned up generated fields |
| `packages/contracts` schemas (`subjects.ts`, `envelope.ts`, `payloads.ts`, `events.ts`) | Drafted the Zod schemas from the assignment | Reviewed the design, decided on payload fields (see decisions below) |
| `packages/contracts` tests | Drafted most of the tests | Wrote my own tests (non-positive `eventVersion`, unknown `eventType`), required `path` checks in all rejection tests |
| `EVENTS.md` | Generated the event catalog | Reviewed it against the code |

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

### Minor

- AI added a Czech comment to test code although the project convention is English code. Fixed.

## Decisions I made or explicitly approved

- **pnpm workspaces monorepo** with a shared `@tt/contracts` package that contains only contracts (subjects, schemas, types), no business logic.
- **Zod** for runtime validation of events; consumers will use `safeParse` so that an invalid message does not crash a service.
- **Notification subscribes to `shipment.registered`** and keeps its own copy of `recipientId`. Rejected alternative: adding `recipientId` to `parcel.delivered` and `sla.breached`, because Scan Ingestion does not know the recipient (it has no database and must not call the Shipment Service).
- **No `registeredAt` in the `shipment.registered` payload** – the registration time is the envelope's `occurredAt`, so the same fact is not stored twice.
- **`eventType` is part of the event**, not only of the NATS subject, so that a stored event stays self-describing.
- **Version 1 schemas pin `eventVersion` and `producer`** for each event type.
- **Public repository** – this is a personal learning project.

## How I verify AI output

- Run `pnpm typecheck` and `pnpm test` after every change.
- Make sure a test can fail: break the rule on purpose and check that the right test fails.
- Rejection tests assert which field failed, not only that validation failed.
- Review documentation against the code; JSON examples in `EVENTS.md` were validated against `LogisticsEventSchema`.
- Review changes in the real repository, not in pasted snippets.