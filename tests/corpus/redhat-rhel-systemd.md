# Managing services with systemd on RHEL 9

vendor: Red Hat
product: RHEL
version: "9"
doc_type: vendor_doc
visibility: global

## Checking service status

To check whether a service is running, use `systemctl status <name>`. For a
quick machine-readable answer use `systemctl is-active <name>` which prints
`active`, `inactive` or `failed`. To see if a unit is enabled at boot use
`systemctl is-enabled <name>`.

## Starting, stopping and restarting

- `systemctl start <name>` starts the service now.
- `systemctl stop <name>` stops it.
- `systemctl restart <name>` restarts it (stop + start). Use this after a
  configuration change.
- `systemctl reload <name>` re-reads config without a full restart when the
  unit supports it.

## Enabling at boot

`systemctl enable <name>` creates the symlinks so the service starts on boot.
Use `systemctl enable --now <name>` to enable and start in one step.
`systemctl disable <name>` reverses it.

## Inspecting logs

Service logs are in the journal: `journalctl -u <name>` shows the unit's log,
add `-f` to follow and `--since "10 min ago"` to bound the window.
