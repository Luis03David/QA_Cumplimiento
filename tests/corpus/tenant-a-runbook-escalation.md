# Runbook: incident escalation — Cliente A (PRIVATE)

vendor: null
product: null
doc_type: runbook
visibility: private
tenant: golden_a

## Severity and escalation path

- **P1 (Critical):** service down, revenue impact. Page the on-call engineer
  immediately via the primary rotation. If unacknowledged in 10 minutes,
  escalate to the shift lead, then to the account manager for Cliente A.
- **P2 (High):** degraded but working. Notify on-call within business hours.
- **P3/P4:** queue for the next working day.

The P1 on-call rotation for Cliente A is held by the platform team; the
current primary and secondary are listed in the on-call schedule.

## Approved maintenance window

The approved maintenance window (ventana de mantenimiento) for Cliente A is
**Sundays 02:00–05:00 local time**. Any change outside this window needs
written approval from the Cliente A change board before execution.

## Contacts

Escalation contacts and phone numbers for Cliente A are stored in Vault under
the tenant's secret path — never paste them into chat or tickets.
