# Case lesson: backup agent high CPU — Cliente A (PRIVATE)

vendor: null
product: null
doc_type: case_lesson
visibility: private
tenant: golden_a

## What happened

On host NTVeemLAB the Veeam backup agent (Veeam.Backup.Manager) drove CPU to
~90% during the day, degrading the application running on the same VM. The
incident was initially misclassified as an application performance problem.

## What we learned

- Backup jobs were scheduled inside business hours. Move the backup window
  outside peak load.
- Apply a CPU throttle / resource limit to the backup agent so a runaway job
  cannot starve the application.
- Add a monitoring rule: alert when Veeam.Backup.Manager sustains >60% CPU for
  more than 15 minutes so we catch it before users do.

## How to apply next time

If a resolved case shows high CPU from a backup process, check the backup
schedule and throttle settings first before touching the application.
