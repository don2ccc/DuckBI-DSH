# Changelog

## 0.2.0

### 富报表

- `duckbi_export` 新增 `sections`，一次调用生成多节 PDF + 多工作表 Excel：
  `kpi` 指标卡、`table` 格式化表格、`chart` 图表、`text` 结论文本。
- PDF 支持 KPI 卡片、图表缩放嵌入、标题与图不分页；图表只渲染一次，PDF 与 Excel 共用查询结果。
- `format` 新增 `both`，同时产出 PDF 与 Excel。

### 更省 token

- 目录/扫描输出默认聚合为摘要，`detail: true` 才逐文件/逐表展开。
- `duckbi_schema` 支持 `query` 表名搜索，唯一命中时直接返回列信息。
- 5 个工具描述压缩到约 2.5 KB，并新增测试防止回涨。

### 更好用

- `duckbi_source` 支持直接登记**单个文件**，只扫描该文件。
- 目录、扫描、catalog 渲染增加上限与省略提示，避免大目录刷屏。
- schema 搜索无匹配时给出明确提示。

### 性能

- DuckDB 配置 `temp_directory`、关闭 `preserve_insertion_order`、设置 `checkpoint_threshold`。
- 目录扫描的 `stat` 改为有界并发；删源时清理转码/解压缓存。
- schema 统计在 50 万行以上切换为近似去重计数。
- 富报表只导出 Excel 时不再渲染图表 PNG。

### 测试与文档

- 端到端断言从 55 项增加到 64 项，覆盖紧凑输出、schema 搜索、单文件注册、富报表与引擎配置。
- 中英文 README、插件 README 与架构文档同步更新。
- demo 增加多节富报表示例；报表模板把图表嵌入 PDF。

## 0.1.0

- 首个版本：DuckDB 本地分析、5 个工具、Markdown 表格、PNG 图表、Excel/PDF/CSV/Parquet/JSON 导出。
