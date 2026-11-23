# jiyi P0 处置设计：同源借权（模型经浏览器标签调用 `/api/jiyi`）

状态：草稿（待用户拍板项见 §E.3）｜日期：2026-11-23｜适用版本：**v0.1.41（工作区，未提交；提交版为 v0.1.40）**
行号取自 2026-11-23 18:55 的工作区。撰写期间同一工作区正被其它改动推进（版本号、日志恢复跳过、历史裁剪），行号可能再次漂移，引用时以符号名为主、行号为辅。
性质：**只读设计文档**。本文不含代码改动，未改 `lib/`、`test/`，未动 `storages/`，未重启 DSH。

标注约定：

| 标记 | 含义 |
| :--- | :--- |
| 【实测】 | 队友在本机实际复现，或本文作者实际执行得到 |
| 【代码】 | 本次通读代码确认，附文件与行号（行号以 2026-11-23 工作区为准） |
| 【推断】 | 由已核实事实推理得出，未单独实测 |
| 【未核实】 | 需要 DSH 上游能力或后续实测才能确认 |

---

## 0. 结论摘要

1. **这不是「鉴权缺失」，是「身份不可区分」。** `/api/jiyi` 由 DSH 网关按 owner 身份鉴权（裸 curl 401）【实测】，但处理器只拿到 `request`，拿不到 peer/channel【代码：`lib/index.js:1036`】。于是同一个 owner 身份下，「人点的」与「模型借浏览器标签点的」在服务端完全等价。
2. **三个候选方案里，只有方案 3（通道侧）能成为授权边界。** 方案 1 的票据在纯 HTTP 同源条件下可被模型自行消费（§C.1.2 给出论证）；方案 2 是止损与可发现性，不是授权。任何「HTTP 上有、标签里拿不到」的东西都不存在——同源即同权。
3. **推荐顺序：Phase 0（jiyi 自己就能做，先止损与留痕）→ Phase 1（dsh-browser 收口，最便宜的真边界）→ Phase 2（DSH 上游传 peer / app-shell 凭据）。** 在 Phase 2 落地前，不要对外宣称「P0 已消除」。

---

## A. 威胁模型

### A.1 事实基线

| # | 事实 | 来源 |
| :--- | :--- | :--- |
| F1 | jiyi 在 Host 注册唯一管理接口：`ctx.connection.fetch.register({path:'/api/jiyi',methods:['GET','POST'],requestBody:'buffered',fetch})` | 【代码】`lib/index.js:1036` |
| F2 | 该接口的认证来自 DSH 网关的 owner 身份；裸 `curl` 返回 401 | 【实测】队友 |
| F3 | 处理器签名只有 `request`；处理器内可读的只有 method、URL、headers、body，**没有 peer、channel、发起 surface 字段** | 【代码】`lib/index.js:1036-1082` |
| F4 | 同进程 agent 可调用 `dsh_browser_open({url, localOrigin})`；`localOrigin` 只校验「是 loopback 且与目标同源」，不排除 Host 自身 origin | 【代码】`plugins/dsh-browser/lib/index.js:158-163` |
| F5 | 用 Host 自身 origin 打开的标签带着 owner Cookie；`fetch('/api/jiyi?op=memories&memoryLimit=1')` 返回 200 与真实记忆 | 【实测】队友 |
| F6 | 另有 `dsh_browser_open_host`，语义就是「由桌面宿主持有认证、打开 DSH Host 页面」的受控标签；测试断言插件不读凭据、宿主负责认证 | 【代码】`dsh-browser/lib/index.js:45,210-213`；`test/tools.test.mjs:291-305` |
| F7 | 兄弟插件 dsh-tongxin 已经把「loopback + Origin 校验」做到头（Host/Origin 双查），这仍挡不住本攻击——攻击标签的 Host 与 Origin 都等于 Host 自身 | 【代码】`plugins/dsh-tongxin/plugin-src/management-rpc.mjs:23-31,52-53` |
| F8 | 面板的「删除→确认删除」只是客户端两步状态，直接 `POST {"op":"delete"}` 一步完成 | 【代码】`lib/client.js:98`、`lib/index.js:1004` |

F6 与 F4 是两条独立入口：即便 F4 被堵住，F6 仍可能提供「带认证的同源标签」。这是方案 3 必须同时处理两者的原因（§C.3）。

### A.2 谁能触发、怎么触发

| 角色 | 能力来源 | 是否受本设计约束 |
| :--- | :--- | :--- |
| 主模型（agent） | 同进程，注册了 `jiyi_search`（只读）与浏览器工具 | 是，主要威胁 |
| 被注入内容的远程页面 | 通过对话上下文驱动同一套工具 | 是，同一攻击面 |
| 用户手动操作 | 面板（同源 fetch） | 是（就是被保护的对象） |
| 其它插件 / 外部脚本 | 独立进程，无 owner 凭据 | 否（401）【实测】 |

触发链条（已核实的那条）：

```
agent ──dsh_browser_open(url=Host origin, localOrigin=Host origin)──▶ 自有标签（owner Cookie）
      ──dsh_browser_evaluate(fetch('/api/jiyi?...', {credentials:'same-origin'}))──▶ 网关认为 owner
      ──▶ 处理器执行 operation()，读写全部记忆与设置
```

第二条链条（代码核实、未实测）：

```
agent ──dsh_browser_open_host()──▶ 宿主认证过的 Host 标签 ──evaluate(fetch)──▶ 同上
```

不能成立的链条：直接用 shell/`curl` 打接口——没有 owner 凭据，401【实测】。

### A.3 影响面

**读**（全部经 GET，无任何额外门槛）：

| op | 暴露内容 | 依据 |
| :--- | :--- | :--- |
| `state` / `memories` | 记忆正文、来源、证据 quote、决策日志、冲突、巩固任务、设置、项目、绝对路径 `paths.dataDir`、计数、`recoverySkips`（会话 id 与错误文本） | 【代码】`lib/index.js:1041-1057`、`state()` `lib/index.js:830-843` |
| `state.retrievals` | 召回账本，含**用户原话 query** 与命中记忆 id | 【代码】`lib/index.js:842` |
| `changes` | 会话最近的记忆变更批次 | 【代码】`lib/index.js:1058` |
| `failedQueue` | 失败任务的错误文本 | 【代码】`lib/index.js:1059-1065` |
| `search` | 按任意 query 触发一次真实检索（含判别器 LLM 调用） | 【代码】`lib/index.js:1066` |
| `source` | 任意「被记忆引用过」的原始会话事件全文 | 【代码】`lib/index.js:1022-1032` |

`source` 是隐私最重的一条：它把记忆的「引用定位」变成了「可读原文」，而记忆正文本身在注入前会脱敏（D11），原始事件不会。

**写**：见 §B。**成本**：`search`、四个 `verify*`、`retry`、`consolidation-trigger` 都会真实调用用户的模型提供方；没有速率限制，也没有每次调用的批上限。

### A.4 为什么宿主侧无法区分 peer

三层原因，逐层收紧：

1. **注册 API 没给。** `fetch` 处理器只有 `request`（F3）。没有 `peer`、没有 `surface`、没有「这个请求来自应用外壳还是内嵌标签」。
2. **HTTP 头没差。** 应用面板的 fetch 与内嵌标签的 fetch 来自同一个 Electron 浏览器进程、同一个 origin、同一份 Cookie。`Host`、`Origin`、`Cookie`、`User-Agent`、`Sec-Fetch-*` 全部一致；自定义头同源页面也能自己加。唯一「页面不能改」的头是 `Cookie`/`Origin` 这类 forbidden header，而它们的值本来就该一样。dsh-tongxin 的 `isLoopbackRequest` 已经是这套判据的上限，对本攻击无效（F7）。
3. **同源即同权。** 只要标签与面板是同源，任何「只有面板能拿到」的 HTTP 资源（路径、令牌、票据、页面内嵌的 nonce）标签都能拿到。【推断】这条推论是 §C.1 判定的基础，也是为什么方案 1 单独不成立。

### A.5 本威胁模型**不**覆盖

- **agent 具备无限制 shell 时的直读数据库。** 同一用户身份下 `$DSH_HOME/storages/jiyi-v2/memory.sqlite` 可读可写（`0700/0600` 只挡别的用户）。这种情况下 HTTP 鉴权不是短板，本设计的收益主要是「不静默、可审计」。
- **具备桌面控制（cua/无障碍点击）的 agent。** 它能点面板上的确认按钮。§C.1 的「必须人点」因此只对没有桌面控制权限的 agent 成立。
- **宿主被其它插件或用户本人破坏**，以及本地恶意软件。
- 网关/Session 凭据本身的泄露。

---

## B. 写操作清单与破坏性分级

`operation(body, signal)` 共 18 个分支（`lib/index.js:844-1034`）。按「是否改变持久状态」分类：

| op | 行号 | 持久落点 | 破坏性 | 可逆性（就现有 API 而言） |
| :--- | :--- | :--- | :--- | :--- |
| `settings` | 846-872 | 覆写 `settings.json`（`saveSettings`，`lib/index.js:161-168`） | **高（不可逆）** | 没有历史版本、没有备份；只能重新手填。空补丁 `{}` 是「恢复默认」（D7），不是「不改」 |
| `delete` | 1004 | `deleteMemory`（`lib/store.js:637-668`） | **高（不可逆）** | 见 §B.1：版本身份保留、正文与 quote 永久销毁；`putMemory` 明确「Inactive memory cannot be revived」（`lib/store.js:531`），**没有恢复接口** |
| `correct` | 986-1003 | `replaceMemory` → `putMemory`，版本 +1 | **中** | 旧版本快照留在 `memory_versions`，但没有读/回滚接口；只能人工读库【代码】`lib/store.js:653-658` 证明快照含正文 |
| `resolveConflict` | 881-885 | `store.resolveConflict`（`lib/store.js:921-964`） | **高（替代路径）** | `same_claim_newer`/`temporal_change` 走 supersede：旧记忆 `status='superseded'`、版本 +1、清向量与 FTS（`lib/store.js:512-526`），无撤销接口 |
| `set-inclusion` | 873 | `setMemoryInclusion`（`lib/store.js:730-743`） | **中（且带自锁）** | 可切回 `searchable`；但 `user_controlled` 一旦为真**永不回退**（`Number(userControlled \|\| memory.userControlled)`），没有任何接口能清掉 |
| `feedback` | 874-880 | `recordRecallFeedback`（`lib/store.js:965-998`） | **中** | `explicit_wrong` 会把 `review_state` 置 `pending` 并开冲突组，记忆立即退出召回；只能靠裁决/纠正结案（D5/D8） |
| `consolidation-trigger` | 924-930 | 清 `consolidationLastEnqueuedAt` 并触发后台巩固 | **中（间接）** | 巩固在满足「明确用户证据 + 置信度」时可 supersede（`lib/index.js:651-665`）；本条只是绕过间隔限制并消耗 token |
| `createMemory` | 968-985 | 新记忆 + 一次 embedding | **低（可追加）** | 可被 `delete` 移除；但正文由调用方自拟，可成为后续「重要记忆」注入的载体（§B.2） |
| `project` | 1011-1019 | 项目重命名 / 别名集合覆盖 | 低 | 可再改回 |
| `addProjectAlias` | 1020 | 追加别名 | 低-中 | 可删除；但新增别名会影响项目解析【推断】 |
| `deleteProjectAlias` | 1021 | 删除别名 | 低 | 可加回 |
| `retry` | 1005-1010 | 重排队列任务 + 清熔断（`lib/store.js` `retryJob`） | 低（成本） | 不破坏数据，消耗 token |
| `verifyExtraction` / `verifyAdjudication` | 953-967 / 886-923 | 写 `extractionState` / `adjudicationState` 元数据 | 低 | 覆盖状态字段，可重验 |
| `verifyEmbedding` / `verifyRelevance` | 931-932 | 无持久写 | 无 | — |
| `verifySourceBoundary` | 933-952 | 无持久写，**但对真实记忆做一次外部 LLM 调用** | 低（数据外发 + 成本） | 入参被强校验为现存 id/version/sha256，不接受自造事实 |
| `source` | 1022-1032 | 无写 | 读（隐私） | — |

### B.1 删除到底是什么

`deleteMemory`（`lib/store.js:637-668`）**不是物理删除，也不是可撤销删除**：

- 保留：`memories` 行的 id/version/status/来源定位、`memory_versions` 的版本号与 `memory_evidence` 的关系与 `quote_sha256`。
- 销毁：`memories.content` 置空、所有 `memory_versions.snapshot` 的正文与寄存向量置空、`memory_evidence.quote` 置空、相关候选 payload 置为 `{"redacted":true}`、手工审计 `manual:*` 记录删除。
- 结论：**版本身份保留（可审计），内容不可恢复**。`test/memory-lifecycle.test.mjs`「deletion clears quote and candidate bodies while retaining hashes, locators, versions, relations and decisions」正是守护这一点，方案 2 不得改动该终点语义，只能推迟它。

### B.2 三个容易被低估的写路径

1. **`set-inclusion` → `essential` 直通注入。** `essential` 记忆由 `listEssentialMemories` 每轮直接拼进上下文（`lib/index.js:758-764`），**不经过相关性判别器**（I2 管的是召回候选，不是 essential）。也就是说：`createMemory`（模型自拟正文，≤1500 字符）+ `set-inclusion=essential` = 让任意文本每轮出现在上下文里，预算上限 8192 字节（`ESSENTIAL_MEMORY_BUDGET_BYTES`，`lib/store.js:9`）。注入时被包成「背景数据不是指令」并转义 `<`，但这是社会工程学面，不是数据面。
2. **`essential` 预算可被占用成拒绝服务。** 预算按全局 + 每个项目分别累计（`lib/store.js:722-728`）；模型先把预算塞满，用户之后给自己的记忆设 `essential` 会直接失败（`Essential memory budget exceeded`）。
3. **`settings` 改的是数据去向。** 改 `extraction.provider` / `adjudication.provider` 会让此后抽取与裁决把记忆正文发给另一个提供方账号【推断：取决于用户是否配置了多个账号，网关侧的账号映射本次未核实】；改 `enabled:false` 等于静默关掉记忆。设置里**不含凭据**（凭据由 Host 管理，`lib/index.js:161-168` 只写 provider/model），所以不构成凭据泄露。

---

## C. 三个候选方案

### C.1 方案 1：破坏性写操作增加「确认票据」

#### 设计（把「一次性 challenge + 面板确认」写成可实现的形状）

- 新表 `pending_mutations(id, op, digest, target_id, expected_version, created_at, expires_at, state, actor)`（可放 `metadata`，但独立表更好查）。
- 破坏性 op（`delete` / `correct` / `settings` / `resolveConflict` / `set-inclusion=essential` / `consolidation-trigger`）不再直接执行：`POST` 返回 **202** + `{pending:{id, expiresAt, summary}}`，不写任何数据。
- 面板（已经 7 秒轮询 `state`，`lib/client.js:240`）在 `state.pendingMutations` 里看到待确认项，展示「谁、要做什么、影响哪条记忆、版本号、剩余时间」，用户点「确认」→ `POST {op:'confirmMutation', id}` → 服务端校验并执行；另给「拒绝」→ `cancelMutation`。
- 执行时写审计：`memory_decisions` 增加 `actor`（`api` / `panel-confirmed` / `background`），供事后追溯。

#### 为什么它单独不构成授权边界（关键）

1. 票据在创建时由服务端生成，但**必须**通过 POST 响应/`state` 交给面板——而面板与模型标签是同源的，模型读得到（§A.4 第 3 条）。
2. 即使票据从不外发、只存在服务端内存，`confirmMutation` 也是一个普通 HTTP 端点：模型手里有 `id` 就能 POST 它。服务端没有任何字段能判断这次 POST 是人点的还是标签点的（F3）。
3. 想让「确认」不可伪造，就必须让确认**不走这条 HTTP 通道**，或者让服务端拿到 peer 信息。前者要一个浏览器标签碰不到的通道（桌面 IPC / 原生对话框 / unix socket + 面板可读的凭据），后者要 DSH 上游改动。

因此方案 1 的正确表述是：**「把静默破坏变成可见待确认」——可发现性与摩擦，不是授权。** 它仍然有价值：用户能在 7 秒内看到「模型请求删除 3 条记忆」，而不是五分钟后发现记忆没了；配合 §C.2 的限速与告警，攻击从「无声」变成「吵闹」。

**能让它变成边界的两个前置（都不在 jiyi 手里）**：

- 上游把 `peer`/`surface` 传给 fetch 处理器（方案 3b）；
- 或 DSH 客户端提供「只有应用外壳能调用」的确认通道，且该凭据不出现在任何同源页面可达的地方【未核实：DSH 的 client slot 是否有 host→client 的非 HTTP 数据通道。dsh-tongxin 的 `connection.rpc.call('/api', ...)` 走的是同一条 `/api` HTTP 承载（`plugin-src/management-rpc.mjs:94-99`），不能当作反例】。

#### 五个维度

| 维度 | 结论 |
| :--- | :--- |
| 改动面 | `lib/index.js`（operation 拆分 + 新 op + state 字段）、`lib/store.js`（新表 + 读写）、`lib/client.js`（待确认区 + 确认/拒绝按钮）、`docs/API.md`、`docs/INVARIANTS.md`（新 I 条目）、测试 |
| 能否被绕过 | **能。** 模型自己 POST `confirmMutation` 即可，代码层无法区分。只在「模型没有 HTTP 写权限」或「上游给了 peer」时才成立 |
| 对正常用户操作的影响 | 每次破坏性写多一次点击；批量删除变成逐条确认（需要「本次会话内确认 N 条」的批处理 UI，否则体验明显退化） |
| 实现成本 | 中（约 300–500 行 + 迁移 + 客户端一屏 + 测试） |
| 需要 DSH 上游改动 | **要**（否则只是摩擦）。上游只需在 fetch 处理器上多给一个字段，jiyi 侧改动很小 |

### C.2 方案 2：软删除 + 撤销窗口 + 写限速与批量上限

#### 设计

1. **两阶段删除。** `delete` 不再直接 `deleteMemory`：写一条 `pending_deletions(memory_id, requested_at, purge_after, requested_by, expected_version)`（**新表，不动 `memories.status` 的 CHECK 约束**，因此不必把 `SCHEMA_VERSION` 从 4 升到 5：`lib/store.js:145` 起的建表脚本每次打开都会执行，且全部是 `CREATE TABLE IF NOT EXISTS`）。
2. **窗口内不进注入。** `_memoryFilter` 的 `recallOnly` 分支加 `NOT EXISTS(SELECT 1 FROM pending_deletions WHERE memory_id=memories.id)`（`lib/store.js:680-702`），使待删记忆立即退出召回/essential/普通检索，与 I4、I13、I14 的取向一致：**先隔离，后落定**。
3. **撤销。** `POST {op:'undoDelete', id}` 在窗口内删除待删记录，记忆原样回到 active。用户在面板上看到「3 条待删除 · 剩 9:41」+ 撤销按钮。
4. **落定。** 定时器（复用 `pumpLifecycle` 的两秒节拍，`lib/index.js:1118`）在 `purge_after` 到期后调用现有 `deleteMemory`，终点语义与今天完全一致（保住 §B.1 的可审计性）。
5. **限速与批量。** 进程内滑动窗口计数：破坏性写每分钟 ≤ K（建议 20）、全部写每分钟 ≤ 60、单请求影响条数 ≤ 1（`delete`/`correct` 天然单条）；超限返回 429 + `RATE_LIMITED`，并写入 `metadata('writeBurst')` 供面板红色提示。

#### 为什么它是真有效的（但只是止损）

- 生效机制是「**不行动**」而不是「识别发起者」：窗口内数据还在，用户看到提示就能撤销。这不需要任何身份判据，因此同源绕过打不穿。
- 模型可以等窗口过去让删除落定，也可以把次数控制在限速以内。所以它降低的是「一次误判/一次注入 = 永久损失」，不是「能否写」。
- 限速同样不是边界，作用是**把批量破坏变成可看见的节奏**，并给告警一个阈值。

#### 五个维度

| 维度 | 结论 |
| :--- | :--- |
| 改动面 | `lib/store.js`（新表 + 过滤器 + purge + 计数）、`lib/index.js`（delete 改道、undoDelete、限速中间件、state 暴露）、`lib/client.js`（待删除区 + 倒计时）、`docs/API.md`、`docs/INVARIANTS.md`（新 I 条目）、测试 |
| 能否被绕过 | 不能绕过「窗口内可撤销」；能绕过「阻止删除」——它会最终落地。模型也可主动连发多次以缩短感知时间，但每次都在面板可见 |
| 对正常用户操作的影响 | 正面：删除可撤销。代价：删除不立即「干净」（正文在库里多留 N 分钟），以及一次额外的面板阅读 |
| 实现成本 | 中（限速部分小；软删除涉及召回过滤与 purge 生命周期，需要迁移与恢复测试） |
| 需要 DSH 上游改动 | **不需要** |

### C.3 方案 3：通道侧加固

三个子项按「谁改」分层：

#### 3a. dsh-browser：拒绝把 Host 自身 origin 授权给标签（便宜、可立即做）

- `localOrigin` 校验（`plugins/dsh-browser/lib/index.js:158-163`）增加一条：拒绝 Host 自身 origin，以及任何与 Host 同 host:port 的地址。
- **前置任务**：`plugins/dsh-browser/docs/DECISIONS.md` 的 D1 声称「浏览器侧已拒绝与 DSH Host 同端口的地址」，但本次实测（F5）显示指向 Host 自身 origin 的标签仍打开并读到 200。**两者矛盾，根因未定位**（宿主 asar 内实现本次未读取）。在根因查清前，这条改动是「加固一个可能本来就该拒绝的入口」，可能只是修一个回归。
- **必须同时处理 `dsh_browser_open_host`**（F6）：它的语义就是给模型一个带认证的 Host 页面。若它被保留，3a 只是换了一条门。可选收口：(i) `open_host` 返回的标签标记为 unprivileged（由宿主在标签层面拒绝跨到插件 `/api` 的直接写方法）；(ii) 干脆不把 `open_host` 暴露给模型，或仅在用户显式要求时可用；(iii) 要求插件 `/api` 的写方法在 Host 页面上下文里额外带一个由应用外壳注入的凭据（见 3c）。

#### 3b. DSH 上游：让 fetch 处理器看到请求来源

- 在 `ctx.connection.fetch.register` 的 handler 上增加 `peer` / `surface`（例如 `{surface:'app-shell'|'embedded-tab'|'external'}`），或提供注册选项 `requireUserPresence`。
- 这是**唯一能让 jiyi 用两行代码获得真边界**的方案：破坏性 op 检查 `surface!=='app-shell'` 即拒绝。
- 实现要点（给上游的建议，非本次可实现）：桌面壳能区分「应用窗口的 renderer」与「内嵌浏览器标签的 webContents」；前者可以给请求打上不可伪造的标记。**web 模式（外部 Chrome 访问）没有这个区分能力**——外部浏览器里标签与外壳同源同权，只能靠人机交互（原生确认）兜底。

#### 3c. DSH 上游：给插件一条「只有应用外壳能拿到」的凭据

- 形态：应用外壳启动时由宿主下发一个进程内密钥，外壳的 fetch 封装自动加 `x-dsh-shell: <key>`；内嵌标签没有这个封装，页面 JS 也读不到这个密钥。
- 难点：如果密钥以任何形式出现在同源页面可读的地方（HTML、JS、cookie），标签就能拿到。所以它必须是 preload/主进程持有、由封装层注入的，**不能落在页面里**。
- 这是 3b 的等价实现，区别是插件侧只做「校验头」而不依赖新 API 字段。

#### 五个维度（以 3a 为主体，3b/3c 为上游部分）

| 维度 | 3a（dsh-browser） | 3b/3c（DSH 上游） |
| :--- | :--- | :--- |
| 改动面 | `dsh-browser` 校验 + `open_host` 策略 + 文档 D1 订正 | `connection.fetch` 契约 + 网关 + 壳层 fetch 封装 |
| 能否被绕过 | 3a 单独可被 `open_host` 绕过（除非一并收口）；外部浏览器/其它带凭据的宿主页面同理 | 3b/3c 在桌面壳内是可靠判据；web 模式仍需人机确认兜底 |
| 对正常用户操作的影响 | 内嵌浏览器不能再访问本机 Host 页面（D1 已接受同类误伤）；`open_host` 的调试用途受损 | 无（对用户透明） |
| 实现成本 | 低（半天级） | 中（跨仓库，需版本协同） |
| 需要 DSH 上游改动 | 不需要（dsh-browser 是本机插件） | **需要** |

### C.4 对照表（按题目要求的五个维度）

| | 方案 1 确认票据 | 方案 2 软删除 + 撤销 + 限速 | 方案 3 通道侧 |
| :--- | :--- | :--- | :--- |
| 改动面 | jiyi：index/store/client + 文档 + 测试 | jiyi：store/index/client + 文档 + 测试 | dsh-browser（3a）/ DSH 上游（3b、3c） |
| 能否被绕过 | **能**（模型自确认）；仅在上游给 peer 后成立 | 不阻止写入，但**不能绕过撤销** | 桌面壳内不能；web 模式需人机兜底 |
| 对正常用户操作的影响 | 每次破坏性写多一次点击，批量操作体验退化 | 删除可撤销（正面）；删除不立即彻底 | 内嵌浏览器访问本机 Host 页受限 |
| 实现成本 | 中 | 中 | 低（3a）/ 中（3b、3c） |
| 需要上游改动 | 要（否则只是摩擦） | 不需要 | 3a 不要；3b/3c 要 |

---

## D. 推荐组合与落地顺序

### D.0 原则

1. **先做不依赖身份判据的止损**（方案 2 的软删除 + 限速 + 审计），因为它今天就能成立。
2. **再做最便宜的真边界**（方案 3a，且必须连 `open_host` 一起处理）。
3. **最后把确认票据升级为授权边界**（方案 1 + 3b/3c），在此之前文档与面板文案都不许暗示「已防住模型」。

### D.1 Phase 0 — jiyi 自己能做（无上游依赖）

| 步骤 | 内容 | 依赖 | 备注 |
| :--- | :--- | :--- | :--- |
| P0-1 | 写操作审计：`memory_decisions` / 新表记录 `actor`、`op`、`params digest`、结果；`settings` 也留一份 `settings.history`（最近 N 次快照，用于回滚） | 无 | 最低成本、最高性价比：先让「谁改的」可查 |
| P0-2 | 写限速 + 批量上限 + 突发告警（`RATE_LIMITED`；`state.writeBurst`） | 无 | 纯进程内计数，半天级 |
| P0-3 | 软删除 + 撤销窗口（§C.2），窗口默认 10 分钟，可配 | P0-1 | 涉及召回过滤，需回归 I4/I13/I14 |
| P0-4 | 待确认队列（§C.1）+ 面板待确认区，破坏性 op 返回 202 | P0-1 | **文案必须写明「这是提醒，不是授权」**，否则会给用户虚假安全感 |
| P0-5 | `essential` 直通注入的护栏：模型来源（无法区分时按「非面板」一律）写入的记忆默认 `searchable`；`set-inclusion=essential` 需 202 待确认 | 无 | 关掉 §B.2 第 1 条的放大器 |

### D.2 Phase 1 — dsh-browser 收口

| 步骤 | 内容 |
| :--- | :--- |
| P1-1 | 查清 D1 与 F5 的矛盾（宿主侧同端口拒绝为何未生效），补一条能失败的回归测试 |
| P1-2 | `localOrigin` 拒绝 Host 自身 origin；更新 D1 记录 |
| P1-3 | `open_host` 策略：默认不向模型暴露，或标记为不可写；同步 README/AGENTS |

### D.3 Phase 2 — DSH 上游

| 步骤 | 内容 |
| :--- | :--- |
| P2-1 | `connection.fetch.register` 增加 `peer`/`surface`（或 app-shell 凭据，§3c） |
| P2-2 | jiyi 破坏性 op 校验 `surface==='app-shell'`，失败返回 403 `UI_REQUIRED` |
| P2-3 | `docs/API.md` 声明「写接口仅限应用外壳」，并把 403 码写进错误码表 |

### D.4 验收标准（可直接写成测试）

测试沿用 `test/host.test.mjs:149-152` 的假 `ctx`（`connection.fetch.register` 捕获路由，`route.fetch(new Request(...))` 直接调用）。

| 编号 | 验收点 | 断言（可执行） | 关联 |
| :--- | :--- | :--- | :--- |
| AC1 | 破坏性写进入待确认，不立即落库 | `POST delete` → 202 且 `{pending.id}`；再查 `memory.status==='active'`、正文未变 | P0-4 |
| AC2 | 确认后才执行，且可被拒绝 | `confirmMutation` 后 `status==='deleted'`；`cancelMutation` 后仍是 active 且 `pendingMutations` 为空 | P0-4 |
| AC3 | 过期的待确认不能被确认 | 把 `expiresAt` 调到过去 → `confirmMutation` 返回 409/`PENDING_EXPIRED`，数据不变 | P0-4 |
| AC4 | 软删除窗口内不进召回且可撤销 | 删除后 `listMemories(recallOnly)`、`search`、essential 注入均不含该 id；`undoDelete` 后回到 active 且正文逐字一致 | P0-3、I4、I13、I14 |
| AC5 | 窗口到期落定为今天的语义 | 到期后 `deleteMemory` 生效：正文/quote/向量清空，版本、来源定位、关系、`quote_sha256` 保留（现有 memory-lifecycle 断言全部仍通过） | P0-3、§B.1 |
| AC6 | 限速 | 第 K+1 次破坏性写在 60 秒内返回 429 `RATE_LIMITED`，且**没有任何数据变化**；第 61 秒后恢复 | P0-2 |
| AC7 | 突发可见 | 触发限速后 `GET state` 的 `writeBurst.count` 与 `windowStart` 正确，面板出现告警文案 | P0-2、P0-1 |
| AC8 | 审计可查 | 每次破坏性写产生一条 decision，`actor` 为 `api`/`panel-confirmed`/`background`，`digest` 与请求体一致 | P0-1 |
| AC9 | settings 可回滚 | 连续两次 `settings` 后 `GET state` 能看到上一版；`rollbackSettings` 恢复后 `settings.json` 内容逐字等于上一版 | P0-1 |
| AC10 | essential 不再是静默放大器 | 非面板调用 `set-inclusion=essential` 返回 202 且该记忆未被 essential 注入；面板确认后才进入注入 | P0-5、§B.2 |
| AC11 | 上游能力缺失时明确拒绝 | 未实现 Phase 2 时，面板文案与 README **不得**出现「模型无法写入」；`docs/API.md` 的认证一节必须写「本接口无法区分请求来源」 | 文档 |
| AC12 | （Phase 2 后）surface 校验 | 模拟 `surface!=='app-shell'` 的请求对破坏性 op 返回 403 `UI_REQUIRED`，对只读 op 仍 200 | P2-2 |

AC1–AC11 全部可在现有测试框架内写成失败测试，不需要真实浏览器；AC12 需要上游先提供字段，属阻塞项。

---

## E. 边界、遗留风险与待拍板项

### E.1 本设计**不**做什么

- 不改 `lib/`、`test/`、`storages/`，不重启 DSH（本文档交付即可）。
- 不把 `/api/jiyi` 改成需要登录口令的两套认证：用户已经有 owner 身份，再加一套等于自建账号体系，且不能解决同源问题。
- 不引入网络层反向代理/防火墙规则：攻击来自本机同源页面，网络层看不见。
- 不试图阻止 agent 使用浏览器工具本身（那是 DSH 的产品能力）。
- 不修改 `settings.json` 的凭据字段（AGENTS.md 红线）。

### E.2 遗留风险

| 风险 | 状态 | 说明 |
| :--- | :--- | :--- |
| 模型仍可静默**读**全部记忆与来源原文 | 未缓解 | 读操作不加确认（否则面板每次都卡）；缓解只能靠 Phase 2 的 surface 判据 |
| 模型可自行 POST `confirmMutation` | 未缓解（设计已知） | 只有 Phase 2 能解；在此之前方案 1 只是可见性 |
| 撤销窗口期满后删除仍会落定 | 部分缓解 | 用户必须在这 10 分钟内看到并处理；离线/不看面板时无效 |
| `open_host` 仍是第二入口 | 未缓解 | 需 P1-3 |
| 具备 shell 的 agent 可直读 sqlite | 不在本设计范围 | 见 §A.5 |
| 具备 cua/桌面点击的 agent 可点确认 | 未缓解 | 需要用户侧的权限分离（不给不可信会话桌面控制） |
| web 模式（外部浏览器）永远无法在 HTTP 层区分 | 结构性 | 只能靠原生确认框 |
| `source` 的原文读取比记忆正文更敏感 | 未缓解 | 是否要把 `source` 也纳入待确认，需用户决定 |

### E.3 需要用户拍板的点

1. **是否接受「每次删除都在面板点一次确认」？** 备选：(a) 逐条确认（最安全、最烦）；(b) 一次确认覆盖本批（记下批大小）；(c) 只对 `>1 条/分钟` 的批量要求确认（推荐）。
2. **撤销窗口多长？** 建议 10 分钟（可配 1–60）。窗口越长越安全，但「删除」在库里留正文的时间也越长。
3. **限速阈值？** 建议破坏性写 20 次/分钟、全部写 60 次/分钟、突发告警阈值 10 次/5 分钟。
4. **是否接受 Phase 1 的代价**：内嵌浏览器不能再打开本机 Host 页面（`open_host` 降权/移除），影响的是模型自查 DSH UI 的调试场景。
5. **是否愿意为设计 2 引入的「待删」语义接受一次版本号与兼容性检查的调整**（若走独立表则不必升 `SCHEMA_VERSION`；若改 `memories.status` 则必须升，并同步 `lib/client.js:61` 的 `schemaVersion===4` 门）。推荐走独立表。
6. **是否要求 `source`（读原文）也进入待确认**，代价是面板来源查看需要多点一次。
7. **`essential` 的模型写入是否一律禁止**（比 P0-5 更硬：非面板来源完全不能设 `essential`）。

---

## F. 与既有不变量、决策的关系

### F.1 会受影响的不变量

| 编号 | 影响 | 处理 |
| :--- | :--- | :--- |
| I2（相似度不授权注入） | **不受影响**，但 §B.2 第 1 条指出 essential 走的是另一条通道，不是 I2 的例外——需要在文档里写清「I2 只覆盖召回」 | 补充说明，不改 I2 |
| I4（版本一致才注入） | 待删状态需要在「注入前复核」这一步也返回 `RECALL_STALE`，否则会带着待删记录进上下文 | 实现时必须同时改 `versionAndPersistence`，并补测试 |
| I13（生效期结束不进候选） | 新增 `pending_deletions` 的过滤与生效期过滤并列，注意不要合并成一个条件（两者语义不同） | 过滤条件分开写 |
| I14（待审冲突不进召回） | 「待删」与「待审」是两种隔离，**不要复用 `review_state='pending'`**：`_syncReviewState` 会按现存冲突组重新推导它（`lib/store.js` `_syncReviewState`），复用会被覆盖 | 用独立表；在 INVARIANTS 新增一条（I17：待删记忆不进任何注入路径） |
| I15（后台失败可见可重试） | purge 失败必须进失败可见面（面板/`lastFailure`），不能静默 | 复用 `emitFailure` |
| I16（关闭幂等） | purge 定时器挂到现有生命周期上，dispose 时清理且可重复调用 | 跟随 `releaseRuntime` |
| I8（超时≠无命中） | 限速 429 与 `search` 的 `timeout` 不是同一类结论，别混进 `status` | 用独立 `RATE_LIMITED` code |
| I1/I3/I5/I6/I7/I9/I10/I11/I12 | 不受影响 | — |

### F.2 与既有决策的关系

| 决策 | 关系 |
| :--- | :--- |
| D4（v4 独立数据目录、从空记忆开始） | 方案 2 若引入新表，属于同目录内的增量迁移；不改 D4 结论 |
| D5（未裁决冲突不进召回） | 方案 2 的「待删不进召回」与 D5 是同一取向：**宁可暂时缺一条，也不静默写错**。建议新增决策条目时引用 D5 |
| D7（空补丁=恢复默认） | 方案 1 把 `settings` 纳入待确认后，语义不变；`{}` 的危险性反而降低（可回滚） |
| D8（待审更新被拒绝而非静默结案） | 与本设计「拒绝而不是静默」一致；`set-inclusion=essential` 的 202 待确认也应给明确错误码而不是静默降级 |
| D10（4xx=配置错误，内部故障 500） | 新增 `RATE_LIMITED`(429)、`PENDING_EXPIRED`(409)、`UI_REQUIRED`(403) 必须进这张表，且 403 不能沿用「一律 400」的旧映射 |
| D11（判别器看到的正文=注入正文） | 不受影响 |

拟定新增决策（**D16**；D13–D15 已被同期改动占用，本文不写入 `docs/DECISIONS.md`）：**「写接口的来源不可区分时，破坏性写入一律降级为可撤销的可见操作，并把授权判定上移给 DSH 通道层」**。

---

## G. 附录：核实清单与文档漂移

### G.1 本次核实的代码位置（2026-11-23 工作区）

| 事实 | 位置 |
| :--- | :--- |
| 路由注册 | `lib/index.js:1036` |
| `operation()` 分派 | `lib/index.js:844-1034` |
| 请求体 50000 字符上限、无操作的并发上限 | `lib/index.js:1069-1072` |
| `state()` 返回面 | `lib/index.js:830-843` |
| essential 注入 | `lib/index.js:758-764` |
| 设置读写 | `lib/index.js:150-169` |
| 删除语义 | `lib/store.js:637-668` |
| `_invalidate`（supersede/delete 的共同终点） | `lib/store.js:512-526` |
| 「不可复活」 | `lib/store.js:531` |
| essential 预算 8192 | `lib/store.js:9,722-728` |
| `user_controlled` 自锁 | `lib/store.js:730-743` |
| 召回过滤 | `lib/store.js:680-702` |
| workspace 内的删除守护测试 | `test/memory-lifecycle.test.mjs` |
| 面板轮询 7s、删除两步、设置保存 | `lib/client.js:240,98,160-162` |
| 客户端 schema 门 | `lib/client.js:61` |
| 假 ctx 测试脚手架 | `test/host.test.mjs:149-152`、`test/recovery.test.mjs:46,83` |
| dsh-browser `localOrigin` 校验 | `plugins/dsh-browser/lib/index.js:158-163` |
| dsh-browser `open_host` | `plugins/dsh-browser/lib/index.js:45,210-213`；`test/tools.test.mjs:291-305` |
| dsh-browser D1（同端口拒绝声明） | `plugins/dsh-browser/docs/DECISIONS.md:8-34` |
| dsh-tongxin 的 loopback/Origin 校验与同路径 RPC | `plugins/dsh-tongxin/plugin-src/management-rpc.mjs:23-31,47-53,94-99` |

### G.2 三处文档/交付漂移（不影响设计结论，但会误导后来人）

1. `docs/API.md:3` 写「路由注册在 `lib/index.js:918`，POST 分派在 `lib/index.js:742`」；当前实际是 `1036` 与 `844`。同文的 `:724`（`publicMemory`）也已迁到 `825`；`lib/index.js:42`（`redactPublicValue`）仍然正确。
2. `plugins/dsh-browser/docs/DECISIONS.md` D1 声称同端口地址会被拒绝，与本次实测（F5）冲突。根因未定位，Phase 1 第一件事就是把它查清。
3. 本文是 `docs/` 下的新增文件，而 `.gitignore:9` 的 `/docs/*` 白名单只放行 `API.md` / `DECISIONS.md` / `INVARIANTS.md`，所以**本文件默认不入库**（`git status` 看不到它）。是否放行由用户决定；如需入库，加一行 `!/docs/SECURITY-P0-DESIGN.md`，不要用 `git add -f` 绕过（AGENTS.md §7）。

### G.3 本文未做的验证

- 未运行任何攻击步骤。§A.1 的 F2/F5 来自队友实测，本文没有复跑。
- 未读取 DSH 宿主 asar 内的浏览器与网关实现，因此「同端口拒绝为什么没生效」「能否给 fetch 处理器补 peer 字段」都只到【未核实】。
- 未检查其它插件是否存在同样的「面板写接口 + 浏览器标签可达」模式（dsh-tongxin 是唯一同类，且已做 loopback 校验）。