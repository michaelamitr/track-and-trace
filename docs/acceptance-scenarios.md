# Acceptance Scenarios

- **AC-01** Normal journey: final status `DELIVERED` and a complete history.
- **AC-02** Duplicate scan: one logical record, no duplicate action. Implemented by: [R1](tracking-projection.md#projection-rules).
- **AC-03** Out-of-order scans: correct final status and chronological history. Implemented by: [R2 and R6](tracking-projection.md#projection-rules).
- **AC-04** Tracking restart: messages received during the outage are processed.
- **AC-05** Tracking database lost: state is rebuilt by event replay.
- **AC-06** Broker down during registration: the registration event is reliably published after recovery.
- **AC-07** Broker unavailable when a scan arrives: error response and a safe retry.
- **AC-08** SLA deadline missed: exactly one incident and one notification.
- **AC-09** On-time delivery: no unjustified incident.
- **AC-10** Invalid event: safely captured in a traceable quarantine.
- **AC-11** Scan before the shipment is registered: the scan is not lost and is evaluated after registration.
- **AC-12** Same `eventId` with a different payload: the conflict is detected and the projection is not corrupted.
- **AC-13** Restart with volumes kept: data is preserved and processing continues.
