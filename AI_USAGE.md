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

## Decisions I made or explicitly approved

- **Architecture decisions are recorded in `docs/adr/`** (ADR-0001 to ADR-0005).
- **No `registeredAt` in the `shipment.registered` payload** – the registration time is the envelope's `occurredAt`, so the same fact is not stored twice.
- **Public repository** – this is a personal learning project.

## How I verify AI output

- Run `pnpm typecheck` and `pnpm test` after every change.
- Make sure a test can fail: break the rule on purpose and check that the right test fails.
- Rejection tests assert which field failed, not only that validation failed.
- Review documentation against the code; JSON examples in `EVENTS.md` were validated against `LogisticsEventSchema`.
- Review changes in the real repository, not in pasted snippets.
- Mutation testing: a test suite is trusted only if deliberately broken implementations make it fail.