# DuckBI · Let AI analyze the Excel files and logs already on your machine

[中文](README.md) | **English**

> **Local DuckDB engine · chat-driven SQL · charts and reports out of the box**
> No uploads, no warehouse, no BI training — point it at a folder, then just talk.

`#dsh-plugin` · `DuckDB` · `local-first` · `Excel / Log / CSV / JSON` · `MIT`

[![CI](https://github.com/don2ccc/DuckBI-DSH/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/don2ccc/DuckBI-DSH/actions/workflows/ci.yml)
[![Release asset](https://github.com/don2ccc/DuckBI-DSH/actions/workflows/release-asset.yml/badge.svg)](https://github.com/don2ccc/DuckBI-DSH/actions/workflows/release-asset.yml)

![Revenue by region](docs/images/chart-region.png)

---

## The 30-second version

|  | The usual way | DuckBI |
| --- | --- | --- |
| Getting data in | Upload to a SaaS, build a warehouse, write ETL | **Point at a folder — tables appear** |
| Querying | Drag dimensions, write DAX, file a ticket | **Say it in one sentence; the AI writes the SQL** |
| Big files | Web upload chokes, Excel won't open | **1.3 GB of logs ingested in 9 s; 3.7 M rows aggregated in milliseconds** |
| Reporting | Assemble it in a template tool | **One sentence → Excel / PDF** |
| Data boundary | Upload everything to the cloud | **Files never leave the machine; all compute is local** |

**This is not "upload a file and let the AI look at it". It is an analytics engine installed on your
machine; the model only issues the commands.**

---

## Three steps (~2 minutes)

Prerequisite: DeepSeek Harness installed (desktop app or the `dsh` CLI) and **started at least once**,
so that a profile exists.

```powershell
git clone https://github.com/don2ccc/DuckBI-DSH.git
cd DuckBI-DSH\packages\dsh-plugin-duckbi
npm install
node install.mjs
```

Confirm it loaded:

```powershell
Get-Content "$env:USERPROFILE\.dsh\duckbi\plugin-loaded.json"
```

If you see `"ok": true` you are done → **restart Harness once** (needed for the first load) → say:

> Add `D:\data\sales` and show me what's in there

> No git? Use **Code → Download ZIP**, extract it, and continue from the `cd` line.
> Other profiles, offline installs, manual installs and troubleshooting are covered in
> [Installation in detail](#installation-in-detail).

---

## What it does

### ① Point at a directory, get a database

```
You: add D:\data\sales
AI:  → scanned 13 files → created 3 tables (1,099,083 rows) in 9.4 s
```

Supports `.log` `.csv` `.tsv` `.json` `.jsonl` `.ndjson` `.parquet` `.xlsx` `.xlsm`.
Compressed files (`.gz` / `.zst`) are read directly, **GB18030 Chinese encoding is detected and
transcoded automatically**, multi-sheet Excel workbooks become one table per sheet, and
**non-ASCII column headers are preserved verbatim**.

### ② Chat is the SQL editor

```
You: monthly return rate per product for the North region
AI:  (spots 1–3 orders per cell → voluntarily re-grains to half-year and tells you why)
```

The model **reads the schema before writing SQL**, looks at the result, and revises. You can stay in
business language the whole time.

### ③ Charts render inside the conversation

![Monthly trend](docs/images/chart-trend.png)

Bar, line, area, donut and scatter, rendered server-side with Canvas and **embedded inline in chat
when an attachment service is present**. CJK titles, thousands separators and automatic `Other`
bucketing are handled.

### ④ Reports in one sentence

```
You: turn this into a report for my director
AI:  → multi-section PDF (region scorecard / YoY growth / cross-tab, with charts and caveats) + matching Excel
```

Once the layout is settled you can **freeze it into a template** and re-run
`node scripts/report.mjs <source>` with no model involved and zero tokens — ideal for daily or
weekly reporting.

Excel output ships with header styling, frozen panes, autofilter, number formats and an info sheet;
PDF is A4 landscape with repeating headers across pages, page numbers and **embedded CJK fonts**.

---

## Where your data actually goes (please read)

**No file is ever uploaded.** The precise boundary:

| Step | Runs on | Leaves your machine? |
| --- | --- | --- |
| Reading Excel / logs, creating tables, SQL aggregation | Local DuckDB (embedded, no service, no port) | **No** |
| Chart rendering, Excel / PDF generation | Local Node.js | **No** |
| Raw file contents | — | **Never** |
| Column names, schema, query **result tables** (≤ 200 rows by default) | Sent with the conversation | With a cloud model: yes |
| Your prompts, the SQL the model writes | Sent with the conversation | With a cloud model: yes |

In other words: **anything that can be computed locally is never sent out.** The model only sees the
aggregated results you allow it to see — never your raw files.

### Want literally zero egress? Use a local model

Harness accepts any OpenAI-compatible endpoint. Point it at an inference server on your LAN
(Ollama / vLLM / LM Studio all work) and the whole chain — data, compute, inference — stays on your
machine:

```yaml
# cordis.patch.yml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      local:
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1   # your local inference server
        apiKeyEnv: LOCAL_LLM_KEY
        models: [{ id: qwen2.5-coder:14b, name: Qwen2.5 Coder 14B }]
```

Lower `maxRows` and only ever ask for aggregates (`GROUP BY` first) and the egress surface approaches
zero.

---

## Installation in detail

Installing means **putting the package where the profile can resolve it** and **adding one `insert`
entry to the profile's patch file**. The bundled `install.mjs` does both; you can also do it by hand
(see below — the script does nothing else).

### 0. Prerequisites

| Requirement | How to check | Notes |
| --- | --- | --- |
| DeepSeek Harness | desktop app opens, or `dsh --version` prints something | desktop app and CLI both fine |
| Node.js 20+ | `node -v` | **only for installing and running the scripts**; the plugin itself runs on the Node bundled with Harness |
| At least one profile | `dir %USERPROFILE%\.dsh\profiles` (macOS/Linux: `ls ~/.dsh/profiles`) | no `desktop`? start the desktop app once, or use `--profile web` |

> `DSH_HOME` defaults to `%USERPROFILE%\.dsh` (`~/.dsh` on macOS/Linux). If yours lives elsewhere,
> add `--home <your path>` to every command.

### Option A: git clone (recommended)

```powershell
git clone https://github.com/don2ccc/DuckBI-DSH.git
cd DuckBI-DSH\packages\dsh-plugin-duckbi
npm install            # pulls the native binaries for your platform (~130 MB, ~10 s the first time)
node install.mjs       # installs into the desktop profile
```

Different profile, or pre-register data directories:

```powershell
node install.mjs --profile web
node install.mjs --sources D:\logs,D:\ledgers --warmup eager
```

### Option B: download the ZIP (no git)

1. Repository page → **Code → Download ZIP** → extract, e.g. `D:\DuckBI-DSH-main`
2. Then exactly as Option A:

```powershell
cd D:\DuckBI-DSH-main\packages\dsh-plugin-duckbi
npm install
node install.mjs
```

### Option C: one command for the released tarball (fastest)

```powershell
# 1) install the GitHub Release package into the profile (dependencies included; pnpm resolves the tarball URL)
dsh plugin --profile desktop add https://github.com/don2ccc/DuckBI-DSH/releases/download/v0.1.0/duckbi-dsh-plugin-duckbi-0.1.0.tgz

# 2) write the config (the package is already in node_modules, so --no-link skips the symlink)
node "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@duckbi\dsh-plugin-duckbi\install.mjs" --no-link
```

You can also download the [`.tgz` from the Releases page](https://github.com/don2ccc/DuckBI-DSH/releases/tag/v0.1.0)
in a browser, or use a tarball a colleague sent you, and swap the first step for a local path:

```powershell
dsh plugin --profile desktop add .\duckbi-dsh-plugin-duckbi-0.1.0.tgz
```

Packing one yourself:

```powershell
cd packages\dsh-plugin-duckbi
npm pack          # -> duckbi-dsh-plugin-duckbi-0.1.0.tgz (~80 KB, no node_modules)
```

> **Never copy `node_modules` to someone else.** `@duckdb/node-api` and `@napi-rs/canvas` ship
> platform-specific native binaries; a Windows `.node` file fails to load on macOS/Linux. Let the
> other side run `npm install`.

### What the installer actually does (verifiable)

1. Links the package into `<home>/profiles/node_modules/@duckbi/dsh-plugin-duckbi`
   (junction on Windows, symlink on macOS/Linux) — **without copying `node_modules`**;
2. Appends a marked block to `<home>/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   # >>> DuckBI (managed by install.mjs) >>>
   - insert:
       - id: duckbi
         name: '@duckbi/dsh-plugin-duckbi'
         config:
           dataDir: 'C:\Users\me\.dsh\duckbi'
           warmup: lazy
           sources: []
   # <<< DuckBI (managed by install.mjs) <<<
   ```

   **Your existing configuration is left untouched.** Re-running replaces that block in place (never
   duplicates it). If the profile is still an empty layer (`[]`), the installer replaces the `[]`
   instead of appending to it — otherwise the YAML would be invalid.
3. Creates the data directory `<home>/duckbi` (DuckDB file, exports, temporary transcoded copies).

Nothing else is modified, and no administrator rights are needed.

### Manual installation (if you'd rather not run a script)

```powershell
# 1) create the directory and link it (Windows; macOS/Linux use ln -s)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\profiles\node_modules\@duckbi"
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\node_modules\@duckbi\dsh-plugin-duckbi" `
  -Target "D:\DuckBI-DSH\packages\dsh-plugin-duckbi"
```

```bash
# macOS / Linux
mkdir -p ~/.dsh/profiles/node_modules/@duckbi
ln -s /path/to/DuckBI-DSH/packages/dsh-plugin-duckbi ~/.dsh/profiles/node_modules/@duckbi/dsh-plugin-duckbi
```

Then append this to the **end** of `~/.dsh/profiles/desktop/cordis.patch.yml`
(if the file only contains `[]`, delete the `[]` first):

```yaml
- insert:
    - id: duckbi
      name: '@duckbi/dsh-plugin-duckbi'
      config:
        dataDir: 'C:\Users\me\.dsh\duckbi'   # single quotes required: double quotes turn \U into an escape
        warmup: lazy
        sources: []
```

Finally `mkdir` the `dataDir` and start Harness.

### Verifying the install

```powershell
Get-Content "$env:USERPROFILE\.dsh\duckbi\plugin-loaded.json"
# macOS/Linux: cat ~/.dsh/duckbi/plugin-loaded.json
```

```json
{
  "plugin": "@duckbi/dsh-plugin-duckbi",
  "version": "0.1.0",
  "pid": 41008,
  "electron": "44.0.0",
  "duckdb": "v1.5.6",
  "ok": true
}
```

- **File exists with `ok: true`** → the plugin loaded inside your **running** Harness process and has
  already executed a DuckDB query successfully.
- **File missing** → the plugin was not loaded; see the troubleshooting table below.

### Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No `duckbi_*` tools in the conversation | **Source changes require a Harness restart** (only `cordis.patch.yml` edits hot-reload). Check that `plugin-loaded.json` exists first |
| `找不到 profile "desktop"` (profile not found) | the desktop app was never started. Start it once, or point `--profile` at an existing profile name such as `web` |
| `npm install` hangs or fails | the native packages `@duckdb/node-bindings-*` and `@napi-rs/canvas-*` must be downloadable; switch network/mirror and retry |
| First `.xlsx` read complains about the excel extension | a **one-time network access** is needed to install DuckDB's `excel` extension; for air-gapped machines copy `~/.dsh/duckbi/extensions` over |
| `another process is using it` | DuckDB is single-writer: only one Harness may write to a given data directory |
| Everything is mojibake | GB18030 is transcoded automatically; if it is still garbled, check the file is not UTF-16 or double-encoded by another tool |
| Config edits have no effect | `cordis.patch.yml` is watched and hot-reloads within seconds; otherwise restart |
| Windows path causes a YAML parse error | paths must use **single quotes**; in double quotes `\U` and `\.` are escapes |

### Upgrading / uninstalling / multiple profiles

```powershell
# upgrade (the package is symlinked to the checkout, so code follows git)
cd DuckBI-DSH; git pull
cd packages\dsh-plugin-duckbi; npm install; node install.mjs   # idempotent: replaces the block in place
# then restart Harness

# uninstall
node install.mjs --remove        # removes the config block and the link, keeps ~/.dsh/duckbi data

# multiple profiles: run once per profile
node install.mjs --profile web
node install.mjs --profile headless
```

### Platforms and configuration

- Prebuilt native packages exist for **Windows x64 / macOS (Intel and Apple Silicon) / Linux x64**;
  other architectures need a local build.
- `install.mjs` itself is **dependency-free plain JS** (Node built-ins only), so the linking step works
  before `npm install`; the plugin still needs its dependencies at runtime, so don't skip it.

Configuration keys (`dataDir` / `warmup` / `sources` / `maxRows` / `allowedRoots` / `allowWriteSql` …)
are documented in the [plugin README](packages/dsh-plugin-duckbi/README.en.md).

---

## A real transcript

A full multi-turn analysis; the raw text is in [docs/examples/console.txt](docs/examples/console.txt):

```
### revenue by region         [duckbi_query]     9 ms
| region | orders | revenue | avg_order | share_pct |
| :---   |  ---:  |    ---: |      ---: |      ---: |
| 西南   |    295 | 799,501 |     2,710 |     20.47 |
…

### data health check          [duckbi_query]
found 5 problems: Date and OrderDate are identical, StoreLocation contradicts Region,
FREESHIP promotion orders still carry shipping cost, unit price is unrelated to product,
and the return rate is 24.8% regardless of any dimension.
```

**It doesn't just hand you numbers — it tells you whether the data is usable.**

---

## Why it's fast

- **DuckDB columnar + vectorized**: aggregating 3.7 M rows takes milliseconds (9 ms in the demo).
- **Materialized tables, not views**: the first scan costs something, every later query hits the local
  column store.
- **Incremental scanning**: keyed on `(size, mtime)`, so touching one file only recomputes that file.
- **Zero-token report re-runs**: once the layout is settled, `node scripts/report.mjs` produces the PDF
  without the model.

---

## What it deliberately does not do

- No BI dashboards, no real-time streaming, no multi-tenant analytics platform.
- No `.xls` (the legacy binary format), and no cross-platform copying of `node_modules` (native bindings).
- It is **not** "stuff the file into the context and let the model read it" — that costs tens of
  thousands of tokens and still gets the arithmetic wrong. Here the SQL runs locally.

---

## Project layout

```
packages/dsh-plugin-duckbi/   the plugin itself (a distributable npm package, ~80 KB tarball)
  lib/                        engine / ingest / catalog / sql / chart / exporters / tools
  install.mjs                 self-contained installer (link + config + uninstall)
  test/                       55 end-to-end assertions + chart/export smoke tests
scripts/
  install.mjs                 in-repo entry point (forwards to the package installer)
  demo.mjs                    builds demo data, runs the whole flow, writes samples
  report.mjs                  report template: PDF + Excel in one command
docs/
  architecture.zh.md          design notes: ingestion paths, concurrency, trade-offs
  examples/console.txt        real conversation output
```

## Development

```bash
cd packages/dsh-plugin-duckbi
npm install
node test/run-tests.mjs      # 55/55: real cordis + real tool pipeline + real DuckDB
node test/chart.smoke.mjs    # 15 chart cases
node test/export.smoke.mjs   # 87 Excel/PDF assertions
```

The tests need the real `@deepseek-ai/cordis` and tool runtime, which are declared as
**devDependencies**, so **you do not need Harness installed beforehand** (this is how CI runs them).
To test against a specific installed profile instead, set `DSH_HOME=<your harness home>` — resolution
order is "local `node_modules` → profile".

> At **runtime** the plugin imports no `@deepseek-ai/*` package at all; it only uses `ctx.tools`.
> Those packages appear in tests only.

Design trade-offs, failure cases and limitations live in [docs/architecture.zh.md](docs/architecture.zh.md)
(Chinese).

## License

MIT · see [LICENSE](LICENSE).
