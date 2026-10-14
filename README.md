# mongo-s3-mysql

Archive MongoDB (4.4+) or DocumentDB (5.0+) collections to S3 as gzipped Extended JSON with manifests, then load them into your own MySQL tables. Resumable, idempotent, reconcilable.

- Built after retiring a production DocumentDB fleet whose history had to outlive it ([background](docs/background.md)).
- Writes the same S3 layout as that fleet's exporter, so its archives verify and load unchanged.

## Getting started

**1. Prepare the surroundings**
- An S3 bucket and an identity with [`docs/iam-policy.json`](docs/iam-policy.json) attached (it grants no delete).
- MySQL 8.0.19+ as the target; MongoDB 4.4+ or DocumentDB 5.0+ as the source.

**2. Install and create the config**

```bash
npm install -g mongo-s3-mysql     # Node.js 22.12+
mongo-s3-mysql init               # writes mongo-s3-mysql.config.json with an empty collection list
```

**3. Edit `mongo-s3-mysql.config.json`**

Set `mongo.database`, `s3.bucket`, `s3.prefix` and `s3.partition`, and the `mysql` host, user and database ([configuration](docs/configuration.md)). TLS to MySQL is on by default and checks the server against Node.js's bundled CA list, not the OS trust store; set `mysql.caFile` (or `NODE_EXTRA_CA_CERTS`) to your server's CA bundle for a private CA such as RDS's, or `"tls": "off"` for a local server. Secrets never go in the file.

**4. Put the secrets in the environment**

```bash
export MSM_MONGO_URI='mongodb://user:password@host:27017/?tls=true'
export MSM_MYSQL_PASSWORD='...'   # AWS credentials: the default chain
```

**5. Let inventory fill the collection list**

```bash
mongo-s3-mysql inventory --write-config    # --force replaces a list you already have
```

**6. Export, verify, map, load, reconcile**

```bash
mongo-s3-mysql export --dry-run       # the chunk plan; writes nothing
mongo-s3-mysql export                 # one batch; --batch-id <id> resumes it
mongo-s3-mysql verify                 # reads every chunk not yet verified for its current manifest (--all re-reads them all)
mongo-s3-mysql infer                  # writes a mapping per collection to review
mongo-s3-mysql load --create-tables   # upserts into your tables, resumable per chunk
mongo-s3-mysql reconcile              # proves the tables hold the archive
```

## Commands

```bash
mongo-s3-mysql init        [--force]
mongo-s3-mysql inventory   [--all] [--sample <n>] [--write-config [--force]]
mongo-s3-mysql export      [--batch-id <id>] [--since <iso|last>] [--cutoff <iso>] [--include-rest] [--dry-run]
mongo-s3-mysql verify      [--batch-id <id,...>] [--all] [--no-write] [--dry-run]
mongo-s3-mysql infer       [--batch-id <id>] [--out <dir>] [--key-column <c>] [--child-tables] [--force] ...
mongo-s3-mysql load        [--batch-id <id,...>] [--create-tables] [--reload] [--dry-run] ...
mongo-s3-mysql reconcile   [--batch-id <id,...>] [--deep] [--show-ok] [--ignore <kind,...>]
```

- `-c <path>`: another config file. `-C a,b`: only these collections. `-y`: skip prompts. `--json`: JSON result on stdout. `--log-format json`: events on stderr as JSON lines (for journald or a log shipper). `--force-unlock`: replace a lock left by a process that is gone.
- Exit codes: 0 done, 1 error, 2 incomplete, 3 invalid archive, 4 drift, 130/143 interrupted ([the table](docs/operations.md#exit-codes)).

## Documentation

- [Background](docs/background.md): why it exists, the invariants
- [How it works](docs/how-it-works.md): pipeline, S3 layout, chunk modes, deltas
- [Configuration](docs/configuration.md) and [mapping files](docs/mapping.md)
- [Operations](docs/operations.md): systemd, sizing, signals, exit codes, triage, IAM
- [Reconcile](docs/reconcile.md): drift kinds, coverage proof, repair
- [Use case](docs/use-case.md), [acceptance](docs/acceptance.md), [DocumentDB notes](docs/documentdb.md)
- [Limitations](docs/limitations.md), [library](docs/library.md), [development](docs/development.md)

## License

MIT
