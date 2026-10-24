# DuckBI · give DeepSeek Harness a sense of numbers

[中文](README.md) | **English**

Turn **folders of logs** and **Excel ledgers** on disk into a queryable warehouse you can talk to.
DuckDB stores and computes; Harness understands what you actually want.

- **Point at a folder (or one file) and go** — `.log` / `.csv` / `.json` / `.jsonl` / `.parquet` /
  `.xlsx` (multi-sheet workbooks become one table per sheet), gzip/zstd compressed files, and GB18030
  Chinese encoding handled automatically.
- **Ask in chat** — the model writes SQL, looks at the result, and iterates. A read-only gate blocks
  DDL/DML.
- **Tables and charts appear in the conversation** — results render as Markdown tables; charts are
  server-rendered PNGs, embedded inline when an attachment service is available.
- **One-command export** — `xlsx` (styling, frozen panes, autofilter, info sheet), `pdf`
  (A4 landscape, repeating headers, embedded CJK fonts), `csv` / `parquet` / `json`.
- **Rich reports in one call** — `duckbi_export`'s `sections` render KPI cards, tables, charts and
  narrative into one multi-section PDF plus a multi-sheet workbook.
- **Cheaper conversations** — catalog/scan output is aggregated by default (`detail: true` expands
  it), schema supports name search, and a rich report costs one tool round trip.

Five registered tools: `duckbi_source` (manage folders), `duckbi_schema` (inspect structure),
`duckbi_query` (run SQL), `duckbi_chart` (draw), `duckbi_export` (produce files).

---

## Install

Repository: <https://github.com/don2ccc/DuckBI-DSH>

### Requirements

- A DeepSeek Harness that can load plugins (desktop app or the `dsh` CLI), with an existing profile
  (starting it once is enough).
- Node.js ≥ 20 (only for installing and running scripts; the plugin runs on the Node bundled with
  Harness).
- The plugin imports **no** `@deepseek-ai/*` internal modules — it only uses the `ctx.tools` service —
  so it is not tied to a specific Harness patch version.
- The first `.xlsx` read installs DuckDB's `excel` extension, which needs **network access once**
  (offline afterwards; the extension lives in the data directory).

### Option A: clone from GitHub (recommended)

```bash
git clone https://github.com/don2ccc/DuckBI-DSH.git
cd DuckBI-DSH/packages/dsh-plugin-duckbi
npm install            # pulls native binaries for the current platform
node install.mjs       # link into the profile + write the config
```

No git? Download the ZIP (Code → Download ZIP) and continue from the `cd` line.

### Option B: a `.tgz` package (from a colleague, or build your own)

```bash
# 1) install into a profile (dependencies come along)
dsh plugin --profile desktop add ./duckbi-dsh-plugin-duckbi-0.2.0.tgz

# 2) write the config (the package is already in node_modules, so --no-link skips the symlink)
node <profile>/node_modules/@duckbi/dsh-plugin-duckbi/install.mjs --no-link
```

### Option C: copy the folder (offline / air-gapped)

Copy the whole `packages/dsh-plugin-duckbi/` directory over (**excluding** `node_modules`):

```bash
cd dsh-plugin-duckbi
npm install            # pulls the native binaries for the current platform
node install.mjs       # link into the profile + write the config
```

> **Never copy `node_modules` across platforms**: `@duckdb/node-bindings-*` and
> `@napi-rs/canvas-*` are platform-specific native packages (~74 MB on win32-x64). Let npm install
> them on the target machine so the right binaries are chosen.

### Installer flags

| Flag | Effect |
| --- | --- |
| `--profile <name>` | which profile to install into (defaults to `DSH_PROFILE`, else `desktop`) |
| `--home <dir>` | Harness home (defaults to `DSH_HOME` or `~/.dsh`) |
| `--data-dir <dir>` | DuckDB warehouse directory (defaults to `<home>/duckbi`) |
| `--sources <a,b>` | pre-register data directories and scan them right away |
| `--warmup eager\|lazy` | `eager`: scan before first use; `lazy`: register only (default) |
| `--copy` | copy instead of symlinking (use when the folder may be moved) |
| `--no-link` | the package was already installed by `dsh plugin add`; only write the config |
| `--force` | overwrite an existing target |
| `--remove` | uninstall (keeps the DuckDB data) |

### Verifying the install

```bash
cat ~/.dsh/duckbi/plugin-loaded.json
```

`"ok": true` means the plugin **loaded inside the running Harness process** and has already executed a
DuckDB query successfully. If the `duckbi_*` tools are still missing from the conversation, restart
Harness once (source changes always require a restart; config-only changes hot-reload).

---

## Usage

Once installed, just talk. Or name the tools explicitly:

```
Add D:\data\after-sales, xlsx only
What share of these logs are Errors? Draw a daily trend
Join the orders table with the regional targets table, rank by attainment, export to Excel
Turn that chart into a PDF titled "June 2024 operations weekly"
```

Naming rules: one schema per source directory (`src_<source>`), one table per file; Excel workbooks
produce one table per worksheet (`<file>__<sheet>`). Non-ASCII column headers are preserved verbatim,
never rewritten.

### Rich reports: PDF + Excel in one call

Pass `format: "pdf" | "xlsx" | "both"` together with `sections` to `duckbi_export`. Each section is
one of:

| kind | Required | Result |
| --- | --- | --- |
| `kpi` | `sql` | SQL returns `(label, value[, hint])`; PDF draws metric cards, Excel gets a metric sheet |
| `table` | `sql` or `table` | A formatted table with title, note and row count |
| `chart` | `sql` + `chart:{type,x,y,series?}` | Server-rendered PNG embedded in the PDF; Excel keeps the same data sheet |
| `text` | `body` | A narrative paragraph |

Charts are rendered once and share the queries with Excel. The PDF scales images to the page and
keeps a section heading with its chart. At most 12 sections per report.

---

## Configuration

The installer writes the block below into `<profile>/cordis.patch.yml`; you can edit it directly
(Harness hot-reloads it):

```yaml
- insert:
    - id: duckbi
      name: '@duckbi/dsh-plugin-duckbi'
      config:
        dataDir: 'C:\Users\me\.dsh\duckbi'
        warmup: eager
        sources:
          - path: 'D:\data\logs'
        maxRows: 200           # rows duckbi_query returns to the conversation
        maxChartRows: 5000
        maxExportRows: 200000
        maxPdfRows: 2000
        allowWriteSql: false   # set true to let the model run DDL/DML
        allowedRoots: ['D:\data']   # when non-empty, only these roots may be read/written
        threads: 4
        memoryLimit: 2GB
```

---

## Known limitations

- **`.xls` (legacy binary) is not supported** — save as `.xlsx` first.
- Unstructured logs are parsed **heuristically** (timestamp / level / `[MODULE.NNNN.NNNNs]` event code /
  continuation lines). For custom formats, extract columns with `regexp_extract` in SQL; the `raw`
  column always keeps the original text.
- Multi-line events inside one `.log` are not merged into a single record (one row per line; stack
  continuations are flagged with `continuation`).
- Charts are server-rendered static PNGs; no zoom or cross-filtering. Rich-report charts are embedded
  in the PDF while the Excel side keeps the data sheet.
- A rich report accepts at most 12 sections; with `format: "both"` both files share the same row cap
  (2000 rows per section for the PDF default).
- Catalog/scan output is compact by default; pass `detail: true` to `duckbi_source` for the full
  per-file inventory.
- The DuckDB file is **single-writer**: only one Harness instance may write to a given warehouse at a
  time.
- Screenshots and UI automation are out of scope — this handles tabular and text data only.

## Uninstall

```bash
node install.mjs --remove
```

Removes the profile configuration and the package link, keeping the DuckDB data under `dataDir`
(delete that directory yourself if you don't want it).

## License

MIT. See [LICENSE](./LICENSE).
