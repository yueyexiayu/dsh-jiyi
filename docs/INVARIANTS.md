# jiyi 不变量清单

这份清单把「jiyi 必须始终成立的行为」写成可引用的编号，供测试、诊断字段和
文档共同使用。改代码前先确认它属于哪一条；改完后对应测试必须仍然通过。

每条都标注了执行它的位置和守护它的测试文件。测试里以 `I<n>` 引用本编号。

---

## I1 — 注入的是原始事实，不是新生成的事实

召回注入的内容必须逐字来自已保存的记忆正文，模型只做「支持度判别 + 逐字引用」，
不得补写、概括或改写。

- 位置：`lib/relevance.js`（`RELEVANCE_SYSTEM`）、`lib/retrieve.js`（`renderMemoryContext`）
- 守护：`test/relevance.test.mjs`、`test/retrieve.test.mjs`

## I2 — 相似度只产生候选，从不授权注入

向量相似度、词法覆盖率、标识符命中、反馈权重、时间衰减、MMR 多样性分，
全部只影响「进入候选池的顺序」。唯一能放行注入的是相关性判别器的显式
`ids` 决定。任何一道分数都不能单独让一条记忆进入上下文。

- 位置：`lib/retrieve.js`（`candidateEligible` 之后的 `relevance.judge`）
- 守护：`test/retrieve.test.mjs`「cosine, lexical and exact identifier candidates never bypass the relevance decision」

## I3 — 引用必须带 `id / version / quote` 三重校验

判别器返回的每一项都要同时满足：id 在候选里、version 与当前记录一致、
quote 是原文的逐字片段。任一不满足即报 `RELEVANCE_PROTOCOL`，不是静默丢弃。

- 位置：`lib/relevance.js`（`parseGroundedIds`）、`lib/retrieve.js`
- 守护：`test/retrieve.test.mjs`「invented, duplicate, stale and malformed relevance refs are errors, not empty success」

## I4 — 版本一致才注入

检索完成后、注入前，必须重新核对每条命中记忆的当前版本；期间被纠正或删除的
记忆整体作废（`RECALL_STALE`），不允许带着旧版本进入上下文。

- 位置：`lib/search.js`（`versionAndPersistence` 段）、`packRecall`
- 守护：`test/status.test.mjs`、`test/retrieve.test.mjs`「highest active memory version is used once」

## I5 — 同一请求不重复注入，工具续步不递归召回

同一个 `requestId` 只记录一次召回结论（`injected` / `empty` / `error` / `skipped`）；
插件自身产生的消息不参与查询，召回不会递归召回自己。

- 位置：`lib/index.js`（`agent/pre-step` 的 `prior` 判定与 `source.kind==='user'` 过滤）
- 守护：`test/host.test.mjs`、`test/v4-lifecycle.test.mjs`

## I6 — 前台有硬截止，且失败一律 fail-open

前台召回受绝对截止时间约束：可缩短，不可延长配置值；embedder 从未成功过时
按冷启动上限放宽一次。超时、模型错误、判别失败都不阻断本轮对话，只记录状态。

- 位置：`lib/retrieve.js`（`effectiveRecallTimeout`）、`lib/search.js`、`lib/index.js`
- 守护：`test/retrieve.test.mjs`「foreground recall budget shortens but never extends the configured value」、
  `test/host.test.mjs`「Native packaging refuses late recall after synchronous work despite an undelivered timeout signal」

## I7 — 取消后的迟到 rejection 必须被观察

任何 `Promise.race` 的落败分支都要被 `.catch` 兜住。provider 忽略取消信号时，
不能在若干秒后变成 `unhandledRejection`。

- 位置：`lib/retrieve.js`（`awaitActive`）
- 守护：`test/retrieve.test.mjs`「a rejected embedding after cancellation is observed, never an unhandled rejection」

## I8 — 超时不是「无相关记忆」

`timeout`、`error`、`cancelled`、`no-hit` 是四种不同结论，各自单独记录、单独上报；
面板与诊断不得把前三种折叠成「没有相关记忆」。

- 位置：`lib/index.js`（`recordRecall` 的 status 分支）、`lib/search.js`
- 守护：`test/host.test.mjs`、`test/store.test.mjs`

## I9 — 输出预算是完整消息的字节上限

预算按最终注入消息的 UTF-8 字节数计算（含包装标签、元数据与转义），不是正文
字符数；超预算的命中被跳过并计数，绝不截断正文。

- 位置：`lib/retrieve.js`（打包段）、`lib/search.js`（`packRecall`）
- 守护：`test/retrieve.test.mjs`「conservative packed-context budget includes metadata, escaping and wrapper」

## I10 — 召回文本不可关闭自己的包装

记忆正文里的任何标签都不能提前闭合 `<jiyi-memory>`；`<` 一律转义为 `\u003c`。

- 位置：`lib/retrieve.js`（`renderMemoryContext`）
- 守护：`test/retrieve.test.mjs`「recalled text cannot close its untrusted-data wrapper」

## I11 — 融合只依赖排名，不依赖输入顺序

两路通道（向量、词法）各自排名后按 RRF 融合；同分以上升 id 破平。相同记录集合
无论以何种顺序传入，`ranked` 结果必须完全一致。

- 位置：`lib/retrieve.js`（`channelRanks`、融合段）
- 守护：`test/retrieve.test.mjs`「fusion depends on rank, not on the order records arrive from the store」

## I12 — 六槽里不塞同一个 factKey 的多份

打包阶段按 `factKey` 限额选取，并用 MMR 贪心去冗余；被限额挡掉的命中计入
`diversity.factKeyCapped`，不能被误报为「无相关记忆」。

- 位置：`lib/retrieve.js`（打包段 MMR）
- 守护：`test/retrieve.test.mjs`「packaging caps picks per factKey and keeps a diverse fill for six slots」

## I13 — 生效期结束的记忆不进候选

`validTo` 已过、`validFrom` 未到的记忆在候选过滤阶段就被排除；时间衰减只用于
给存活记忆排序，不再充当「过期即腰斩」的开关。

- 位置：`lib/retrieve.js`（`scopeFilter`、`decayFactor`；年龄下限钳制到 0）
- 守护：`test/status.test.mjs`、`test/retrieve.test.mjs`「validity expiry removes the decay tie-break instead of halving one score」

## I14 — 待审冲突不进自动召回

`reviewState !== 'clear'` 的记忆不参与自动召回、essential 注入或普通检索；只有
裁决落定并写入新版本后才恢复。

隔离不能被旁路抹掉：对一条存在未决冲突组的记忆做普通更新（没有 `user-correction`
证据、没有裁决租约、没有显式授权）会被拒绝并报 `CONFLICT_REVIEW_OPEN`，而不是
悄悄解散冲突组再把 `review_state` 改回 `clear`。明确用户纠正与裁决落定可以结案，
结案后再由现存冲突组重新推导 `review_state`，因此不会留下无法裁决的孤儿 pending。

- 位置：`lib/store.js`（`putMemory` 的 `mayResolveConflicts` 与 `_syncReviewState`）、`lib/review.js`
- 守护：`test/audit-0138.test.mjs`、`test/v4-lifecycle.test.mjs`、`test/memory-lifecycle.test.mjs`

## I15 — 后台失败可见、可重试，不静默吞掉

抽取、判别、裁决、巩固的失败都要进队列并保留 `attemptHistory`；关闭期间的中止
不算持久失败。

- 位置：`lib/index.js`（`emitFailure`、`processJob`）、`lib/retry.js`
- 守护：`test/retry.test.mjs`、`test/host.test.mjs`

## I16 — 关闭是幂等的

重复调用关闭路径必须是 no-op：Host 的退出与 profile 重载可能各触发一次 dispose，
第二次不得抛 `AggregateError`，`store.close()` 重复调用也不得抛 `ERR_INVALID_STATE`。

会话关闭、插件 dispose、Host 退出可重复调用，第二次起为 no-op 且不抛错。

- 位置：`lib/index.js`（`dispose`）、`lib/models.js`（`dispose`）
- 守护：`test/latency.test.mjs`「dispose during native inference waits for child exit and settles outstanding promises」

---

## 参数来源

所有排序与预算相关的数字集中在 `lib/retrieve.js` 的 `RETRIEVAL_CONSTANTS`，
并导出供测试与诊断引用。改这些数字等于改算法，必须同步更新本文件与对应测试。

| 常量 | 值 | 含义 |
|---|---|---|
| `rrfK` | 60 | RRF 融合常数，Cormack 等人的通用取值 |
| `defaultSemanticThreshold` | 0.20 | 仅用于扩展候选，不是注入门槛 |
| `lexicalEligibleScore` / `lexicalEligibleOverlap` | 0.65 / 2 | 词法单独成为候选的条件 |
| `exactIdentifierBonus` | 3 | 标识符精确命中的加权（以通道全权重为单位） |
| `scopeBonusFraction` | 0.1 | 当前项目命中的微调（占一个通道全权重的比例） |
| `feedbackClamp` / `feedbackNudgeFraction` | 4 / 0.05 | 召回反馈的钳制与微调幅度 |
| `decayHalfLifeDays` | 30 | 时间衰减的半衰期，仅作同带内 tie-break |
| `mmrLambda` | 0.7 | MMR 相关性/多样性权衡 |
| `candidateFactKeyCap` | 2 | 同一 factKey 在一次注入中的上限 |
| `foregroundTimeoutMs` / `coldStartTimeoutMs` | 3000 / 10000 | 前台召回上限 / embedder 未预热时的上限 |

`rrfK`、`exactIdentifierBonus`、`scopeBonusFraction`、`feedbackNudgeFraction`、
`decayNudgeFraction` 之间的相互比例是有意设计的：任一加性项都只占「一个通道的
全权重」的一小部分，因此改动 `rrfK` 不会让这些项的相对影响力失衡。
