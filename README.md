# jiyi

DeepSeek Harness 官方桌面端的跨会话记忆。右侧栏「开始」页增加 **记忆** 入口：Markdown topic、回合后观察、生成索引，在下一轮开始前注入模型。

面向 **官方桌面**（`connection.fetch`），不依赖 `webServer`，也不走 `dsh plugin --profile desktop`。

## 做什么

- 右侧栏「记忆」浏览 global / 工作区 topic 与收件箱
- 有新消息的出步前只读生成当前索引，内容变化才重新注入；首次空仓不注入，删除最后一个 topic 后发送旧索引失效通知；保留 DSH 的 `startsRequestSeries` 等决策字段
- 模型用 `jiyi_list` / `jiyi_search` / `jiyi_read` 读记忆，不要用文件工具翻 `~/.dsh/jiyi`
- 只在官方 `session/event` 的 `turn/end` **completed** 最终边界采集，等 `xuxie` 同轮续写结束后再抽取一次。aborted（用户取消或释放导致的中止）记录 cancelled，error 记录 failed，max-tokens 记录 skipped，不把未正常完成的回合当成成功提取。已 completed 的抽取持有独立工作区/会话快照，随后的 Agent 释放不会取消它；没有 completed 边界的释放不会触发抽取。工具摘要仍读取 v4 直接输出、`source.callId`、`isError` 和结构化失败原因，未返回结果标为 unresolved。
- 摘要给回合状态和工具独立留出预算，先保留失败/未完成工具，再保留最近结果；长正文不会挤掉全部工具。输出注明展示和省略数量，不冒充完整日志。
- 用模型池抽取：主模型 `glm-5.3-flash`，副模型 `deepseek-flash`。纯任务/提问不送抽取模型；混合请求中的「以后」「默认」等持久约定仍参与抽取，「记住：」可本地采集。结构无效、超限的结果进入后备模型而不是假 noop；敏感内容过滤单独记为 filtered，存储/抽取失败可见。
- 索引提醒使用 v4 的 `plugin:jiyi` 消息来源；插件提醒、续写提醒和团队消息不会作为真实用户偏好采集。
- 抽出后用同一模型池整理 topic。整理计划先完整校验，再以可恢复事务更新；失败保留输入。处理过的原始观察（包括 noop）归档，不直接销毁。LLM 返回 `processed`/`archived` 和 `coverage: unverified`，不冒称所有观察都已融入主题；规则逐条合并才计入 `merged`。
- `/api/jiyi?action=status` 提供 `lastInjection`、`lastCapture`、`lastDream` 状态。带 sessionId 的 lastCapture 只显示该会话最新回合，lastInjection 只显示该会话的注入结果；旧回合迟到完成不能覆盖新回合 cancelled 状态，另一个会话注入成功不能掩盖本会话失败。不带 sessionId 的全局页保留最近实际工作状态。lastDream 表示跨工作区后台整理，而不是当前会话成功；UI 明确标注其范围和 cancelled/skipped 边界。后台失败可见，手动整理失败返回 `ok: false`。
- 右侧栏冷历史工作区复用官方 `sessionController.inspect(sessionId, signal)`，不创建/恢复 Agent、推理或修改会话。未知会话 404，缺少绝对 cwd（含相对 cwd）400，服务缺失 503，历史损坏/读取失败 500；有 sessionId 的失败不会降级为全局记忆。没有 sessionId 才是显式全局浏览。

文件在 `$DSH_HOME/jiyi/`（默认 `~/.dsh/jiyi/`），不写进用户仓库。同一 git origin 的 clone / worktree 共用工作区目录。

## 安装

复制到 `$DSH_HOME/plugins/jiyi`（默认 `$DSH_HOME` 为 `~/.dsh`），在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: jiyi
      name: ../../plugins/jiyi/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开，才能加载新的 Host/Client 代码。展开右侧栏，在「开始」里会出现 **记忆**。重启后已有会话在下一次有消息的出步前也会按当前索引检查注入；单纯刷新网页不保证更新 Host。

## 说明

- 面向官方桌面；不要用 `dsh plugin install` 往 desktop profile 塞依赖
- 记忆文件在 `$DSH_HOME/jiyi/`，不进本仓库、也不写进用户项目
- 仓库不含本机 patch、账号或凭据

## 安全与恢复边界

- 关闭会中止当前 Host 正在运行及排队中的抽取/整理，并等已接纳写操作停止后返回；插件 dispose 同样 abort 后等待 active 与排队的整理任务释放，不能先返回再后台收尾。设置更新原子串行，设置损坏报错而非自动开启。关闭不会撤销已经完成的写入。Agent disposed 则只释放注入/未完成事件缓存，不取消已经 completed 的抽取快照。
- 不带 Git host 的旧工作区目录无法区分同名 GitHub/GitLab 仓库，因此不再自动归属第一个访问者；检测到后明确报迁移错误，读写均不返回假空或擅自搬动。需先确认原仓库 origin，再将旧目录显式迁到正确目标；本次修复没有迁移用户真实数据。
- list/read/search 与索引快照不再创建目录、改写索引或清空 archive；不可读主题令搜索明确失败，不用空结果掩盖错误。
- 拒绝 store/scope/子目录/文件的符号链接，文件原子替换避免跟随既有 topic 链接；锁有所有者标识，活进程不会仅因超过两分钟被抢锁。不能把这些检查视为对同权限恶意进程不断交换目录的完整隔离。
- 观察文件用随机唯一标识，不再因同一秒、同一标题覆盖不同正文。整理按最多 10 条一批调用模型，不足 10 条也会清掉，不凑批、也不只在启动时扫一批就停。有待整理时会继续下一批，直到该范围收件箱清空或这一轮失败。失败最多再试 5 次，间隔 60 秒；模型调用期间新写入的观察留到下一批，不让这一批作废。单次输入仍限 64K 字符。已有 topic 上下文超预算则明确失败，不静默截断旧事实。
- 每个 scope 的 `archive/` 保留原观察和 `transaction-*.json` before-image。未完成事务使用 `.dream-transaction.json`，下次整理先回滚恢复。已完成事务的历史恢复目前需人工选择原观察或 before-image，没有恢复按钮。归档不自动删除，磁盘保留策略由用户管理。
- 索引采用 JSON 引用并声明不可信历史数据；工具/助手来源不能单独建立全局偏好。提示边界与来源约束降低注入风险，但不保证模型语义判断始终正确。
- 测试使用临时记忆根目录和模拟网络；不需要真实密钥。真实模型服务、真实历史数据迁移以及桌面重启后生效需单独验收。

## 开发

```bash
for file in lib/*.js; do /usr/local/bin/node --check "$file" || exit; done
TMPDIR=/tmp /usr/local/bin/node --test test/*.test.mjs
# 只读官方解包参考，可启用真实 Controller/Query/Store 检查，不启动 Host：
TMPDIR=/tmp DSH_OFFICIAL_ROOT=/absolute/read-only/dsh \
  /usr/local/bin/node --test test/official-history.test.mjs
```

2026-10-12 实测：bianji + jiyi 全套 **245/245 通过，0 跳过**，包括 **21 项官方类集成**和 **3 项真实 Chrome 隔离 DOM 测试**。该全量结果启用了官方只读 runtime 和已有 Playwright/React18 UMD 路径；未配置这些 fixture 的默认测试会明确跳过相应项，不能算全量通过。历史/生命周期首批 13 项回归修复前全部失败，修复后通过；补测 completed 后释放、用户/释放取消、max-tokens/error、迟到旧回合状态、A/B 注入隔离、live header 异常、cold/live 相对 cwd 拒绝、dispose 等待不遵循 abort 的迟响应。

官方历史测试真实构造 `SessionController`、`SessionQueryEngine`、`SessionStore` 和 projection，只有持久化 I/O、Agent 激活端点及未使用的 transport 服务是 fixture；cold status 的 Agent 激活/会话事件修改/遗留读取 handle 均为 0。浏览器运行的是本轮 Client 文件和模拟 API，验证 cancelled/skipped、注入失败、全局整理范围以及卸载；不代表已重启的真实桌面会话验收。

Host fixture 显式设置 /tmp 的 DSH_HOME，storage/dream/tools fixture 也只允许 /tmp/jiyi-*，并提供临时默认 DSH_HOME 防止测试落到真实记忆。dispose 等后台停止后再清理所有新 fixture 目录；测试用网络模拟和外部测试 guard，不读取或写入真实记忆、账号或会话，也不调用真实模型。本轮未更改公共配置/官方代码，未启动、恢复、切换历史 Agent，未重启应用。
