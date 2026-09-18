# jiyi

DeepSeek Harness 桌面插件。借鉴 [Grok Build v2](https://github.com/xai-org/grok-build) 的跨会话记忆：Markdown topic、回合后观察、生成索引，在下一轮开始前注入模型。

不是对 Grok 源码的移植。存储、调度和 UI 是本插件的 JavaScript 实现。

## 做什么

- 右侧栏「记忆」浏览 global / 工作区 topic 与收件箱
- 新会话第一次出步时，若已有 topic 才注入 `MEMORY.md` 索引；空仓不注入
- 模型用 `jiyi_list` / `jiyi_search` / `jiyi_read` 读记忆，不要用文件工具翻 `~/.dsh/jiyi`
- 每个完成回合后用模型池抽取：主模型 `glm-5.3-flash`，副模型 `deepseek-flash`。任务/提问轮次不送抽取模型，只保留「记住：」类本地观察；全部失败则 noop
- 抽出后用同一模型池整理 topic。模型认为无新事实时消化收件箱；调用失败才留着重试

文件在 `$DSH_HOME/jiyi/`（默认 `~/.dsh/jiyi/`），不写进用户仓库。同一 git origin 的 clone / worktree 共用工作区目录。

## 安装

复制到 `$DSH_HOME/plugins/jiyi`（默认 `$DSH_HOME` 为 `~/.dsh`），在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 写入：

```yaml
- insert:
    - id: jiyi
      name: ../../plugins/jiyi/lib/index.js
```

完全退出 DeepSeek Harness（macOS：⌘Q）再打开。展开右侧栏，在「开始」里会出现 **记忆**。已有会话不会补上注入，需新开。

## 开发

```bash
/usr/local/bin/node --check lib/index.js lib/client.js lib/storage.js lib/capture.js lib/dream.js lib/inject.js lib/parse.js lib/extract.js lib/tools.js
/usr/local/bin/node --test
```
