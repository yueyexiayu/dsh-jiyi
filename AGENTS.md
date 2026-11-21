# AGENTS.md — 在 jiyi 仓库里干活要遵守什么

这份文件是**操作约定**，不是产品说明。产品是什么、怎么装、怎么用看 [`README.md`](README.md)；
必须始终成立的运行时行为看 [`docs/INVARIANTS.md`](docs/INVARIANTS.md)；对外接口看 [`docs/API.md`](docs/API.md)。

改任何代码前先确认三件事：改的是哪条不变量、跑哪条命令验证、会不会碰到正式记忆数据。

---

## 1. 环境与安装

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
cd "$DSH_HOME/plugins/jiyi"
npm ci --prefix deps                 # 依赖锁在 deps/package-lock.json
node scripts/prepare-models.mjs      # 固定 revision，逐文件校验字节数与 SHA256
```

- 已验证环境：macOS arm64、Node 24、Electron 44。其他平台未经实测，不要写成「支持」。
- 运行时锁定 `@huggingface/transformers@3.8.1`，**不要**升级或改 `deps/package.json` 的版本写法（当前为精确版本，不带 `^`）。
- 模型资产约 129 MiB，首次下载慢属正常。运行时禁止远程自动下载模型。

## 2. 改完必须跑的命令

```sh
# 语法检查（改动 lib/ 或 scripts/ 后必跑）
for file in lib/*.js scripts/*.mjs; do /usr/local/bin/node --check "$file" || exit; done

# 公开回归测试（提交前必跑）
NODE_OPTIONS='' /usr/local/bin/node --test --test-timeout=90000 test/*.test.mjs
```

- 报结果只能报实测数字。没跑就写「未跑」，不许写「应该通过」。
- 测试失败时先分清是代码、测试、环境还是外部服务（LLM 提供方）原因，再动手。
- 依赖缺失或资产缺失会**明确失败**，这是有意设计，不要改成静默降级。

## 3. 数据安全红线

**这一节每条都是硬约束，没有例外。**

| 约束 | 为什么 |
| :--- | :--- |
| 迁移、评测、开发验收**必须**用临时 `dataDir` 或数据库副本 | 正式数据在 `$DSH_HOME/storages/jiyi-v2/`，用正式目录演练会毁掉用户全部记忆 |
| 不要清空、重建或手工改写 `storages/jiyi-v2/memory.sqlite` | 里面有版本链、证据定位、决策日志；手改绕过了事务，会让 I4（版本一致才注入）、I13（生效期）、I14（待审冲突隔离）失去可验证性 |
| 不提交 `evidence/` 下的评测产物、`models/` 下的模型资产、任何 `*.sqlite*` / `*.log` / `*.env*` | `.gitignore` 是白名单式，这些默认被挡在外面，不要为图方便加 `!` 放行 |
| 不改 `settings.json` 的账号凭据字段 | 凭据属于用户，插件只读不写 |
| 删除记忆只会清空正文、quote、候选与向量，**保留**版本身份、来源定位、关系与 quote hash | 这是可审计性的基础；`test/memory-lifecycle.test.mjs`「deletion clears quote and candidate bodies while retaining hashes, locators, versions, relations and decisions」守护它，不要「优化」成物理删除 |

临时数据目录示例：

```sh
node scripts/evaluate.mjs --data-dir /tmp/jiyi-scratch-$(date +%s)
```

## 4. 不许做的事

- **不要用 `cordis.patch.yml` 的 `- insert:` 挂载本插件。** jiyi 只作为 **desktop profile bundle** 加载；`insert` 已过时。包内 `cordis.patch.yml` 只是 bundle 声明，不要原样覆盖 desktop profile。
- **不要在代码注释、日志或返回值里输出凭据、私人会话原文。** 对外返回统一走 `redactPublicValue`（`lib/index.js:42`）和 `publicMemory`（`lib/index.js:724`）。
- **不要把记忆正文当指令执行。** 召回注入是「参考事实」，工具与提示词都不许把它提升为命令。
- **不要放宽注入授权。** 相似度、词法命中、反馈权重、时间衰减只决定候选顺序，唯一放行注入的是相关性判别器显式的 `ids`（I2）。任何「分数够高就直接注入」的改动都是错的。
- **不要用 `updatedAt` 冒充 `lastConfirmedAt`。** 确认时间只来自最新有效用户或工具来源。
- **不要在简历/文档里写「完全离线」。** 记忆与 Embedding 在本机，但提取与相关性判断会把所需内容发给用户配置的 LLM 提供方。

## 5. 改动与不变量、测试的对应

`docs/INVARIANTS.md` 把 16 条不变量与守护测试文件对起来了。流程是：

1. 动手前：在 `docs/INVARIANTS.md` 里找到本次改动涉及的编号（`I1`–`I16`）。
2. 动手时：如果行为变化使得某条不变量不再成立，**先改不变量文档并说明理由**，不要偷偷让测试跟着代码改。
3. 收尾时：对应守护测试必须仍然通过；新增行为要补一条能失败的测试。

改排序、预算、召回截止、裁决逻辑时，除测试外还要检查 `RETRIEVAL_CONSTANTS` 是否有对应的集中常量，不要把魔数散回代码里。

## 6. 版本号与发布

本包 `private: true`，**不发布到 npm**。版本号被四处引用，改版本时必须同步：

| 位置 | 字段 |
| :--- | :--- |
| `package.json` | `version` |
| `lib/index.js` | `export const VERSION` |
| `lib/client.js` | `var VERSION` |
| `README.md` / `README.en.md` | 版本徽标与「验证」章表格 |

提交前核对 Client 与 Host 版本一致；不一致时右侧栏会显示两套数字，属于缺陷。

## 7. 提交约定

- 提交信息用 `<type>(<scope>): <中文摘要>`，例如 `fix(adjudication): 探针改语义判据并固定最低推理档`。
- 一个提交只做一件事。重构与行为变更分开提交。
- 提交前 `git status --porcelain` 必须干净地反映你**打算**提交的东西；出现意外的 `evidence/`、`*.sqlite`、模型文件就停下来查 `.gitignore`，不要用 `git add -f` 绕过。
- 改了可见行为或接口，同一提交更新 `README.md` 与 `README.en.md`，并同步 `docs/API.md`。
