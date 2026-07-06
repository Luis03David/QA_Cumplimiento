# Configuring networking on Ubuntu Server 22.04 with netplan

vendor: Canonical
product: Ubuntu Server
version: "22.04"
doc_type: vendor_doc
visibility: global

## netplan basics

Ubuntu Server uses netplan for network configuration. Config files live in
`/etc/netplan/` as YAML (for example `/etc/netplan/00-installer-config.yaml`).
After editing, apply with `sudo netplan apply`. Use `sudo netplan try` to test
a change with automatic rollback if you lose connectivity.

## Static IP example

```yaml
network:
  version: 2
  ethernets:
    eth0:
      dhcp4: false
      addresses: [10.200.20.50/24]
      routes:
        - to: default
          via: 10.200.20.1
      nameservers:
        addresses: [1.1.1.1, 8.8.8.8]
```

## Verifying

Use `ip addr show` to confirm the address is assigned and `ip route` to check
the default gateway. `resolvectl status` shows the active DNS servers.
