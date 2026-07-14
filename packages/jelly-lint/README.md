# JellyLint 配置 DSL（`jellylint.json[c]`）

> JellyLint 是 Rejelly 仓库内部的架构边界治理工具。`@rejelly/jelly-lint` 是 `private: true` 的 Rust CLI，不作为用户项目 API 发布；本文面向维护本仓库 `jellylint.json[c]` 的贡献者。

JellyLint 用一份声明式配置描述 **逻辑节点**（vertices）、**允许的依赖方向**（正向边），以及可选的 **规则补丁**（在不改写拓扑的前提下放宽或收紧边检查）。配置文件位于仓库根目录，解析优先级依次为：`jellylint.json`、`jellylint.jsonc`，也可用 CLI 的 `--config` 指定路径。

JSON Schema 定义见仓库内 `packages/jelly-lint/jellylint.schema.json`。

顶层结构固定包含 `nodes` 与 `graph`；`rules` 可选：

```jsonc
{
  "nodes": { /* ... */ },
  "graph": { /* ... */ },
  "rules": [ /* ... */ ]
}
```

---

## 1. `nodes`：声明节点（逻辑 ID → 物理归属）

`nodes` 是一个对象：**键**为逻辑节点 ID（必须以 `@` 开头），**值**为该节点对应的源码路径模板或外部模块标识。

### 1.1 内部路径（仓库内文件）

- 值可以是 **单个字符串**，或 **字符串数组**（按顺序尝试，用于多套路径形状）。
- 路径中使用 glob：`*`、`**`、`?`，以及段内的 **`[name]` 占位符**（见下文「命名变量」）。
- 段分隔符在引擎内规范为 `/`（Windows 下的 `\` 会被归一化）。
- 以 **`!` 开头** 的条目表示 **从同一节点的包含集合中排除**（例如排除 mock、测试目录），等价于「同一 `@id」下的减法」，而不是图上的否定边。

```jsonc
"nodes": {
  "@app:[name]": "src/apps/[name]/**/*",
  "@feature:[feat]:db": [
    "src/features/[feat]/db/**/*",
    "!src/features/[feat]/db/**/*.mock.ts"
  ]
}
```

**约束：**

- 节点路径模式里 **不能** 再写其他节点 ID（不能写 `@...` 去引用别的逻辑节点）；需要重复写 glob 或直接维护 `jellylint.json[c]`。
- 支持声明 **外部依赖** 作为「只按 import 解析、不扫盘」的节点：见下。

### 1.2 外部依赖（`npm:` / `node:`）

- `npm:包名`：将逻辑节点绑定到该 npm 包（import 说明符里通常可写作包名或子路径）。
- `node:模块`：Node 内置模块，如 `node:fs`。

```jsonc
"@ext:react": "npm:react",
"@ext:fs": "node:fs"
```

内部路径与外部键可以混在同一份 `nodes` 里，由引擎按文件路径或 import 说明符分别解析。

### 1.3 图拓扑里对 `!` 的限制

- **依赖图**（`graph` 里的 `cascade` / `sequence` / `connect`）中，**节点选择子不允许** 使用以 `!` 开头的「否定选择」；否定的语义由 **`rules` 的 `match`** 提供（见第 3 节）。

### 1.4 重叠声明与归属解析（单一归属）

多个节点的路径模式可以物理重叠（例如同时声明 `@cli` = `src/cli/**/*` 与 `@cli:ui` = `src/cli/ui/**/*`）。引擎对此的契约如下（实现见 `graph/query.rs` 的 `resolve_internal_by_rel_path_uncached` 与 `graph/overlap.rs`）：

1. **每个文件只归属一个节点**。所有节点的 pattern 参与竞争，胜者按 **`(specificity, 段数)`** 取最大，其中 **specificity = pattern 中字面段的数量**。`src/cli/ui/**/*` 有 3 个字面段，赢过 `src/cli/**/*` 的 2 个——ui 下的文件归 `@cli:ui`。**不会双重计边**。
2. **粗节点会被「掏空」**。细节点覆盖到的文件全部被抢走后，`graph` / `rules` 里写在粗节点上的边对这些文件 **静默失效**——不报错，只是不再匹配。若在图上依赖粗节点表达边界（如 `@cli` → `@shared`），细化节点时必须同步把图改写到细节点（或用 glob 选择子如 `@cli:**` 占层），否则约束悄悄消失。
3. **启动期 overlap 告警**。检测到「broad pattern 完全包含 narrow pattern」会报 `Ownership may be ambiguous; use '!' exclusion patterns`；若 broad 节点已用 `!` 挖掉 narrow 的前缀（两者物理不相交）则不报。想让粗细节点合法并存，唯一姿势是 **`!` 挖除**——此时粗节点只兜住未被细节点认领的「剩余」文件，可用作「禁止新增杂物」的执法节点。
4. **同分平局不可依赖**。两个 pattern 对同一文件给出相同 `(specificity, 段数)` 时，取先遍历到的候选，而节点容器是 `HashMap`，迭代顺序 **不确定**。不要制造同 specificity 的重叠；出现 overlap 告警应当场消除，而不是依赖某次运行的归属结果。
5. **无 glob 的 pattern 自动补 `**`**。`src/cli/index.ts` 会被编译为 `src/cli/index.ts/**` 参与匹配，因此 **单文件节点可行**，且其字面段最多、specificity 天然最高。

---

## 2. `graph`：构建正向边

`graph` 描述 **允许谁依赖谁** 的「白名单」式有向边。可以写 **平面** 图块，也可以写 **多个具名子图**（子图名即键名，如 `frontend_core`），每个子图内结构相同。

每个子图块可包含三类边源（均为可选，可组合使用）：

| 字段 | 含义 |
|------|------|
| `cascade` | 分层流：仅 **`j > i`** 的层间前向边（可跨层）；**不产生同层边 `i → i`** |
| `sequence` | 分层流：仅 **`j = i + 1`** 的相邻层前向边；**不产生同层边 `i → i`** |
| `connect` | 显式 `from → [to...]` 依赖表（可声明 **任意** 节点对，含同层横向依赖） |

### 2.1 `cascade` 与 `sequence`：层级数组

两者都用 **「层」** 的数组：外层数组下标为层号 `i = 0 … n-1`，每层内是若干节点选择子（字符串）。引擎 **`append_flow_edges`** 只为 **`from` 层号 `<` `to` 层号** 的点对生成抽象边；循环变量 **`j` 自 `i+1` 起**，因此 **永远不会生成 `i → i`（同层）边**。

**同层横向依赖**（同一层内节点互相引用）既不包含在 `cascade` 也不包含在 `sequence` 中；若架构要求显式允许，必须在同一子图的 **`connect`**（或其它构图手段）里单独声明。

层间语义差异：

- **`cascade`**：对所有满足 **`i < j < n`** 的 `(i, j)`，从第 `i` 层任一节点到第 `j` 层任一节点生成允许的有向边（**允许跳层**：`j` 可取 `i+1` 直到 `n-1`）。适合允许「跃层」仍视为合法拓扑的讨论结果。
- **`sequence`**：仅对 **`j = i + 1`** 生成边（**不允许跳层**：不存在 `i → i+2`）。适合强制严格流水线顺序。

`cascade` / `sequence` 的值支持两种形态：

- **直接数组**（单条无名流，内部名记为 `default`）：

```jsonc
"cascade": [
  ["@app:[name]"],
  ["@feature:[feat]:ui"],
  ["@shared:vfs"]
]
```

- **具名多流**（同时存在多条并列的层流）：

```jsonc
"cascade": {
  "render_flow": [
    ["@app:[name]"],
    ["@feature:[feat]:ui"],
    ["@shared:vfs"]
  ]
}
```

### 2.2 `connect`：显式边

`connect` 是 **源节点 → 目标节点列表** 的映射，适合表达「某类 UI 必须能依赖同 feature 的 db」「共享封装只能依赖某几个 ext」等。

支持 **直接对象** 或 **按流名再包一层**（与 `cascade` 的 `default` / 多流 一致）：

```jsonc
"connect": {
  "@app:[name]": ["@ext:react"],
  "@feature:[feat]:ui": ["@ext:react", "@feature:[feat]:db"],
  "@shared:vfs": ["@ext:fs"]
}
```

**注意：跨边异构占位符名与连通性**

若在 **`connect`**（以及由 **`cascade` / `sequence`** 展开的层间边）中，**起点模板与终点模板**使用 **不同的** `[name]`（例如 `@feature:[feat]` → `@service:[svc]`），引擎 **不会** 在 `feat` 与 `svc` 之间建立 **1:1 的同名绑定**。拓扑校验里的 `shared_bindings_compatible` 只要求：**同名键** 在来源与目标上的取值一致；若两侧占位符 **键名不同**，则彼此 **无约束**。在此情形下，只要两端各自匹配模板，任意 `feat` 实例与任意 `svc` 实例之间的依赖都可能被判为拓扑允许，语义上接近 **两族实例之间的完全二分连接**（除非通过更紧的 glob / 精确 ID 另行收缩）。

若意图是 **严格的垂直隔离**（例如「同一业务单元的 feature 只能依赖同一单元的 service」），必须让边的两端使用 **完全相同的占位符名称**（如 `@feature:[feat]` → `@service:[feat]`），以便绑定值能在边上对齐。

图上的选择子支持 **精确 ID** 与 **带 `*` / `?` 的 glob**（如 `@core:**`），但 **不能** 以 `!` 做否定（见 1.3）。

### 2.3 平面 `graph` 与多子图

- 若 `graph` 根对象上 **直接** 出现 `cascade` / `sequence` / `connect` 之一，则整段被解析为 **一个** 子图，名称为 `default`。
- 否则 `graph` 的每个 **子键** 是一个子图名，其值为上述 `graph` 块。

---

## 3. `rules`：特殊补丁（策略层，不改拓扑）

`rules` 是 **策略覆盖**：在 **已构建的抽象依赖边** 上，对「某类 `from` → `to` 边」附加 **error / warn / off** 行为。规则 **不增加、不删除** 图上的拓扑边，只影响 **诊断结论**（允许、带告警允许、禁止）。

**评估顺序（对每条有向边）**：

1. 计算 **抽象拓扑** 是否允许该边，得到 `is_allowed_by_graph`（与 `graph` 白名单及绑定一致）。
2. **自上而下** 遍历 `rules` 数组。对每条规则：若 `scope` 与 `is_allowed_by_graph` 不兼容则 **跳过**（如 `scope: "fallback"` 仅在拓扑 **拒绝** 时参与）；否则对 `match` 做 `from` / `to` 匹配。
3. **首条命中的规则** 即 **终局**：取该条 `severity` 作为该边的结果，**不再**考虑后续规则。
4. 若 **没有任何规则命中**，则回退为图语义：`is_allowed_by_graph` 为真则合法，否则 **禁止**。

`graph` 应始终表达 **目标架构**；存量越权依赖应作为「图外非法边」暴露，再靠 `scope: "fallback"` 等规则 **降级为告警**，而不是把技术债写进 `connect` / `cascade` 去「兼容」现实。需要 **硬拦截** 的边（如生产代码依赖测试、UI 直引 `node:`）在 `rules` 前部用 `scope: "all"` + `severity: "error"` 声明；全量债务兜底 `warn` 放在 **后面**，避免宽匹配挡掉精确定界。

单条规则结构要点：

- `match`：**可选** `from` 与/或 `to`；未写的一侧表示 **不限制**（该侧通配）。**例外**：若 **`to` 中出现 `[name]` 占位符**，则 **`from` 不可省略**，且须满足 §3.3–§3.4 的正向模板捕获与绑定契约（否则构建期报错）。
- `match.from` / `match.to`：字符串，或 **非空字符串数组**；可混用 `@` 节点与物理路径 / import 说明符（非 `@` 开头则按路径或 spec 匹配，视边检查上下文而定）。

### 3.1 否定 `!`

- 模式 **以 `!` 开头** 表示 **否定**：从匹配集中 **扣除** 该模式。
- 若 **某一侧** 的 **所有** 模式都是否定的，则引擎使用 **隐式全集** 再减去这些否定（例如「除 `@shared:vfs` 外任何来源」）。

```jsonc
{
  "name": "restrict-fs-access",
  "match": {
    "from": "!@shared:vfs",
    "to": "node:fs"
  },
  "severity": "warn",
  "message": "please access filesystem via @shared:vfs"
}
```

### 3.2 `severity`

仅在 **`match` 命中且未被 `scope` 跳过** 时生效。

- **`error`**（**省略 `severity` 时的默认值**）：一旦命中，该边 **一律按禁止处理**（`Forbidden`），**不受**拓扑是否允许影响；用于高危拦截或写在数组前部精确盖住若干边。
- **`warn`**：一旦命中，该边 **一律按「允许但告警」处理**（`AllowedWithWarn`），用于降级技术债、迁移提示等。
- **`off`**：一旦命中，该边 **一律静默允许**（不报违规）。

若 **没有任何规则命中**，结论完全由拓扑决定（允许 / 禁止）。写了 `match` 就会参与竞争 **首条命中**；不需要补丁时不要添加会误匹配的宽泛规则。

### 3.3 正向代入与占位符（常用写法）

日常治理里最顺手的是 **纯正向代入**：`from` 上一段模板捕获 `[name]`，再代入 `to`，与 `nodes` / `graph` 里跨处统一的占位符直觉一致（例如 `@feature:[feat]:ui` → `@legacy:[feat]:db`）。

- 在 **同一条规则** 里，`from` 上的 **正例** 模式可以 **提取** `[name]`，并 **代入** `to`。
- 若 **`from` 的每一项都是否定**（纯补集），则 **不能** 指望在否定模式里得到稳定的 `[name]` 绑定供 `to` 使用；需要「正例 + 排除子集」时见 **§3.4**。
- **「无源之水」（构建期硬性契约）**：若 `match.to` 中出现 `[name]`，则 **必须** 书写 **`match.from`**，且 `from` 侧 **至少有一条正向模板臂**（带 `[name]` 捕获；纯 glob 臂不产生绑定）能提供 **`to` 中出现的每一个** 同名占位符。引擎在编译规则时校验（`compile_policy_rule` → `validate_rule_placeholder_bindings`）。`from` 捕获多于 `to` 消费 **合法**；`to` 引用 `from` 从未捕获的名字、省略 `from`、`from` 仅有 glob 或全为否定等 **构建期报错**。

**合法：`from` 含正例，`[feat]` 注入 `to`**

```jsonc
{
  "match": {
    "from": "@feature:[feat]:ui",
    "to": "@legacy:[feat]:db"
  },
  "severity": "warn"
}
```

引擎从来源解析出 `feat`（例如 `order`），再把 `to` 渲染为 `@legacy:order:db` 后参与匹配。

以下为 **违反上述契约** 的典型非法写法（配置加载阶段即失败）：

**非法：`from` 全部为否定（构建配置时会报错）**

```jsonc
{
  "match": {
    "from": "!@feature:[feat]",
    "to": "@legacy:*"
  },
  "severity": "warn"
}
```

**非法：`to` 含 `[name]` 但省略 `from`（构建期报错）**

```jsonc
{
  "match": {
    // `from` 省略表示来源通配，但无法为 `[feat]` 提供绑定
    "to": "@service:[feat]"
  },
  "severity": "warn"
}
```

**非法：`to` 含 `[name]` 但 `from` 仅有 glob，无模板捕获（构建期报错）**

```jsonc
{
  "match": {
    "from": "@feature:*",
    "to": "@service:[feat]"
  },
  "severity": "warn"
}
```

**非法：`to` 引用 `[svc]`，但 `from` 正向模板只捕获 `[feat]`（构建期报错）**

```jsonc
{
  "match": {
    "from": "@feature:[feat]:ui",
    "to": "@service:[svc]"
  },
  "severity": "warn"
}
```

在同一条规则里把 **`[name]` 捕获、glob、否定 `!` 揉在一起** 时，需要理解引擎的 **筛选顺序与绑定来源**；这类组合属于 **§3.4** 的进阶内容，团队规范上也可限制滥用，优先用多条简单规则替代。

### 3.4 进阶：集合运算、绑定顺序与边缘 Case

本节描述 **策略补丁层** 上与黑白名单、占位符相关的底层契约；多数仓库只需 **§3.3** 的正向代入即可。**心智负担**往往集中在：试图用「正例全集 + 否定挖空」精细裁剪 `from`，同时又依赖 `[name]` 代入 `to`——此时必须明确 **先匹配哪一层、绑定从哪里来**。

**合法：正例覆盖一族，否定臂与正例有交集（同一 `[feat]` 下抠掉某一类后缀）**

```jsonc
{
  "match": {
    "from": ["@feature:[feat]:*", "!@feature:[feat]:db"],
    "to": "@ext:*"
  },
  "severity": "warn"
}
```

第三段 `*` 在一个路径段内匹配 `ui`、`db` 等 slug，因此 `@feature:auth:ui` 与 `@feature:auth:db` 都能命中正例；否定 `!@feature:[feat]:db` 会拦住 **db** 层，使该 rule 只作用于 **非 db** 的 feature 子域（从同一节点 ID 上抠掉与正例重叠的一支）。

若把正例写成更窄的 `@feature:[feat]:ui`，再配 `!@feature:[feat]:db`，则来源永远不可能是 db，**否定臂与正例无交集，第二条恒为假**，等于多余——应避免这种写法。

#### 集合筛选（Set Matching）与变量捕获（Bindings）的契约

黑白名单式的 **`隐式全集 − 否定`**、或 **`正向并集 − 否定`**，用于判断「节点 / 路径是否落在规则关心的集合里」，这与业界 Linter 的常见写法一致。与之分离的另一问题是：**何时产生传给 `to` 的有效绑定**。为避免「边过滤边绑定」的心智歧义，引擎（及文档）约定如下契约；实现入口见 `packages/jelly-lint/src/graph/query.rs` 中 `policy_from_matches`。

1. **先筛选，后绑定（Filter-then-Bind）**  
   对 `from` 侧：**先做否定筛查**，再做正向归属与变量提取。若节点已被任一否定模式排除，则 **`from` 整侧不匹配**，**不会产生**向 `to` 传递的绑定。不会出现「先在某条正向臂上缓存了 `[feat]`，再被否定打掉却仍把该绑定用在 `to` 上」的路径。

   **样例：** 规则片段如下；来源节点 **`@feature:auth:db`** 会先命中否定 `!@feature:[feat]:db`，**`from` 判定失败**，整条规则不参与，`to` **绝不会**收到 `feat=auth`。来源 **`@feature:auth:ui`** 则否定未命中，再由正向模板得到 **`feat=auth`**，此时才会向 `to` 代入。

   ```jsonc
   {
     "match": {
       "from": ["@feature:[feat]:*", "!@feature:[feat]:db"],
       "to": "@service:[feat]"
     },
     "severity": "warn"
   }
   ```

2. **否定臂不参与跨边绑定**  
   以 `!` 开头的模式只做集合减法；引擎 **不会** 把否定模板（例如 `!@feature:[feat]:db`）中的 `[feat]` 当作 **传给 `to` 的捕获结果**。否定臂内部若局部绑定变量，仅用于判断「本条否定是否命中」，与 `to` 代入无关。

   **样例：** 同上一条配置：绑定 **`[feat]`** 只能来自 **`@feature:[feat]:*`**。否定行里的 `[feat]` 仅在引擎内部判断「是否为 `@feature:auth:db`」时使用，**不会**单独构成传给 `@service:[feat]` 的上下文。

3. **正向臂短路求值（数组顺序即语义顺序）**  
   `match.from` / `match.to` 中的 **每一条正向模式**（无占位符的 glob 与带 `[name]` 的模板）按 **JSON 数组下标 0 → 1 → 2 …** 依次尝试；**首个成功匹配的臂**单独决定本轮结果——若为 **glob**，绑定表为 **空**；若为 **模板**，绑定为该模板捕获到的 `[name]`。**不再**存在「底层先把全部 glob 合并再统一优先于模板」的实现泄漏。

   - **多个正向模板均可命中同一节点**（例如两条模板对 `@module:auth:api:user` 给出不同的 `group`）：只采纳 **最先命中** 的那一条；配置重叠歧义时应改写模板或拆规则，**不可**假设引擎合并多种解读。  
   - **glob 与模板混写**：顺序完全由你控制——若把宽泛 **`@feature:*` 写在 `@feature:[feat]:ui` 之前**，会先得到空绑定，后续模板 **不会**再执行；若需要捕获，应把模板放在前面，或去掉/收窄前置 glob。

   **样例 A — 仅模板、首个命中：** 对 **`@module:auth:api:user`**，两条模板都可能匹配；引擎先试 **`@module:[group]:api:*`**，得到 **`group = auth`** 后即停止，**不会**再用第二条得到 `user`。

   ```jsonc
   {
     "match": {
       "from": [
         "@module:[group]:api:*",
         "@module:*:api:[group]"
       ],
       "to": "@service:[group]"
     },
     "severity": "warn"
   }
   ```

   **样例 B — 顺序决定能否捕获：** 对 **`@feature:auth:ui`**，配置 **`["@feature:[feat]:ui", "@feature:*"]`** 时先试模板，得到 **`feat=auth`**，`to` 可代入；若写成 **`["@feature:*", "@feature:[feat]:ui"]`**，glob 先命中，绑定为空，**`to: "@service:[feat]"` 无法满足占位符**，本条规则整体无法匹配该边（与单测 `rules_match_from_positive_arms_follow_json_order_not_glob_first` 一致）。

   ```jsonc
   {
     "match": {
       "from": ["@feature:[feat]:ui", "@feature:*"],
       "to": "@service:[feat]"
     },
     "severity": "warn"
   }
   ```

### 3.5 `scope`（规则何时参与匹配）

规则可增加 **`scope`** 字符串枚举（默认 **`"all"`**），声明本条规则是否要在「抽象图是否允许该边」（`abstract_topology_allows`，内部含 `shared_bindings_compatible`）之后再决定是否参与诊断。**不引入**新的变量推导，仅复用已有拓扑布尔结果。

| `scope` | 含义 | 典型用途 |
|---------|------|----------|
| **`all`** | 与拓扑无关，`match` 命中即参与（历史默认）。 | 全局策略（如禁用某危险模块），合法 / 非法边一视同仁。 |
| **`fallback`** | 仅当拓扑 **拒绝** 该边时规则才可能生效；拓扑已允许则 **整段跳过**。 | 技术债豁免：只对「越权」边降级为 warn（例如跨 feature service）。 |
| **`topology_allowed`** | 仅当拓扑 **允许** 该边时规则才可能生效；拓扑拒绝则 **跳过**。 | 合法架构上的弃用：图中已允许 `@feature` → `@legacy` 时打迁移告警，且 **不会** 把本应为 Forbidden 的非法 legacy 调用误打成 Warn（避免安全 / 架构后门）。 |

---

## 4. 命名变量（`[name]`）与跨边统一

`[name]` 为 **段级占位符**（`name` 为字母数字与下划线），在 **节点 ID** 与 **路径** 中成对出现即可把「同一段名字」串起来，减少重复、避免为每个 feature 写死一条边。

- **在 `nodes` 中**：`@feature:[feat]:ui` 与 `src/features/[feat]/ui/**/*` 中的 `[feat]` 一致，用于把文件解析到对应逻辑节点。
- **在 `graph` 中**：若一条边的两端使用 **相同** 的 `[name]`（如 `@feature:[feat]:ui` → `@feature:[feat]:db`），拓扑会把 **同一绑定值** 用于两端，表示 **同一实例维度** 上的允许依赖。若两端使用 **不同** 的占位符名（如 `[feat]` 与 `[svc]`），引擎 **不会** 自动配对二者；连通性语义见 **§2.2**（异构名可能导致「族间全连接」而非 1:1 垂直映射）。
- **在 `rules` 中**：`from` 正例若匹配并捕获 `[name]`，则 `to` 中同名占位符会在检查前被 **替换**。跨 feature service、合法依赖弃用等场景见 §5.3 / **`scope`**。

这 **不是** 图灵完备或任意计算，仅为 **模式上的语法糖** 与 **命名占位符在匹配 / 绑定层面的统一**（图中跨边是否共享绑定取决于占位符 **名称是否一致**；规则里正向 glob / 模板的 **数组顺序**见 §3.4「正向臂短路求值」）。

---

## 5. 常见案例

### 5.1 多应用 + 多 feature 目录，同 feature 子层可互依

```jsonc
"nodes": {
  "@app:[name]": "src/apps/[name]/**/*",
  "@feature:[feat]:ui": "src/features/[feat]/ui/**/*",
  "@feature:[feat]:db": "src/features/[feat]/db/**/*"
},
"graph": {
  "cascade": [
    ["@app:[name]"],
    ["@feature:[feat]:ui"],
    ["@feature:[feat]:db"]
  ],
}
```

### 5.2 仅通过共享模块访问 `node:fs`

用 `rules` 表达「非 `@shared:vfs` 依赖 `node:fs` 时告警」，而不在 `connect` 里写否定（图仍只声明正向允许集）：

见第 3.1 节示例。

### 5.3 用规则做「跨 feature 服务依赖」治理

需求：feature UI 依赖 **本 feature** 的 service 合法；依赖 **其它 feature** 的 service 记为技术债并 **warn**。这类「错配」对应拓扑 **拒绝** 该边，因此使用 **`scope: "fallback"`**：拓扑 **已允许** 的边（含 UI → 同 feat 的 `@service:[feat]`、以及图中允许的 UI → `@tools` 等）**不会**命中该补丁规则。

下面与单测 `rules_warn_cross_service_only_when_topology_rejects` 对齐（图中同时允许 UI → service 与 UI → `@tools`）：

```jsonc
{
  "nodes": {
    "@feature:[feat]:ui": "src/features/[feat]/ui/**/*",
    "@service:[feat]": "src/services/[feat]/**/*",
    "@tools": "src/tools/**/*"
  },
  "graph": {
    "connect": {
      "@feature:[feat]:ui": ["@service:[feat]", "@tools"]
    }
  },
  "rules": [
    {
      "match": {
        "from": "@feature:*:ui",
        "to": "@service:*"
      },
      "scope": "fallback",
      "severity": "warn",
      "message": "cross-feature service access is a legacy debt"
    }
  ]
}
```

**合法依赖上的迁移告警（`scope: "topology_allowed"`）**：图中已声明 `@feature:[feat]:ui` → `@legacy:[feat]:db` 时，可在 **仅拓扑允许的边** 上对 `@legacy` 打 warn，督促迁移；对 **图中未允许的** 跨域 legacy 依赖保持 Forbidden，而不会被本条 warn「放行」。示例见单测 `rules_scope_topology_allowed_warns_only_when_graph_allows`。

### 5.4 白名单 + 显式排除 demo

`from` 同时包含 **正例** 与 **否定** 时，表示「大范围内允许，但排除某子集」：

```jsonc
"match": {
  "from": ["@feature:*", "!@feature:demo"],
  "to": "@legacy:*"
}
```

若 **`to` 仍含 `[name]` 且依赖 `from` 模板捕获**，则否定与 glob 的组合方式须符合 **§3.4** 的筛选与绑定契约。

---

## 小结

| 概念 | 作用 |
|------|------|
| `nodes` | 声明逻辑节点与源码 / 外部模块的对应关系；`!` 用于路径排除 |
| 重叠归属 | 单一归属：specificity（字面段数）最高者胜；粗节点被细节点「掏空」后其边静默失效；合法并存须 `!` 挖除，同分平局不可依赖（§1.4） |
| `graph.cascade` / `sequence` | 分层依赖（仅层号递增 `i→j`，无 `i→i`）；`cascade` 可跨层，`sequence` 仅 `j=i+1`；同层横向依赖须 `connect` |
| `graph.connect` | 显式依赖表 |
| `rules` | 在不变更拓扑的前提下按数组顺序匹配；首条命中决定 error/warn/off |
| `scope` | `all` / `fallback` / `topology_allowed`，约束规则是否仅在拓扑允许或拒绝时参与 |
| `[name]` | 段占位符，统一多处以减少重复；规则内可由 `from` 捕获并代入 `to` |

更多行为细节以实现代码与单元测试为准（`packages/jelly-lint`）。
