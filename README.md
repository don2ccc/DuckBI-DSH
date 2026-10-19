# DuckBI · 让 AI 直接分析你电脑里的 Excel 和日志

> **本地 DuckDB 引擎 · 对话式取数 · 一键出图出报表**
> 不用上传文件、不用建仓库、不用学 BI 工具 —— 指一个目录，然后开始聊天。

`#dsh-plugin` · `DuckDB` · `local-first` · `Excel / Log / CSV / JSON` · `MIT`

![各区域销售额](docs/images/chart-region.png)

---

## 30 秒看懂

|  | 传统做法 | DuckBI |
| --- | --- | --- |
| 数据怎么进来 | 手动上传到 SaaS / 建数仓 / 写 ETL | **指一个文件夹，自动建表** |
| 怎么取数 | 拖拽维度、写 DAX、找人提需求 | **说一句话，AI 写 SQL** |
| 大文件 | 网页传不动、Excel 打不开 | **1.3 GB 日志 9 秒入库，370 万行秒级聚合** |
| 报表 | 模板工具里拼 | **一句话导出 Excel / PDF** |
| 数据边界 | 全量上传云 | **原始文件永不外发；计算全在本机** |

**它不是一个"上传文件给 AI 看"的工具，而是一个装在你机器上的分析引擎，AI 只负责下命令。**

---

## 它能做什么

### ① 指个目录，就变成数据库

```
你：把 D:\data\销售 加进来
AI：→ 扫描 13 个文件 → 建了 3 张表（1,099,083 行），9.4 秒
```

支持 `.log` `.csv` `.tsv` `.json` `.jsonl` `.ndjson` `.parquet` `.xlsx` `.xlsm`，
压缩包（`.gz` / `.zst`）直接读，**GB18030 中文编码自动识别转码**，
Excel 多个工作表自动拆成多张表，**中文表头原样保留**。

### ② 聊天就是 SQL 编辑器

```
你：North 区各产品月度退货率
AI：（发现每个格子只有 1–3 单 → 主动降维到半年口径重算，并告诉你为什么）
```

模型会**先看表结构再写 SQL**，跑完看结果，不对就改。你可以只聊业务，不说 SQL。

### ③ 图直接在对话里显示

![月度趋势](docs/images/chart-trend.png)

柱状、折线、面积、环形、散点，服务端用 Canvas 渲染成 PNG，**有附件服务时直接内嵌在聊天里**。
中文标题、千分位刻度、自动折叠 `Other` 都处理好了。

### ④ 报表一句话落地

```
你：按这个口径做份报表，我要给总监汇报
AI：→ 多节 PDF（区域积分卡 / 同期增长 / 交叉表，带图表与口径说明）+ 同口径 Excel
```

版式定下来后可以**固化成模板**，之后 `node scripts/report.mjs <源文件>` 一条命令重跑，
不经过模型、0 token，适合日报/周报。

Excel 带表头样式、冻结窗格、筛选、数字格式、生成信息页；PDF 是 A4 横向、跨页重复表头、页码、
**中文字体内嵌**。

---

## 数据到底去了哪儿（重要，请读完）

**没有任何文件被上传。** 具体边界如下：

| 环节 | 在哪执行 | 会离开你的机器吗 |
| --- | --- | --- |
| 读 Excel / 日志、建表、SQL 聚合 | 本机 DuckDB（嵌入式，无服务、无端口） | **不会** |
| 图表渲染、Excel / PDF 生成 | 本机 Node.js | **不会** |
| 原始文件内容 | —— | **永不外发** |
| 列名、表结构、查询**结果表**（默认 ≤ 200 行） | 随对话发给模型 | 云端模型：会 |
| 你打的字、模型写的 SQL | 随对话发给模型 | 云端模型：会 |

也就是说：**能本地算的绝不外发**，模型只看到"你允许它看到的聚合结果"，看不到你的原始文件。

### 想要绝对零外发？换成本地模型即可

Harness 支持任意 OpenAI 兼容端点。把它指向你局域网里的推理服务（Ollama / vLLM / LM Studio 都行），
再配合本插件，**整条链路——数据、计算、模型推理——全部不出机器**：

```yaml
# cordis.patch.yml
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      local:
        api: openai-completions
        baseURL: http://127.0.0.1:11434/v1   # 你的本地推理服务
        apiKeyEnv: LOCAL_LLM_KEY
        models: [{ id: qwen2.5-coder:14b, name: Qwen2.5 Coder 14B }]
```

再把 `maxRows` 调小、只让模型看聚合结果（`GROUP BY` 之后再问），外发面就趋近于零。

---

## 快速开始

```bash
# 1) 装进 Harness 的 profile（依赖自动安装）
dsh plugin --profile desktop add ./duckbi-dsh-plugin-duckbi-0.1.0.tgz

# 2) 写配置
node <profile>/node_modules/@duckbi/dsh-plugin-duckbi/install.mjs --no-link

# 3) 验证：出现 "ok": true 就是已经在跑
cat ~/.dsh/duckbi/plugin-loaded.json
```

然后随便说一句：

> 把 `D:\数据\销售` 加进来，看看有哪些数据

完整的安装方式（离线 / git / 自定义 profile）、配置项与卸载见
[插件 README](packages/dsh-plugin-duckbi/README.md)。

---

## 真实对话片段

一次完整的多轮分析，原文见 [docs/examples/console.txt](docs/examples/console.txt)：

```
### 区域销售额排名            [duckbi_query]     9 ms
| region | orders | revenue | avg_order | share_pct |
| :---   |  ---:  |    ---: |      ---: |      ---: |
| 西南   |    295 | 799,501 |     2,710 |     20.47 |
…

### 数据体检                  [duckbi_query]
发现 5 个口径问题：Date 与 OrderDate 完全重复、StoreLocation 与 Region 逻辑矛盾、
FREESHIP 促销的运费没有归零、单价与商品无关、退货率 24.8% 且与任何维度无关。
```

**它不只出数，还会告诉你这批数据能不能用。**

---

## 为什么快

- **DuckDB 列存 + 向量化**：370 万行聚合是毫秒级（demo 里 9 ms）。
- **物化表，不是视图**：首次扫描有成本，之后每次查询都命中本地列存。
- **增量扫描**：按 `(大小, mtime)` 判断，改一个文件只重算一个文件。
- **报表可 0 token 重跑**：口径定下来后，`node scripts/report.mjs` 直接出 PDF，不经过模型。

---

## 它明确不做什么

- 不做数据可视化大屏、不做实时流、不做多租户 BI 平台。
- 不解析 `.xls`（老二进制格式）；不支持跨平台拷 `node_modules`（原生包与平台绑定）。
- 不是"把文件塞进上下文让模型读"——那是几万 token 起步且会算错；这里 SQL 在本地算。

---

## 项目结构

```
packages/dsh-plugin-duckbi/   插件本体（可分发的 npm 包，78 KB tarball）
  lib/                        engine / ingest / catalog / sql / chart / exporters / tools
  install.mjs                 自包含安装器（软链 + 写配置 + 卸载）
  test/                       55 项端到端断言 + 图表/导出冒烟测试
scripts/
  install.mjs                 仓库内安装入口（转发到包内安装器）
  demo.mjs                    造演示数据，跑通全流程，产出样例
  report.mjs                  报表模板：一条命令出 PDF + Excel
docs/
  architecture.zh.md          设计文档：摄入路径、并发模型、取舍
  examples/console.txt        真实对话输出
```

## 开发

```bash
cd packages/dsh-plugin-duckbi
npm install
node test/run-tests.mjs      # 55/55：真实 cordis + 真实工具管线 + 真实 DuckDB
node test/chart.smoke.mjs    # 图表 15 例
node test/export.smoke.mjs   # Excel/PDF 87 项断言
```

设计取舍、失败案例与限制见 [docs/architecture.zh.md](docs/architecture.zh.md)。

## 许可

MIT · 见 [LICENSE](LICENSE)。
