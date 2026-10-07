# jiyi

DeepSeek Harness 官方桌面端的跨会话记忆。右侧栏「开始」页增加 **记忆** 入口：Markdown topic、回合后观察、生成索引，在下一轮开始前注入模型。

面向 **官方桌面**（`connection.fetch`），不依赖 `webServer`，也不走 `dsh plugin --profile desktop`。

## 做什么

- 右侧栏「记忆」浏览 global / 工作区 topic 与收件箱
- 有新消息的出步前只读生成当前索引，内容变化才重新注入；首次空仓不注入，删除最后一个 topic 后发送旧索引失效通知；保留 DSH 的 `startsRequestSeries` 等决策字段
- 模型用 `jiyi_list` / `jiyi_search` / `jiyi_read` 读记忆，不要用文件工具翻 `~/.dsh/jiyi`
- 在官方 `session/event` 的 `turn/end` 最终边界采集，等 `xuxie` 同轮续写结束后再抽取一次；错误、取消和输出上限也保留真实结束状态。工具摘要读取 v4 的直接工具输出、`source.callId`、`isError` 和结构化失败原因，未返回结果的工具标为 unresolved。
- 摘要给回合状态和工具独立留出预算，先保留失败/未完成工具，再保留最近结果；长正文不会挤掉全部工具。输出注明展示和省略数量，不冒充完整日志。
- 用模型池抽取：主模型 `glm-5.3-flash`，副模型 `deepseek-flash`。纯任务/提问不送抽取模型；混合请求中的「以后」「默认」等持久约定仍参与抽取，「记住：」可本地采集。结构无效、超限的结果进入后备模型而不是假 noop；敏感内容过滤单独记为 filtered，存储/抽取失败可见。
- 索引提醒使用 v4 的 `plugin:jiyi` 消息来源；插件提醒、续写提醒和团队消息不会作为真实用户偏好采集。
- 抽出后用同一模型池整理 topic。整理计划先完整校验，再以可恢复事务更新；失败保留输入。处理过的原始观察（包括 noop）归档，不直接销毁。LLM 返回 `processed`/`archived` 和 `coverage: unverified`，不冒称所有观察都已融入主题；规则逐条合并才计入 `merged`。
- `/api/jiyi?action=status` 提供 `lastInjection`、`lastCapture`、`lastDream` 状态；后台失败可见，手动整理失败返回 `ok: false`。

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

- 关闭会中止当前 Host 正在运行及排队中的抽取/整理，并等已接纳写操作停止后返回；设置更新原子串行，设置损坏报错而非自动开启。关闭不会撤销已经完成的写入。
- 不带 Git host 的旧工作区目录无法区分同名 GitHub/GitLab 仓库，因此不再自动归属第一个访问者；检测到后明确报迁移错误，读写均不返回假空或擅自搬动。需先确认原仓库 origin，再将旧目录显式迁到正确目标；本次修复没有迁移用户真实数据。
- list/read/search 与索引快照不再创建目录、改写索引或清空 archive；不可读主题令搜索明确失败，不用空结果掩盖错误。
- 拒绝 store/scope/子目录/文件的符号链接，文件原子替换避免跟随既有 topic 链接；锁有所有者标识，活进程不会仅因超过两分钟被抢锁。不能把这些检查视为对同权限恶意进程不断交换目录的完整隔离。
- 观察文件用随机唯一标识，不再因同一秒、同一标题覆盖不同正文。单次整理最多 32 条观察、64K 字符输入；超出部分保留等待后续整理。已有 topic 上下文超预算则明确失败，不静默截断旧事实。
- 每个 scope 的 `archive/` 保留原观察和 `transaction-*.json` before-image。未完成事务使用 `.dream-transaction.json`，下次整理先回滚恢复。已完成事务的历史恢复目前需人工选择原观察或 before-image，没有恢复按钮。归档不自动删除，磁盘保留策略由用户管理。
- 索引采用 JSON 引用并声明不可信历史数据；工具/助手来源不能单独建立全局偏好。提示边界与来源约束降低注入风险，但不保证模型语义判断始终正确。
- 测试使用临时记忆根目录和模拟网络；不需要真实密钥。真实模型服务、真实历史数据迁移以及桌面重启后生效需单独验收。

## 开发

```bash
for file in lib/*.js; do /usr/local/bin/node --check "$file" || exit; done
/usr/local/bin/node --test
```
