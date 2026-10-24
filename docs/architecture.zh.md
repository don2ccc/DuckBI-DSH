# DuckBI · 用聊天做数据分析的 DeepSeek Harness 插件

把**磁盘上的日志目录和 Excel 台账**变成一个能用自然语言提问的数据仓库：插件用 DuckDB 建立目录级
的元数据与表结构，DeepSeek 通过工具调用写 SQL、画图、导出 Excel/PDF，全部发生在对话里。

```
你：把 D:\logs 和 D:\台账 加进来
模型：→ duckbi_source(add)          扫描 214 个文件 → 建了 38 张表
你：看看 3 月每天的报错数量，画个折线
模型：→ duckbi_query(...)           表格
      → duckbi_chart(line)          折线图（PNG 显示在对话里）
你：这张图导成 PDF 发我
模型：→ duckbi_export(pdf)          report.pdf（文件卡片可直接下载）
```

---

## 1. 它做了什么（对应你的四条需求）

| 需求 | 实现 |
| --- | --- |
| ① 指定磁盘位置，读取 `.log` / Excel，用 DuckDB 管理 | `duckbi_source` 注册目录 → 逐文件识别格式（CSV/TSV、JSON/JSONL、Parquet、XLSX 多工作表、非结构化 `.log`、`.gz`/`.zst` 压缩）→ 每个文件（每个工作表）建成一张 DuckDB 表，目录即 schema（`src_sales.orders`） |
| ② 和 DeepSeek 反复聊、智能取数 | 5 个模型可见工具：先看目录（`duckbi_schema`）再写 SQL（`duckbi_query`）；读结果、改 SQL、再问，多轮往复都由模型自己驱动 |
| ③ 在聊天框里展示数据 | 结果渲染成 GFM 表格（Harness 现有 Markdown 渲染器直接显示）；`duckbi_chart` 生成 PNG，**Harness 有附件服务时以图片块嵌入对话**，没有时落盘并在正文给出路径 |
| ④ 导出 Excel / PDF | `duckbi_export` 支持 `xlsx`（带表头样式、冻结窗格、筛选、数字格式、Info 页）、`pdf`（A4 横向、跨页重复表头、页码、中文字体内嵌），另外支持 `csv`/`parquet`/`json` 直出；传 `sections` 可一次生成**多节报告**（KPI 卡 / 表格 / 图表 / 结论文本），`format: "both"` 同时产出 PDF 与多工作表 Excel |

---

## 2. 快速开始

```powershell
cd <repo>

# 安装依赖（只需一次；插件自带 node_modules，与 Harness 版本解耦）
cd packages\dsh-plugin-duckbi ; npm install ; cd ..\..

# 安装插件到 DSH 的 desktop profile
node scripts\install.mjs                       # 默认 dataDir = %USERPROFILE%\.dsh\duckbi
node scripts\install.mjs --sources D:\logs,D:\台账   # 顺便预登记两个目录（启动即扫描）
```

> 要**分享给别人**（而不是自己开发），看第 11 节：那里有可分发包和对方的安装步骤。

安装脚本做两件事：把包**软链**到 `~/.dsh/profiles/node_modules/@duckbi/dsh-plugin-duckbi`
（Node 能按包名解析），并在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加一段带标记的
配置。该文件被 Harness 实时监听，**存活的会话会在几秒内热加载插件，不用重启**。

卸载：

```powershell
node scripts\install.mjs --remove        # 移除 patch 配置与软链，保留 %USERPROFILE%\.dsh\duckbi 数据
```

其它参数：`--profile web`（换个 profile）、`--copy`（复制而非软链，便于分发）、`--home`（自定义
Harness home）、`--warmup lazy|eager`。

装好以后，先确认进程里真的加载了：

```powershell
Get-Content "$env:USERPROFILE\.dsh\duckbi\plugin-loaded.json"
```

它记录 `pid` / `node` / `electron` / `duckdb` 版本 / 已注册工具，是"插件确实在这个进程里跑起来了"
的凭证（`ok: true` 表示 DuckDB 绑定也加载成功）。

> **注意**：patch 文件热加载会重新执行插件的 `apply`，但 Node 会复用已加载的模块实例。
> 因此**改动插件源码后需要重启一次 Harness** 才会生效；只改 `cordis.patch.yml` 里的配置
> （比如加目录、换 dataDir）则热加载即可。

---

## 3. 在对话里怎么用

装好之后直接跟 Harness 说话即可，模型会自动调用工具。也可以点名要求：

| 工具 | 作用 | 典型参数 |
| --- | --- | --- |
| `duckbi_source` | 管理监听的目录（也可只加一个文件） | `{action:"add", path:"D:\\logs", include:"*.log"}`、`{action:"list"}`、`{action:"refresh", name:"logs"}`、`{action:"remove", name:"logs"}`、`{action:"list", detail:true}` |
| `duckbi_schema` | 看目录 / 看某张表的列、类型、空值率、基数、样例 | `{}`、`{table:"src_logs.app"}`、`{query:"orders"}`（单命中直接返回列信息） |
| `duckbi_query` | 跑一条只读 SQL，返回 Markdown 表格 | `{sql:"SELECT level, count(*) n FROM src_logs.app GROUP BY 1 ORDER BY 2 DESC"}` |
| `duckbi_chart` | 跑 SQL 并画图（bar/line/area/pie/scatter） | `{sql:"...", type:"line", x:"day", y:["errors"]}` |
| `duckbi_export` | 导出文件或生成多节富报表 | `{format:"xlsx", sql:"...", title:"3月报错统计"}`；富报表 `{format:"both", sections:[{kind:"kpi", ...}, {kind:"chart", ...}]}` |

几个实际可用的问法：

- 「把 `D:\数据\售后` 加进来，只看 2024 年的 xlsx」
- 「这批日志里有哪些级别？Error 占比多少？按天画个趋势」
- 「把订单表和地区目标表按地区 join 起来，看完成率排名，导出 Excel」
- 「这条 SQL 太慢了，改写成先聚合再 join」
- 「刚才那张图导出 PDF，标题写"2024 年 6 月运营周报"」

导出成功后可以再让它 `present` 一下，聊天里会出现可下载的文件卡片。

### 表名与 schema 规则

- 每个源目录 → 一个 schema：`src_<源名>`（源名默认取目录名，冲突自动加 `_2`）。
- 每个文件 → 一张表：相对路径逐段小写化、非字母数字变 `_`，例如 `logs/sub/app.log` → `src_logs.sub__app`。
- Excel 多工作表 → 每张可见工作表一张表，表名是 `<文件>__<工作表>`；工作表名是中文时表名会带一段短哈希
  （表名必须能在 SQL 里裸写），但**列名保留原文**，中文表头不会被改写。
- 中文/非 ASCII 的目录名同样会变成 `x<哈希>` 形式的源名，`duckbi_source list` 里能看到映射。

---

## 4. 支持的文件与解析方式

| 扩展名 | 处理方式 |
| --- | --- |
| `.xlsx` / `.xlsm` | DuckDB `excel` 扩展逐工作表 `read_xlsx`；表头保留原文，空工作表跳过；先枚举工作表（直接读 zip 里的 `xl/workbook.xml`，不解析单元格） |
| `.csv` / `.tsv` / `.psv` | `read_csv_auto` 类型推断；失败则退回显式分隔符 + 全文本 + `ignore_errors`，并在结果里注明"用了兜底策略" |
| `.json` / `.jsonl` / `.ndjson` | `read_json_auto`，`union_by_name=true`（不同记录字段不一致也能合并），自动区分 JSON 数组与逐行 JSON |
| `.parquet` | `read_parquet`，零拷贝 |
| `.log` / `.txt` / `.out` / `.err` / 未知扩展 | 先嗅探：**逐行 JSON** → 走 JSON；**稳定分隔符**（`,` `\t` `|` `;`）→ 走 CSV；否则按非结构化日志解析（见下） |
| `.gz` / `.zst` / `.zstd` / `.bz2` / `.br` | 先解压到 `<dataDir>/temp`（带缓存），再按内层扩展处理 |

**非结构化日志**会被解析成固定 schema：

| 列 | 含义 |
| --- | --- |
| `line_no` | 行号 |
| `ts` | 真 `TIMESTAMP`（识别 `YYYY-MM-DD HH:MM:SS`、`YYYY/MM/DD`、`T` 分隔、带时区/毫秒、`[bracketed]` 等写法） |
| `level` | `INFO/WARN/ERROR/DEBUG/TRACE/FATAL`，别名归一（`WARNING→WARN`、`CRIT→FATAL`…） |
| `message` | 去掉时间戳与级别后的正文 |
| `raw` | 原始整行（自定义格式可继续用 `regexp_extract` 处理） |
| `continuation` | 是否像堆栈续行（缩进 / `at ...` / `Caused by:`） |

**编码**：不是合法 UTF-8 的文件会按 **GB18030**（兼容 GBK/GB2312）解码并缓存一份 UTF-8 副本再交给
DuckDB —— 中文 Windows 上导出的日志和 CSV 基本都是这个编码。UTF-8 BOM 会被剥掉（BOM 会干扰
CSV 嗅探）。

**增量**：按 `(大小, mtime)` 判断文件是否变化，只重新摄入变化的文件；文件被删除则对应表被删除。
坏文件不会中断整批扫描：错误记录在 `_duckbi_files.error` 里，`duckbi_source list` 会显示 `⚠ N failed`。

---

## 5. 配置

`cordis.patch.yml` 里那段配置的完整字段（全部可选）：

```yaml
- insert:
    - id: duckbi
      name: '@duckbi/dsh-plugin-duckbi'
      config:
        dataDir: 'C:\Users\me\.dsh\duckbi'   # 仓库目录：catalog.duckdb / exports / temp / extensions
        warmup: eager      # eager=首次使用前就把 sources 扫完；lazy=只登记，等显式 refresh
        sources:           # 预登记目录（也可以之后在对话里 add）
          - path: 'D:\数据\日志'
            name: logs
            recursive: true
            include: '*.log,*.csv'
            exclude: 'archive/*'
            multiSheet: true
          - path: 'D:\台账'
        maxRows: 200         # duckbi_query 返回给对话的行数上限（1..20000）
        maxChartRows: 5000   # 画图时最多读多少行
        maxExportRows: 200000
        maxPdfRows: 2000
        maxFileBytes: 2147483648   # 单文件大小上限
        allowWriteSql: false       # true 才允许模型执行 DDL/DML
        allowedRoots: ['D:\数据']  # 非空时，只能读写这些根目录之下的路径
        threads: 4
        memoryLimit: 2GB
```

`dataDir` 与 `allowedRoots` 支持 `${ENV}`、`%ENV%`、`~` 展开。

**目录结构**：

```
%USERPROFILE%\.dsh\duckbi\
  catalog.duckdb        所有源、文件台账与用户数据表（单一事实来源）
  exports\              图表 PNG 与导出文件
  temp\                 GB18030 转码副本、解压副本（可随时删）
  extensions\           DuckDB excel 扩展（首次联网安装后离线可用）
  plugin-loaded.json    加载凭证
```

---

## 6. 安全边界

- `duckbi_query` **只接受单条只读语句**：首关键字必须是 `SELECT/WITH/DESCRIBE/SHOW/SUMMARIZE/EXPLAIN/...`，
  且括号深度 0 处不允许出现 `INSERT/UPDATE/DELETE/DROP/CREATE/COPY/ATTACH/INSTALL/PRAGMA/...`；
  多语句直接拒绝。（扫描、刷新、删源走 `duckbi_source`，不经过这条通道。）
- `allowWriteSql: false` 是默认值；真需要模型建视图时再打开。
- `allowedRoots` 一旦配置，`add`/`export` 的目标路径必须落在其内。
- 这是一道**防误操作**的闸门，不是沙箱：模型仍然以你自己的文件权限运行。

---

## 7. 展示与导出：为什么不用写前端插件

Harness 的对话界面本来就会渲染 GFM 表格，所以**查询结果不需要任何客户端插件**：JSON 结果在服务端
渲染成 Markdown 表格（数字千分位、右对齐、超宽表格自动截断并注明"还有 N 列未显示"、"显示 200 / 1,284
行"这类完整性说明），任何 surface（Web、终端、日志回放）看到的内容都一致。

图表是唯一的例外：纯文本装不下。`duckbi_chart` 用 `@napi-rs/canvas` 在服务端画 PNG（中文字体、
自动刻度、千分位、图例、超多分类聚合成 `Other`），然后**探测 Harness 是否挂了附件服务**：
挂了就把图片作为 `image` 内容块嵌入对话；没挂就落盘并在正文里给出绝对路径。附件失败绝不影响图表生成本身。

导出文件同理：工具只负责产出文件并返回路径，随后模型调用 Harness 自带的 `present` 工具，
就能复用现有的"文件卡片 / 下载"能力。

---

## 8. 代码地图

```
packages/dsh-plugin-duckbi/
  lib/
    index.js        插件入口：name/inject/apply，启动后台预热，写加载凭证
    config.js       配置默认值与路径展开
    engine.js       DuckDB 生命周期、语句串行队列、元数据表、excel 扩展安装
    catalog.js      源登记、目录遍历（glob/跳过规则）、增量扫描、表inventory
    ingest.js       格式嗅探与各类型摄入（CSV/JSON/Parquet/XLSX/非结构化日志）
    encoding.js     BOM/UTF-8/GB18030 判定、流式转码、解压
    xlsx-sheets.js  纯 Node 读 zip 取工作表名（不解析单元格）
    sql.js          只读 SQL 闸门（字符串/标识符/注释感知的词法扫描）
    value.js        列类型判定、单元格格式化、导出值转换
    format.js       Markdown 渲染（表格、目录、扫描摘要、图表/导出文案）
    chart.js        Canvas 图表渲染（bar/line/area/pie/scatter）
    export-xlsx.js  ExcelJS 工作簿导出
    export-pdf.js   PDFKit 报告导出（中文字体内嵌、列分组、分页）
    tools.js        5 个工具的 schema / execute / render
  test/
    fixtures.mjs    覆盖各摄入路径的确定性测试数据（含 GB18030、gzip、坏 xlsx）
    harness.mjs     真实 cordis + dsh-tools 启动器与 call() 派发
    run-tests.mjs   端到端测试（64 项断言）
    chart.smoke.mjs / export.smoke.mjs   两个展示层的冒烟测试
scripts/
  install.mjs       安装/卸载到 DSH profile
  demo.mjs          造一份演示数据，跑完整流程，产出 samples/（含多节富报表）
```

**设计取舍**：

- 工具用**原始 JSON Schema** 注册（而不是 `defineTool` DSL），插件不 import 任何 `@deepseek-ai/*`，
  只依赖 `ctx.tools` 这一个服务 —— 升级 Harness 时不会因为内部 API 变动而失效。
- 所有语句走一个串行队列：DuckDB 是单写者，串行化消灭了"扫描重建表时另一条查询正在读"这类竞态。
- 元数据（源、文件、行数、错误）存在**同一个 DuckDB 文件**里，不会出现"表和台账对不上"的状态。
- 非结构化日志用 DuckDB appender 流式写入（不是先把整个文件读进内存），2000 万行后主动收手并提示。
- 展示层依赖（canvas/exceljs/pdfkit）都是**惰性 import**：只查数不画图时不会加载它们。
- **对话输出默认聚合**：目录/扫描只回计数、类型汇总和表名样本，`detail: true` 才逐文件展开；schema 支持
  按表名搜索并在单命中时直接描述，减少往返。
- **一次调用出富报表**：`sections` 让 KPI、表格、图表、结论共用同一批查询结果；图表只渲染一次并嵌入 PDF。
- **I/O 与引擎调优**：目录 `stat` 有界并发；DuckDB 的 `temp_directory` 指向数据目录，
  关闭 `preserve_insertion_order` 以减少不必要的排序开销。

---

## 9. 测试与演示

```powershell
cd packages\dsh-plugin-duckbi
node test\run-tests.mjs      # 64 项端到端断言（真实 cordis + 真实工具管线 + 真实 DuckDB）
node test\chart.smoke.mjs    # 图表渲染 15 例
node test\export.smoke.mjs   # Excel/PDF 导出 87 项断言

cd ..\..
node scripts\demo.mjs        # 生成 samples\ 下的图表、xlsx、pdf、csv 与对话记录
```

`run-tests.mjs` 覆盖：格式识别（含 GB18030 转码、gzip 解压、坏文件不中断）、中文表头保留、
时间戳/级别解析、堆栈续行标记、聚合正确性、结果截断与总数、只读闸门（DDL/多语句/CTE 里藏 DML）、
图表生成与未知列报错、xlsx/pdf/csv 导出与回读校验、多节富报表（KPI/表格/图表/文本 → PDF+XLSX）、
单文件注册、紧凑输出、schema 搜索、增量刷新、删源、加载凭证。

`samples/` 里是 `demo.mjs` 的真实产物，可以直接打开判断观感：

- [chart-revenue-by-region.png](samples/chart-revenue-by-region.png) · [chart-monthly-trend.png](samples/chart-monthly-trend.png) · [chart-log-levels.png](samples/chart-log-levels.png)
- [sales-report.xlsx](samples/sales-report.xlsx) · [sales-report.pdf](samples/sales-report.pdf) · [monthly-summary.csv](samples/monthly-summary.csv)
- [regional-report.pdf](samples/regional-report.pdf) · [regional-report.xlsx](samples/regional-report.xlsx)（KPI 卡 + 表 + 图 + 结论）
- [console.txt](samples/console.txt)（对话里实际渲染出来的文本）

---

## 10. 已知限制与后续

- **PDF 里的百分比列按原始数字输出**（`0.42` 而不是 `42%`）；xlsx 会按数据自动判定（值都在 0–1 才套 `0.00%`）。
- **富报表的图表只嵌入 PDF**；Excel 侧保留同口径数据表（ExcelJS 流式写入不支持嵌入图片）。
- **富报表一次最多 12 节**；`format: "both"` 时 PDF 与 Excel 共用同一行数上限（PDF 默认 2000 行/节）。
- **非结构化日志是启发式解析**：自定义格式（如 nginx access log）建议先用 `regexp_extract` 在 SQL 里
  拆列，或在 `ingest.js` 里加一个 pattern；`raw` 列永远保留原文。
- **一个 `.log` 文件里的多行事件**不会合并成一条记录（每行一行，堆栈续行用 `continuation` 标记）。
- **Excel 只支持 xlsx/xlsm**；老的二进制 `.xls` 需要先另存。
- **excel 扩展首次使用需要联网**（装进 `dataDir/extensions` 后离线可用）；失败时错误信息会给出替代方案。
- 图表 PNG 是服务端绘制的静态图，暂不支持交互（缩放/联动）——那需要真正的客户端插件，可以后续加。
- 表名对非 ASCII 文件名做了哈希，SQL 里不如中文直观；`duckbi_schema` 会列出文件与表的对应关系。

---

## 11. 分享给别人

插件**不 import 任何 `@deepseek-ai/*` 内部模块**（只用 `ctx.tools` 这一个服务），所以不挑 Harness 小版本；
剩下要解决的只有两件事：**怎么把包送到对方机器**、**怎么让对方的 profile 加载它**。

### 关键约束：不要跨平台拷 `node_modules`

`@duckdb/node-api` 和 `@napi-rs/canvas` 带**平台原生二进制**（本机 win32-x64 约 74 MB）。
直接拷 `node_modules` 会把 Windows 的 `.node` 文件带到 Linux/macOS，加载即失败。
**正确做法是让对方在自己机器上 `npm install`**，由 npm 按平台挑包。

### 方式 A：tarball（推荐，最小、跨平台）

```powershell
# 你这边：打一个 78 KB 的包（只含 lib/ + install.mjs + README + LICENSE + package.json）
cd packages\dsh-plugin-duckbi
npm pack --pack-destination <repo>\dist
# -> <repo>\dist\duckbi-dsh-plugin-duckbi-0.2.0.tgz
```

```powershell
# 对方：装进 profile（dsh 会把 pnpm 转发过去，依赖自动装好）
dsh plugin --profile desktop add .\duckbi-dsh-plugin-duckbi-0.2.0.tgz

# 再写配置（包已在 node_modules 里，用 --no-link 跳过软链）
node <profile>\node_modules\@duckbi\dsh-plugin-duckbi\install.mjs --no-link
```

### 方式 B：整个插件文件夹（离线/内网）

拷 `packages\dsh-plugin-duckbi\`（**不含** `node_modules`），对方执行：

```powershell
cd dsh-plugin-duckbi
npm install        # 按当前平台拉原生包
node install.mjs   # 软链到 profile + 写配置（自包含，不依赖 monorepo）
```

或者你直接给对方一个 `.zip`（去掉 `node_modules` 和 `test/out`），对方解压后同上。

### 方式 C：git 仓库

把 `packages/dsh-plugin-duckbi` 作为独立仓库推送（`package.json` / `lib/` / `install.mjs` / `README.md` /
`LICENSE` 就够），对方 `git clone` → `npm install` → `node install.mjs`。

### 对方装完怎么验

```powershell
Get-Content "$env:USERPROFILE\.dsh\duckbi\plugin-loaded.json"
```

`"ok": true` 表示插件**已在运行中的 Harness 进程里加载，并成功执行过 DuckDB 查询**；
文件里同时记录了 `duckdb` 版本、`electron` 版本和已注册的 5 个工具。
若对话里仍没有 `duckbi_*` 工具，重启一次 Harness（**改源码必须重启**，只改 profile 配置会热加载）。

### 升级与回滚

- 升级：重新 `npm pack` → 对方 `dsh plugin add <新 tgz>` 覆盖 → 重启 Harness。
- 回滚：`node install.mjs --remove` 清掉配置与链接，再装旧版本；DuckDB 数据（`~/.dsh/duckbi`）不受影响。
- 版本号在 `packages/dsh-plugin-duckbi/package.json` 的 `version`；`plugin-loaded.json` 里也能看到当前生效版本。

### 分发前检查清单

- [ ] `node test/run-tests.mjs` 全绿（64 项断言）
- [ ] `npm pack` 的清单里**没有** `node_modules` / `test/` / `.demo/`
- [ ] `install.mjs` 在目标 profile 上能 `--help` / 安装 / `--remove`
- [ ] 对方机器 `npm install` 后能 import（原生二进制与平台匹配）
- [ ] 首次读 `.xlsx` 的网络可达（或提前把 DuckDB `excel` 扩展放进 `dataDir/extensions`）

