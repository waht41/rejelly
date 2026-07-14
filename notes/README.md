# notes/ — 维护者知识库

> 给维护者（和未来的自己/AI）的内部记录。**不是面向用户的文档**（那在 `docs/`）。
> 这份 README 是目录地图 + 约定速查，**先读它，别每次重扫整个目录**。

## 这里放什么

三类**文字记录** + 一个**查看器应用**。文字记录全是带 frontmatter 的 Markdown，三类各有明确分工：

| 目录 | 类型 | 一句话 | 何时写 | 索引方式 |
|------|------|--------|--------|----------|
| `issues/` | issue | **一个可关闭的工作项**及其结论 | 有个具体的、能做完的事（修 bug、补文档、加测试） | 文件名前缀 `ISSUE-NNNN`，**查看器自动扫描** |
| `investigations/` | investigation | **诊断过程**：证据、取舍、被否论据、未决问题 | 话题太大/太不确定，装不进单个工作项 | 文件名前缀 `INV-NNNN`，`investigations/README.md` 手动索引 |
| `decisions/` | decision record (DR) | **最终规则**：「我们定了 X，否了 Y/Z，因为…」 | 一条未来人会照着做、否则会反复重提的约定 | `decisions/README.md` 手动索引 |

**判断放哪**（决策树）：
- 只是「修了个 bug / 要做某件事」→ **issue**。
- 在「查清楚某事到底怎么回事」、还没定论 → **investigation**。
- 已经定论、要立成**今后必须遵守的规则**（被否方案和选中方案一样重要）→ **DR**。

典型生命周期：`investigation`（active，收集证据）→ 抽出 `issue`（落地工作）和/或 `DR`（沉淀规则）→ investigation 转 `resolved`，**不删**，留证据链并反链到 issue/DR。

> 说明：0001 起的历史 issue/investigation/DR（pre-launch 阶段的记录）已整体归档至 `notes/.archived/`（本地留存，不进公开仓库），新文档从各类型的下一个编号续起。归档目录含完整生命周期实例可供参考。

## 各类型怎么写（详规见子目录 README）

每个子目录的 `README.md` 是该类型 frontmatter / 命名 / 生命周期的**唯一权威**，这里只给指针，避免漂移：

- **issue** → [`issues/README.md`](issues/README.md)。身份来自**文件名前缀** `ISSUE-NNNN`（不要在 frontmatter 写 `id`）；前缀定了就不能改，slug 可调。必填 `title / severity / status / createdAt / updatedAt`，其余为可查询元数据。
- **investigation** → [`investigations/README.md`](investigations/README.md)。身份来自**文件名前缀** `INV-NNNN`（按 `createdAt` 顺序编号，不重编号），slug 可调。状态 `active|later|resolved|superseded|archived`。
- **DR** → [`decisions/README.md`](decisions/README.md)。状态 `proposed|accepted|superseded`；规则用陈述句写（"X 落在 Y"），不写成「我们倾向…」。`DR-NNNN` 顺序编号，**不重编号，只 supersede**。

通用约定：
- **日期**用绝对 `YYYY-MM-DD`，改动时更新 `updatedAt`/`decidedAt`。
- **交叉引用**：仓内文档互引一律用相对 Markdown 链接 `[类型: 标题](相对路径.md)`，**显示文本带类型词** `DR:` / `INV:` / `ISSUE:`（如 `[DR: span 属性唯一载体](decisions/DR-0001-span-attribute-bag.md)`），便于读源码/diff 时分清类别；查看器用 `react-markdown`，这种链接渲染为真链接，而 `[[…]]` 只会显示为字面文本。注意显示文本是**手写、不随路径自动更新**的：改文件名时编辑器只跟改 path，reword 标题后需手动校显示文本。**不再使用 `[[…]]` wiki 链接**（含指向仓外的概念锚）：仓内目标用 path 链接，仓外事实直接用自包含的人话写进句子。链可以先于目标存在。
- **证据**用 `file:line` 形式列在 frontmatter 的 `evidence:` 或正文里，core 改动后注意核对行号是否漂移。
- **DR 是其规则的唯一真相**：issue/investigation 应**链接** DR 而非复述规则。

### 旧 backlog 的迁移关系

曾有一套历史 backlog 用形如 `RECALL-01`、`MEM-04`、`RES-03` 的条目 ID（位于 `docs/draft/` 下，**该目录后期会整体删除**）。新工作一律走 `notes/`（issue/investigation/DR）；若某条新记录承接了那批旧 ID，用 frontmatter 的 `legacyIds: [RECALL-01]` 留个可搜索的回链即可，正文不要链接或依赖 `docs/draft/` 里的任何文件（它会消失，链接会死）。

> **`notes/` 不引用 `docs/draft/`。** draft 是临时/将删目录；notes 要长期自洽，需要的背景就内联成自包含的句子，需要的引用只指向 `src/`、`docs/api/` 或 `notes/` 自身。

## 查看器应用

`notes/` 同时是个小型本地查看器（Fastify + Vite + React），把 `issues/` 渲染成可浏览/筛选的列表。

```bash
cd notes
pnpm install        # 首次
pnpm dev            # server(tsx watch) + client(vite) 并行起，浏览器开 vite 提示的地址
pnpm build          # tsc -b --noEmit + vite build（产物在 dist/）
pnpm preview        # 预览构建产物
pnpm typecheck      # 仅类型检查
```

要点：
- 查看器**只扫 `notes/issues/`**（见 `src/server/issue-store.ts`：按 `ISSUE-\d{4}` 文件名匹配，解析 frontmatter）。**investigation / DR 不进查看器**，靠各自 README 索引 + 直接读 Markdown。
- 新增 issue：丢一个 `ISSUE-NNNN-slug.md` 进 `issues/` 即被收录，无需注册。
- frontmatter schema 在 `src/shared/issues.ts`；必填字段缺失或格式错会在读取时报错。
- 新增 DR / investigation：记得**手动**在对应 `README.md` 的 Index 里补一行。

## Lint（文档 frontmatter）

```bash
cd notes
pnpm lint:doc       # 校验 issues/investigations/decisions 的文件名与 frontmatter
# 仓库根聚合入口（委托到本工作区）：
pnpm lint:docs      # = pnpm --filter @rejelly/notes lint:doc
```

`lint:doc` 跑 [`script/lint-docs.mjs`](script/lint-docs.mjs)，对三类记录各自校验：

- **文件名**符合规则（`ISSUE-\d{4}…` / `DR-\d{4}-…` / `INV-\d{4}-…`）；
- **必填 frontmatter** 齐全（如 issue 的 `title/severity/status/createdAt/updatedAt`）；
- **枚举值合法**（`status`、`severity`、`type`），`issue` 禁止 `id` 字段（身份来自文件名）；
- **日期**为 `YYYY-MM-DD`（`createdAt/updatedAt/decidedAt/closedAt`）。

它**只**校验本目录的文档元数据，不碰代码。`README.md` 被跳过。新增/改动记录后跑一遍它，绿了再提交。

> 注：notes 工作区**不**参与本仓的架构依赖 lint（`jelly-lint` / `jellylint.json`）—— 那是 `src/` 代码包的事，本目录是文档。

## 速记

- 写之前先想：**工作项 / 诊断 / 规则**，对号入座，别混。
- 已有文件覆盖同一主题就**改它**，别新建重复。
- 结论沉淀进 issue/DR 后，investigation 留作证据，转 `resolved` 不删。
