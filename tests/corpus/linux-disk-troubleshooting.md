# Freeing disk space on Linux

vendor: Red Hat
product: RHEL
version: "9"
doc_type: vendor_doc
visibility: global

## Finding what is full

Start with `df -h` to see which filesystem is full. Then drill down with
`du -sh /var/* 2>/dev/null | sort -h` to find the largest directories. The
usual suspects are `/var/log`, container layers under `/var/lib`, and old
package caches.

## Common cleanups

- Vacuum the journal: `journalctl --vacuum-size=200M` or
  `journalctl --vacuum-time=7d`.
- Clean the package cache: `dnf clean all` (RHEL) or `apt-get clean` (Debian).
- Remove old kernels you no longer boot.
- Look for deleted-but-open files holding space: `lsof +L1`.

## Inodes

If `df -h` shows free space but writes still fail, check inode exhaustion with
`df -i`. Millions of tiny files in one directory can exhaust inodes even with
bytes to spare.
