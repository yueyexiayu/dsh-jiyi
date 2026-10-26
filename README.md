# jiyi · DSH 跨会话记忆插件

**版本：0.1.14** · MIT · DeepSeek Harness desktop plugin

jiyi 在用户回合正常完成后后台提取明确事实，在新的相关输入到来时按项目范围检索，独立判断支持度，再补充原始记忆。右侧栏“记忆”提供查看、来源、纠正、删除、别名、失败队列和模型配置。

## 功能与边界

- SQLite 持久化来源、版本、替代关系、FTS5、384维本地向量及后台队列。
- 默认只检索全局与当前项目；明确引用其他项目时才扩展，歧义不自动合并。
- 本地 MiniLM 产生候选，独立 LLM 判断原文是否支持实际问项。候选相似不等于允许注入。
- 入选项严格校验原始 `id/version` 和逐字 `quote`，拒绝伪造、过期、重复或非法响应；超时与错误明确报告，不冒充“无相关记忆”。
- 同义问句、明确否定约束及混合问题中的已知部分可构成支持。业务码不自动等于 HTTP 状态，表示约定不证明未记载的实现。
- 自动流程不依赖主模型主动调用 `jiyi_search`；此工具是补充入口。关闭管理面板不停止 Host，停用插件才停止提取/召回。
- 不自动导入全部历史，不把助手推测或记忆中的命令当作用户事实/指令。纠正和删除影响后续召回，不抹除既有聊天文本。

## 环境

本版本验证环境为 **macOS arm64、Node 24.21、Electron 44**，需要已安装 DeepSeek Harness 桌面端。依赖 DSH 的 `agent`、LLM、工具、存储和右侧栏 SDK，不是独立 Node 应用。完整测试包含安装包内 SDK，不能把缺少桌面环境的测试失败当作通过。

本仓库是桌面文件系统插件：包名/Host/Client bundle id 均为 `jiyi`，入口是文件而非目录。保留 `private: true`，不通过 npm 发布。

## 安装

先备份现有插件和记忆数据。以下示例使用默认 `DSH_HOME=$HOME/.dsh`；已有安装不要直接覆盖数据目录。

```sh
export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
git clone https://github.com/yueyexiayu/dsh-jiyi.git "$DSH_HOME/plugins/jiyi"
cd "$DSH_HOME/plugins/jiyi"

# Node 24 / npm 需要在 PATH 中；使用 lockfile 安装当前平台依赖。
npm ci --prefix deps

# 显式联网安装固定 revision 的模型，逐文件校验字节数及 SHA256。
node scripts/prepare-models.mjs
```

模型清单位于 [models/manifest.json](<models/manifest.json>)，运行库锁定 `@huggingface/transformers@3.8.1`。模型约129 MiB，其中 ONNX 单文件超过100 MiB，**不提交模型、node_modules或运行缓存**。安装脚本不使用 DSH 账号/凭据；已有资产仅校验，校验错误会中止，不默默换模型。运行时只读本地模型并禁止远程模型自动下载；LLM 调用仍需提供方网络和用户已有授权。

在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 中，将下面项目**合并到已有配置**，不要覆盖其他插件：

```yaml
- insert:
    - id: jiyi
      name: ../../plugins/jiyi/lib/index.js
```

相对路径以 desktop patch 自身所在目录为准。包内 [cordis.patch.yml](<cordis.patch.yml>) 是插件 bundle 声明，不要把它不加修改地覆盖 desktop profile。保持 profile 文件权限0600。

**⌘Q 完全退出 DSH 后重新打开。** 在正常认证的应用菜单“在浏览器中打开”入口检查右栏“记忆”，确认 Client/Host 均0.1.14，再配置并分别验证提取、Embedding、相关性模型。保存设置不等于模型验证成功。不要分享包含认证信息的浏览器入口。

## 默认配置

| 项目 | 默认值 |
|---|---|
| 提取 | `openai-codex/gpt-6.1-sol`，60000ms |
| 相关性 | `openai-codex/gpt-6.1-sol`，10000ms，可在面板独立调整 |
| Embedding | `Xenova/paraphrase-multilingual-MiniLM-L12-v2`，q8 CPU，384维 |
| 候选/最终记忆 | 最多12 / 6条 |
| 候选语义阈值 | `0.20`，不作为最终注入授权 |
| 完整注入预算 | 4000 UTF-8字节 |
| 状态陈旧时间 | 72小时，降权而非删除 |

数据与设置位于 `$DSH_HOME/storages/jiyi/`，不在 Git 仓库中。目录/文件采用0700/0600权限；不要提交数据库、WAL、账号记录、会话原文或原始评测输出。API 路径为 `/api/jiyi`，只通过 DSH 正常认证入口访问；凭据保留在 Host。

冷加载默认上限120秒，推理/召回默认10秒；Embedding 最多2个隔离子进程，过载、取消、超时和释放失败明确报告。LLM token 预算是否在服务端实施取决于提供方 adapter，不能将本地预算意图当作服务端硬限制。

## 测试

先安装依赖和模型，并确保 macOS 的 `/Applications/DeepSeek Harness.app` 与 `/usr/local/bin/node` 可用。测试使用独立临时 SQLite、合成来源和受控 LLM；本地 Embedding 与安装包 SDK 实际执行，不需要云端账号，不操作正式记忆。

```sh
NODE_OPTIONS='' /usr/local/bin/node --test --test-timeout=90000 test/*.test.mjs
ELECTRON_RUN_AS_NODE=1 NODE_OPTIONS='' \
  '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' \
  --test --test-timeout=90000 test/*.test.mjs
for file in lib/*.js scripts/*.mjs; do /usr/local/bin/node --check "$file" || exit; done
```

公开测试夹具独立于本机数据；不发布私人会话、实际项目路径或原始评测记录。`evidence/` 仅保留空目录占位，运行输出被 Git 忽略。真实模型效果不能由受控 fixture 冒充；内部相关性规则版本为 `jiyi-relevance-v7`，提取器为v4。

0.1.14 发布前的指定本机验收：Q13首次五次5/5，固定36题两轮36/36，未将旧正确应注入项变空。该有限样本不代表任意查询永久可靠；原始数据因隐私不在公开仓库。本机召回p50约1.43–1.45秒，较此前1.18–1.23秒增加，不宣称性能优化。

## 更新、迁移和卸载

更新前备份插件、settings及SQLite（运行中数据库应使用 SQLite backup API 或安全一致性备份）。新安装直接生成当前结构；从旧的 topics/inbox 架构迁移不可仅凭版本号假定无损。项目别名补登使用 [scripts/migrate-aliases.mjs](<scripts/migrate-aliases.mjs>) 的显式流程，先审阅计划及备份，不静默重写正式记忆。

卸载时先从 desktop patch 中移除 **jiyi 对应项**，再完全退出/重开 DSH。数据目录需用户另行决定保留或删除，不要为卸载清空整个 profile。

## 仓库规范与许可

本仓库公开，GitHub Topic 为 **`dsh-plugin`**，并填写 description，供 DSH 社区目录发现；不代表官方自动安装或已通过社区人工审核。没有自动提交自荐 PR。

源码沿用 [MIT License](<LICENSE>)。模型为独立的 Apache-2.0 资产，来源、固定revision及校验和见模型清单；第三方依赖沿用各自许可。
