# DuckBI · 让 DeepSeek Harness 会算数

把磁盘上的 **日志目录** 和 **Excel 台账** 变成可对话查询的数据仓库：DuckDB 负责存储与计算，
Harness 负责理解你要什么。

- **指个目录就能用**：`.log` / `.csv` / `.json` / `.jsonl` / `.parquet` / `.xlsx`（多工作表也拆表），支持 gzip/zstd 压缩、GB18030 中文编码。
- **聊天里问数**：模型写 SQL、看结果、再改，反复迭代；只读闸门拦住 DDL/DML。
- **表格与图表直接显示在对话里**：结果渲染成 Markdown 表格；图表是服务端渲染的 PNG，有附件服务时内嵌显示。
- **一键导出**：`xlsx`（样式/冻结/筛选/Info 页）、`pdf`（A4 横向、重复表头、中文字体内嵌）、`csv` / `parquet` / `json`。

注册的 5 个工具：`duckbi_source`（管目录）、`duckbi_schema`（看结构）、`duckbi_query`（跑 SQL）、
`duckbi_chart`（出图）、`duckbi_export`（导文件）。

---

## 安装

仓库：<https://github.com/don2ccc/DuckBI-DSH>

### 前提

- 一个能跑插件的 DeepSeek Harness（桌面版或 `dsh` CLI 均可），且 profile 已存在（启动过一次即可）。
- Node.js ≥ 20（只用于安装与跑脚本；插件运行时用 Harness 自带的 Node）。
- 插件不 import 任何 `@deepseek-ai/*` 内部模块，**只依赖 `ctx.tools` 服务**，所以不挑 Harness 小版本。
- 首次读取 `.xlsx` 时会自动安装 DuckDB 的 `excel` 扩展，需要**一次性联网**（之后离线可用，扩展存在数据目录里）。

### 方式 A：从 GitHub 克隆（推荐）

```bash
git clone https://github.com/don2ccc/DuckBI-DSH.git
cd DuckBI-DSH/packages/dsh-plugin-duckbi
npm install            # 按当前平台拉原生二进制
node install.mjs       # 软链到 profile + 写配置
```

没有 git 就下载 ZIP（Code → Download ZIP），解压后从 `cd` 那步继续。

### 方式 B：`.tgz` 包（同事发的，或自己 `npm pack` 打的）

```bash
# 1) 装进某个 profile（依赖随之安装）
dsh plugin --profile desktop add ./duckbi-dsh-plugin-duckbi-0.1.0.tgz

# 2) 写配置（包已就位，用 --no-link 跳过软链）
node <profile>/node_modules/@duckbi/dsh-plugin-duckbi/install.mjs --no-link
```

### 方式 C：直接拷文件夹（离线 / 内网）

把 `packages/dsh-plugin-duckbi/` 整个目录拷过去（**不含** `node_modules`）：

```bash
cd dsh-plugin-duckbi
npm install            # 会按当前平台拉对应的原生二进制
node install.mjs       # 软链到 profile + 写配置
```

> **不要跨平台拷贝 `node_modules`**：`@duckdb/node-bindings-*` 和 `@napi-rs/canvas-*` 是平台专属的
> 原生包（win32-x64 约 74 MB）。让 npm 在目标机器上自己装，才会拿到正确的二进制。

### 安装参数

| 参数 | 作用 |
| --- | --- |
| `--profile <name>` | 装到哪个 profile（默认取 `DSH_PROFILE`，否则 `desktop`） |
| `--home <dir>` | Harness home（默认 `DSH_HOME` 或 `~/.dsh`） |
| `--data-dir <dir>` | DuckDB 仓库目录（默认 `<home>/duckbi`） |
| `--sources <a,b>` | 预登记数据目录，装上就开始扫 |
| `--warmup eager\|lazy` | `eager`：首次使用前扫完；`lazy`：只登记（默认） |
| `--copy` | 复制而不是软链（对方会移动文件夹时用） |
| `--no-link` | 包已由 `dsh plugin add` 装好，只写配置 |
| `--force` | 覆盖已存在的目标 |
| `--remove` | 卸载（保留 DuckDB 数据） |

### 验证装好了

```bash
cat ~/.dsh/duckbi/plugin-loaded.json
```

看到 `"ok": true` 就说明插件**已经在运行中的 Harness 进程里加载**，并且成功跑过一次 DuckDB 查询。
若对话里还没出现 `duckbi_*` 工具，重启一次 Harness（源码改动必须重启；只改配置会热加载）。

---

## 用法

装好后直接说话即可，也可以点名：

```
把 D:\数据\售后 加进来，只看 xlsx
这批日志里 Error 占比多少？按天画个趋势
订单表和地区目标表按地区 join，看完成率排名，导出 Excel
刚才那张图导成 PDF，标题写「2024 年 6 月运营周报」
```

表名规则：每个源目录一个 schema（`src_<源名>`），每个文件一张表；Excel 每个工作表一张表
（`<文件>__<工作表>`）。中文表头会保留原文，不会被改写。

---

## 配置

安装脚本会把下面这段写进 `<profile>/cordis.patch.yml`，可直接编辑（Harness 会热加载）：

```yaml
- insert:
    - id: duckbi
      name: '@duckbi/dsh-plugin-duckbi'
      config:
        dataDir: 'C:\Users\me\.dsh\duckbi'
        warmup: eager
        sources:
          - path: 'D:\数据\日志'
        maxRows: 200          # duckbi_query 回给对话的行数上限
        maxChartRows: 5000
        maxExportRows: 200000
        maxPdfRows: 2000
        allowWriteSql: false  # true 才允许模型执行 DDL/DML
        allowedRoots: ['D:\数据']   # 非空时只允许读写这些根目录之下
        threads: 4
        memoryLimit: 2GB
```

---

## 已知限制

- **`.xls`（老二进制格式）不支持**，请先另存为 `.xlsx`。
- 非结构化日志是**启发式**解析（时间戳 / 级别 / `[MODULE.NNNN.NNNNs]` 事件码 / 续行）；
  自定义格式建议用 `regexp_extract` 在 SQL 里拆，`raw` 列永远保留原文。
- 一个 `.log` 里的多行事件不会合并成一条记录（每行一行，堆栈续行用 `continuation` 标记）。
- 图表是服务端渲染的静态 PNG，不支持缩放/联动。
- DuckDB 文件是**单写者**：同一仓库同一时间只能有一个 Harness 实例写入。
- 截图/界面类需求不在范围内——它只处理表格与文本数据。

## 卸载

```bash
node install.mjs --remove
```

移除 profile 配置与包链接，保留 `dataDir` 下的 DuckDB 数据（不需要就手动删那个目录）。

## 许可

MIT。见 [LICENSE](./LICENSE)。
