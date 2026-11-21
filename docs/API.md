# jiyi Host API 契约

本文描述 jiyi 注册在 DSH Host 上的唯一 HTTP 接口。信息来自 `lib/index.js`（路由注册在 `lib/index.js:918`，POST 分派在 `lib/index.js:742`），改动接口时同一提交更新本文。

---

## 1. 通用约定

| 项 | 值 |
| :--- | :--- |
| 路径 | `/api/jiyi` |
| 方法 | `GET`、`POST` |
| 注册位置 | `ctx.connection.fetch.register`（`lib/index.js:918`） |
| 认证 | 走 DSH 正常认证。凭据留在 Host，不下发 Client |
| 请求体上限 | 50000 字符（`lib/index.js:951`），超出返回 400「请求过大」 |
| 响应头 | `content-type: application/json; charset=utf-8`、`cache-control: no-store` |

**响应信封。** 成功与失败共用同一 JSON 结构：

```jsonc
// 成功
{ "ok": true, /* ...该 op 的字段 */ }

// 失败
{ "ok": false, "error": "人类可读的中文原因", "code": "错误码" }

// GET 的 search 例外：ok 由检索状态推导，见 §3.4
```

**HTTP 状态与业务码不是一回事。** 实际只有两种状态码：`code === 'NOT_FOUND'` 时 404，其余一切失败都是 400。业务语义必须读 `code`，不能靠状态码推断——例如「模型未配置」和「参数非法」都是 400。

**输出一律脱敏。** 响应经 `redactPublicValue`（`lib/index.js:42`）处理；记忆对象经 `publicMemory`（`lib/index.js:724`）剔除 `embedding` 并补 `type`、`projectName`；冲突对象经 `publicConflict`（`lib/index.js:725`）剔除 `token`、`leaseUntil`。

---

## 2. GET 操作

GET 只承载读操作，参数全部走 query string。`op` 缺省为 `state`。

### 2.1 `state`（默认）

`GET /api/jiyi?op=state&sessionId=<id>`

返回整个插件的运行快照。可附带 §2.2 的全部分页参数来限定返回的 `memories` 一栏。

### 2.2 `memories`

`GET /api/jiyi?op=memories&sessionId=<id>&memoryOffset=0&memoryLimit=200`

与 `state` 共用实现，但**只返回** `{ ok, memories, memoryPage }`，适合轮询分页。

| 参数 | 类型 | 默认 | 约束 |
| :--- | :--- | :--- | :--- |
| `memoryOffset` | 十进制字符串 | `0` | 必须匹配 `^(0\|[1-9]\d*)$` 且为安全整数 |
| `memoryLimit` | 十进制字符串 | `200` | 必须匹配 `^[1-9]\d*$` 且 **≤ 200** |
| `memoryScope` | string | `all` | `all` \| `global` \| 现存项目 id；未知值报 `INVALID_SCOPE` |
| `memoryStatus` | string | 无 | `active` \| `superseded` \| `deleted` |
| `memoryQuery` | string | `''` | 长度 **≤ 1000** |

`memoryPage` 形状：`{ offset, limit, total }`。`total` 由 `countMemories` 以 `limit: 500` 单独统计。

注意：列表走 `includeInactive: true`，所以「记忆」页能看到已替代与已删除条目；这不代表它们会进召回（见 `docs/INVARIANTS.md` I13、I14）。

### 2.3 `changes`

`GET /api/jiyi?op=changes&sessionId=<id>`

返回当前会话最近的记忆变更批次。`sessionId` 必填且长度 ≤ 256，否则 400「需要有效的会话 ID」。

每条 change 的 `items` 会现查记忆正文；`type === 'deleted'` 的条目 `content` 恒为空字符串（删除已清空正文，这是设计而非缺陷）。

### 2.4 `failedQueue`

`GET /api/jiyi?op=failedQueue&offset=0`

| 参数 | 默认 | 约束 |
| :--- | :--- | :--- |
| `offset` | `0` | 匹配 `^(0\|[1-9]\d*)$` 且为安全整数 |

**返回条数固定 100**，不可调。返回 `{ ok, queue, offset, total }`，`total` 为失败队列总数。

### 2.5 `search`

`GET /api/jiyi?op=search&query=<q>&scope=<auto|global|projectId>`

| 参数 | 默认 | 说明 |
| :--- | :--- | :--- |
| `query` | `''` | 检索文本 |
| `scope` | `auto` | `auto` \| `global` \| 明确项目 id |

**这条的 `ok` 语义与其他 op 不同**：

```js
ok: !['error','timeout','not-configured'].includes(result.status)
```

即检索本身失败（错误、超时、模型未配置）时 `ok` 为 `false`，但**HTTP 仍是 200**，且 `memories` 为空数组。这与「确实没有相关记忆」（`status: 'no-hit'`，`ok: true`）是两件事，前端必须看 `status`，不能只看 `memories.length`。

### 2.6 未知 op

`GET /api/jiyi?op=nonsense` → 400，`{ ok: false, error: '未知操作', code: 'JIYI_ERROR' }`。

---

## 3. POST 操作

`POST /api/jiyi`，`content-type` 任意，body 为 JSON，必须含 `op` 字段。分派在 `lib/index.js:742` 的 `operation()`。

多数 op 会**严格白名单校验字段**：出现未列出的键直接 400。所以前端不要顺手多传字段。

### 3.1 设置

#### `settings`

`{ op: 'settings', settings: {...} }` — 按段落合并设置并重建模型实例。

- **非空 patch 是合并**：只覆盖你提交的段与键，其余段落保持当前值。提交 `{retrieval:{timeoutMs:5}}` 不会重置 `adjudication`、`consolidation` 或 `extraction`。
- **空 patch `{}` 是恢复默认**：整份设置写回 `DEFAULT_SETTINGS`。这个例外保留了旧契约，别把它当「什么都不改」。
- 后台抽取、裁决、巩固或设置更新进行中时报 `BUSY`。
- 会把 `extraction` / `lessons` / `adjudication` 三个状态重置为 `not-verified` 或 `not-configured`，并清零抽取失败熔断。
- 返回 `{ ok, settings }`。**保存成功不等于验证成功**，验证要用 §3.4 的探针。

### 3.2 记忆读写

#### `createMemory`

`{ op: 'createMemory', content, scope, projectId }`

| 字段 | 约束 |
| :--- | :--- |
| `content` | 1–1500 字符，去首尾空白后不得为空 |
| `scope` | `global` \| `project` |
| `projectId` | `global` 时必须为 `null`/缺省；`project` 时必填且项目必须存在，否则 `INVALID_SCOPE` |

白名单字段：`op`、`content`、`scope`、`projectId`。写入前先做一次 embedding；失败则整笔不写。

#### `correct`

`{ op: 'correct', id, content, version }` — 生成新版本并替代旧版本。

- 有效记忆不存在 → 404 `NOT_FOUND`。
- `content` 1–1500 字符。
- `version` 可选，缺省用当前版本；传入时作乐观锁，不匹配会失败。

#### `delete`

`{ op: 'delete', id, version }` — 清空正文、quote、候选与向量，保留版本身份、来源定位、关系与 quote hash（由 `test/memory-lifecycle.test.mjs` 守护）。

#### `set-inclusion`

`{ op: 'set-inclusion', id, inclusion, expectedRevision }` — 切换记忆的纳入状态，带修订号乐观锁。

### 3.3 召回反馈与冲突

#### `feedback`

`{ op: 'feedback', sessionId, recallId, requestId, memoryId, version, kind }`

| 字段 | 约束 |
| :--- | :--- |
| `sessionId` / `recallId` / `requestId` / `memoryId` | 必须都是 string |
| `version` | 必须是整数 |
| `kind` | 仅 `explicit_useful` \| `explicit_irrelevant` \| `explicit_wrong` |

白名单严格：多传一个键就 400「召回反馈参数无效」。只能对**同一会话里实际注入过**的召回反馈。`explicit_wrong` 只触发复核，不直接改写正文。

#### `resolveConflict`

`{ op: 'resolveConflict', groupId, candidateId, decision }`

| 字段 | 约束 |
| :--- | :--- |
| `groupId` | 必填 string |
| `candidateId` | 可选 string 或 null |
| `decision` | `same_claim_newer` \| `distinct_claims` \| `temporal_change` \| `unresolved` |

### 3.4 模型验证探针

这四个 op 都会发起**真实的模型调用**，耗时与费用由用户的提供方承担。它们回答「当前配置能不能用」，不是「保存了就一定行」。

| op | 额外字段 | 成功判定 |
| :--- | :--- | :--- |
| `verifyEmbedding` | 无 | 本地跑通 embedding |
| `verifyRelevance` | 无 | 相关性判别器返回合法结构 |
| `verifyExtraction` | 无 | 能从固定中文偏好样本中提取出 `scope: 'global'` 且 `type: 'preference'` 的记忆 |
| `verifyAdjudication` | `sessionId`（可选，≤256） | 探针在最多 2 次尝试内返回替代结果（见下） |

**`verifyAdjudication` 的判据是语义的，不是措辞的。** 探针给旧记忆更早的用户证据、给候选更晚的证据，接受 `same_claim_newer` **或** `temporal_change`，并且要求引用同时命中 `memory:validation-memory:1` 与 `candidate:validation-candidate:candidate`。不比对模型自造的 `reasonCode` 自由文本——那是模型写的散文，固定它等于在考措辞。一次不通过会重试一次，仍失败才报 `ADJUDICATION_VALIDATION`。

当 `settings.adjudication.modelPolicy === 'current-session'` 时，路由取当前会话的实际请求路由；没有实际路由则报 `NOT_CONFIGURED`。

#### `verifySourceBoundary`

`{ op: 'verifySourceBoundary', query, projectId, refs: [{ id, version, contentSha256 }] }`

受控来源边界重放。约束很硬：

- `refs` 长度 **1–6**，每个对象**必须恰好三个键**，`contentSha256` 必须是 64 位小写十六进制，`id` 不得重复。
- 每条 id/version/contentSha256 必须与库中现行记忆完全一致，否则 `RECALL_STALE`。
- 记忆范围必须与 `projectId` 一致（`global` 对全局，其余对同项目），否则 `INVALID_SCOPE`。
- 已有重放运行中时 `BOUNDARY_BUSY`。

这个 op 的用途是验证「注入边界」是否成立，**不接受自造事实**。

### 3.5 后台队列与巩固

| op | 字段 | 说明 |
| :--- | :--- | :--- |
| `retry` | `{ id }` | 重试失败任务并清零抽取失败熔断 |
| `consolidation-trigger` | 无额外字段 | 离线巩固关闭时报错；开启则入队，返回 `{ ok, accepted: true, state }` |

### 3.6 项目与来源

| op | 字段 | 说明 |
| :--- | :--- | :--- |
| `project` | `{ id, name, aliases }` | 重命名项目 / 改别名集合 |
| `addProjectAlias` | `{ id, alias }` | 追加别名 |
| `deleteProjectAlias` | `{ id, alias }` | 删除别名 |
| `source` | `{ sessionId, eventSeq }` | 读取某条记忆引用的来源事件 |

`source` 有额外前置条件：只有当该事件**确实被某条记忆引用过**时才放行，否则 404 `NOT_FOUND`。手动创建/纠正的审计记录用 `jiyi-manual:` 前缀的 sessionId，`eventSeq` 必须为 0。

---

## 4. 错误码

| code | HTTP | 含义 |
| :--- | :--- | :--- |
| `JIYI_ERROR` | 400 | 默认业务错误（含参数校验失败、未知操作） |
| `NOT_FOUND` | 404 | 记忆、来源事件或审计记录不存在 |
| `INVALID_SCOPE` | 400 | 未知项目范围 |
| `BUSY` | 400 | 后台抽取/裁决/巩固/设置更新进行中 |
| `EVAL_BUSY` | 400 | 评测无法启动：Host 正忙或队列未清空 |
| `EVAL_RESTART_REQUIRED` | 400 | 磁盘源码与已加载 Host 不一致，需要完整重启 DSH |
| `EVAL_CLEANUP` | 400 | 评测模型资源释放失败 |
| `NOT_CONFIGURED` | 400 | 所需模型路由未配置 |
| `ADJUDICATION_VALIDATION` | 400 | 裁决探针未返回预期替代结果 |
| `EXTRACTION_VALIDATION` | 400 | 抽取探针未产出预期中文偏好 |
| `BOUNDARY_BUSY` | 400 | 已有受控来源边界重放运行中 |
| `RECALL_STALE` | 400 | 重放引用已失效、版本或原文不一致 |
| `CONFLICT_STALE` | 400 | 冲突组已结案或租约失效，不能再操作 |
| `CONFLICT_REVIEW_OPEN` | 400 | 记忆存在未决冲突，普通更新可能抹掉隔离 |
| `MEMORY_ID_CONFLICT` | 400 | 新记忆标识冲突 |

---

## 5. 工具入口

除 HTTP 外，Host 还注册了一个给主模型用的工具：

| 项 | 值 |
| :--- | :--- |
| 名称 | `jiyi_search`（`lib/index.js:957`） |
| 参数 | `query`（必填）、`scope`（`auto` 默认 / `global` / 项目 id） |
| 超时 | 120000 ms |
| 并发 | 声明 `isConcurrencySafe: () => true` |

自动召回是主路径，`jiyi_search` 只是显式补充入口。保存是异步的——没看到实际结果前不要声称「已保存」。

---

## 6. 评测 IPC（内部）

`scripts/evaluate.mjs` 与 Host 之间通过 unix socket 通信，不走 HTTP：socket 位于数据目录 `eval-<pid>.sock`，端点信息写在 `eval-endpoint.json`（`lib/eval-ipc.js:8`）。这是内部通道，不属于对外契约，版本变化不保证兼容。
