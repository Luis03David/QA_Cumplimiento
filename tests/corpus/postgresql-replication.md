# PostgreSQL streaming replication

vendor: PostgreSQL
product: PostgreSQL
version: "16"
doc_type: vendor_doc
visibility: global

## Primary configuration

On the primary, set in `postgresql.conf`:

```
wal_level = replica
max_wal_senders = 10
wal_keep_size = 512MB
```

Create a replication role: `CREATE ROLE replicator WITH REPLICATION LOGIN
PASSWORD '...';` and allow it in `pg_hba.conf` with a `replication` entry for
the standby's address.

## Standby configuration

Take a base backup with `pg_basebackup -h primary -U replicator -D
/var/lib/pgsql/data -R`. The `-R` flag writes `standby.signal` and sets
`primary_conninfo` automatically so the standby streams WAL from the primary.

## Monitoring lag

On the primary, `SELECT * FROM pg_stat_replication;` shows connected standbys
and their replay lag. On the standby, compare
`pg_last_wal_receive_lsn()` with `pg_last_wal_replay_lsn()`.
