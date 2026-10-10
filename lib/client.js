window.__ModuleLoader__.load({
  id: "jiyi",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");

    var inject = ["slots", "sidebarRightTabs"];
    var TAB_ID = "jiyi";
    var TAB_KIND = "jiyi";
    var API_PATH = "/api/jiyi";
    var STYLE_ID = "jiyi-style";

    var cssText = [
      ".jy-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2328); font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, \"SF Pro Text\", \"Segoe UI\", sans-serif); font-size: 13px; }",
      ".jy-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l3, #e6e6e6); background: var(--dsw-alias-bg-layer-1, #f7f7f8); flex: none; flex-wrap: wrap; }",
      ".jy-title { font-weight: 600; margin-right: 4px; }",
      ".jy-btn { border: 1px solid var(--dsw-alias-border-l3, #d0d0d0); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 3px 8px; cursor: pointer; font: inherit; color: var(--dsw-alias-label-primary); }",
      ".jy-btn:hover:not(:disabled), .jy-item:hover { background: var(--dsw-alias-interactive-bg-hover); }",
      ".jy-btn:disabled { opacity: 0.45; cursor: default; }",
      ".jy-btn.is-on, .jy-item.is-on { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #007aff) 16%, transparent); border-color: var(--dsw-alias-border-l3, #d0d0d0); color: var(--dsw-alias-label-primary); }",
      ".jy-btn:focus-visible, .jy-item:focus-visible, .jy-search:focus-visible, .jy-input:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #007aff); outline-offset: 2px; }",
      ".jy-search { flex: 1; min-width: 80px; border: 1px solid var(--dsw-alias-border-l3, #d0d0d0); border-radius: 10px; padding: 4px 8px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }",
      ".jy-meta { padding: 6px 10px; color: var(--dsw-alias-label-secondary, #868e96); font-size: 12px; flex: none; }",
      ".jy-split { display: flex; flex: 1; min-height: 0; }",
      ".jy-list { width: 42%; min-width: 140px; overflow: auto; border-right: 1px solid var(--dsw-alias-border-l3, #e6e6e6); }",
      ".jy-group { padding: 8px 10px 4px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #868e96); }",
      ".jy-item { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; padding: 6px 10px; cursor: pointer; }",
      ".jy-item-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".jy-item-sub { display: block; font-size: 12px; color: var(--dsw-alias-label-secondary, #868e96); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".jy-preview { flex: 1; min-width: 0; display: flex; flex-direction: column; }",
      ".jy-preview-bar { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l3, #e6e6e6); flex: none; }",
      ".jy-pre { flex: 1; min-height: 0; margin: 0; padding: 10px 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; }",
      ".jy-empty { padding: 24px 12px; text-align: center; color: var(--dsw-alias-label-secondary, #868e96); }",
      ".jy-error { padding: 8px 10px; color: var(--dsw-alias-danger-fg, #c92a2a); font-size: 12px; }",
      ".jy-composer { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l3, #e6e6e6); flex: none; }",
      ".jy-input { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l3, #d0d0d0); border-radius: 10px; padding: 5px 8px; font: inherit; color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }",
    ].join(" ");

    function MemoryGlyph(props) {
      var size = props && props.size != null ? props.size : 26;
      return React.createElement(
        "svg",
        {
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: "1.7",
          className: props && props.className,
          "aria-hidden": "true",
        },
        React.createElement("path", { d: "M5 4h9a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3V4z" }),
        React.createElement("path", { d: "M17 4h2a2 2 0 0 1 2 2v14h-4V4z" }),
        React.createElement("path", { d: "M9 8h5M9 12h5" }),
      );
    }

    function MemoryTitle() {
      return React.createElement("span", null, "记忆");
    }

    function ensureStyle() {
      var existing = document.getElementById(STYLE_ID);
      if (existing) {
        existing.textContent = cssText;
        return;
      }
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = cssText;
      document.head.appendChild(style);
    }

    function sessionIdOf(props) {
      if (!props) return "";
      if (typeof props.sessionId === "string") return props.sessionId;
      if (props.session && typeof props.session.id === "string") return props.session.id;
      try {
        if (typeof props.useTabInfo === "function") {
          var info = props.useTabInfo();
          if (info && info.tab && typeof info.tab.sessionId === "string") return info.tab.sessionId;
        }
      } catch {
        // optional
      }
      return "";
    }

    function apiGet(params, signal) {
      return new Promise(function (resolve, reject) {
        var settled = false;
        var controller = new AbortController();
        var timer = setTimeout(function () {
          controller.abort();
          settle(new Error("加载超时"));
        }, 15000);
        function settle(error, value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal) signal.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else resolve(value);
        }
        function onAbort() {
          clearTimeout(timer);
          controller.abort();
        }
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort);
        }
        fetch(API_PATH + "?" + new URLSearchParams(params).toString(), { signal: controller.signal }).then(function (res) {
          return res.json();
        }).then(function (body) {
          settle(null, body);
        }, function (error) {
          settle(error);
        });
      });
    }

    function apiPost(body, signal) {
      return fetch(API_PATH, {
        signal: signal,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then(function (res) {
        return res.json();
      });
    }

    function groupLabel(scope, group) {
      var scopeName = scope === "global" ? "全局" : "工作区";
      if (group === "index") return scopeName + " · 索引";
      if (group === "topics") return scopeName + " · 主题";
      if (group === "inbox") return scopeName + " · 待整理";
      if (group === "conflict") return scopeName + " · 冲突";
      if (group === "archive") return scopeName + " · 归档";
      return scopeName;
    }

    function MemoryApp(props) {
      var sessionId = sessionIdOf(props);
      var dataState = React.useState(null);
      var data = dataState[0];
      var setData = dataState[1];
      var errState = React.useState("");
      var err = errState[0];
      var setErr = errState[1];
      var qState = React.useState("");
      var q = qState[0];
      var setQ = qState[1];
      var selState = React.useState("");
      var sel = selState[0];
      var setSel = selState[1];
      var previewState = React.useState(null);
      var preview = previewState[0];
      var setPreview = previewState[1];
      var noteState = React.useState("");
      var note = noteState[0];
      var setNote = noteState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];
      var confirmState = React.useState("");
      var confirm = confirmState[0];
      var setConfirm = confirmState[1];
      var statusErrState = React.useState("");
      var statusErr = statusErrState[0];
      var setStatusErr = statusErrState[1];
      var loadingState = React.useState(false);
      var loading = loadingState[0];
      var setLoading = loadingState[1];
      var loadFailedState = React.useState(false);
      var loadFailed = loadFailedState[0];
      var setLoadFailed = loadFailedState[1];
      busy = busy || loading;
      var statusGen = React.useRef(0);
      var statusRequest = React.useRef(null);
      var previewGen = React.useRef(0);
      var previewRequest = React.useRef(null);
      var operation = React.useRef(null);
      var delayedRefresh = React.useRef(null);
      var noteRevision = React.useRef(0);
      var refreshState = React.useState(0);
      var refreshVersion = refreshState[0];
      var setRefreshVersion = refreshState[1];
      var previewEntry = ((data && data.entries) || []).find(function (item) { return item.path === sel; });
      var previewFingerprint = previewEntry ? JSON.stringify([previewEntry.mtimeMs, previewEntry.size]) : null;

      function invalidatePreview() {
        previewGen.current += 1;
        if (previewRequest.current) previewRequest.current.abort();
        setPreview(null);
      }

      var load = React.useCallback(function (silent) {
        var gen = ++statusGen.current;
        if (statusRequest.current) statusRequest.current.abort();
        var controller = new AbortController();
        statusRequest.current = controller;
        if (!silent) {
          setLoading(true);
          setLoadFailed(false);
        }
        apiGet({ action: "status", sessionId: sessionId }, controller.signal).then(function (res) {
          if (controller.signal.aborted || statusGen.current !== gen) return;
          setLoading(false);
          if (!res || !res.ok) {
            setLoadFailed(true);
            setStatusErr((res && res.error) || "加载失败");
            return;
          }
          setLoadFailed(false);
          var dream = res.lastDream;
          if (res.lastInjection && res.lastInjection.status === "failed") {
            setStatusErr("记忆注入失败（" + res.lastInjection.code + "）");
          } else if (res.lastCapture && res.lastCapture.status === "failed") {
            setStatusErr("回合记忆采集失败（" + res.lastCapture.code + "），不能视为没有新记忆");
          } else if (dream && dream.via === "failed") {
            setStatusErr("整理失败，收件箱仍有 " + (dream.remaining || res.inboxCount || 0) + " 条");
          } else if (dream && dream.remaining > 0) {
            setStatusErr("整理未完成，剩余 " + dream.remaining + " 条");
          } else {
            setStatusErr("");
          }
          setData(res);
        }).catch(function (error) {
          if (controller.signal.aborted || statusGen.current !== gen) return;
          setLoading(false);
          setLoadFailed(true);
          setStatusErr(String(error));
        });
      }, [sessionId]);

      React.useEffect(function () {
        setData(null);
        setSel("");
        setConfirm("");
        setPreview(null);
        setErr("");
        setStatusErr("");
        setBusy(false);
        setNote("");
        noteRevision.current += 1;
        load();
        var timer = setInterval(function () { load(true); }, 12000);
        return function () {
          clearInterval(timer);
          clearTimeout(delayedRefresh.current);
          statusGen.current += 1;
          previewGen.current += 1;
          if (statusRequest.current) statusRequest.current.abort();
          if (previewRequest.current) previewRequest.current.abort();
          if (operation.current) operation.current.abort();
          operation.current = null;
        };
      }, [load]);

      React.useEffect(function () {
        invalidatePreview();
        setConfirm("");
        if (!sel || previewFingerprint === null) return;
        var gen = previewGen.current;
        var controller = new AbortController();
        previewRequest.current = controller;
        apiGet({ action: "read", path: sel, sessionId: sessionId }, controller.signal).then(function (res) {
          if (controller.signal.aborted || previewGen.current !== gen) return;
          setPreview({ path: sel, sessionId: sessionId, fingerprint: previewFingerprint, refreshVersion: refreshVersion, ok: !!(res && res.ok),
            content: res && res.ok ? (res.content || "") : ((res && res.error) || "读取失败") });
        }).catch(function (error) {
          if (controller.signal.aborted || previewGen.current !== gen) return;
          setPreview({ path: sel, sessionId: sessionId, fingerprint: previewFingerprint, refreshVersion: refreshVersion, ok: false, content: String(error) });
        });
        return function () {
          controller.abort();
          previewGen.current += 1;
        };
      }, [sel, sessionId, previewFingerprint, refreshVersion]);

      var entries = (data && data.entries) || [];
      var needle = q.trim().toLowerCase();
      if (needle) {
        entries = entries.filter(function (item) {
          return [item.label, item.relative, item.description].join(" ").toLowerCase().indexOf(needle) >= 0;
        });
      }

      var groups = [];
      var lastKey = "";
      entries.forEach(function (item) {
        var key = item.scope + "/" + item.group;
        if (key !== lastKey) {
          groups.push({ type: "head", key: key, label: groupLabel(item.scope, item.group) });
          lastKey = key;
        }
        groups.push({ type: "item", key: item.path, item: item });
      });

      function run(action, extra) {
        if (operation.current) return;
        if (action === "remember" && extra && extra.scope === "workspace" && !sessionId) {
          setErr("未绑定工作区，无法记下工作区约定");
          return;
        }
        var controller = new AbortController();
        operation.current = controller;
        var submittedRevision = noteRevision.current;
        setErr("");
        setBusy(true);
        apiPost(Object.assign({ action: action, sessionId: sessionId }, extra || {}), controller.signal).then(function (res) {
          if (controller.signal.aborted || operation.current !== controller) return;
          operation.current = null;
          setBusy(false);
          if (!res || !res.ok) {
            setErr((res && res.error) || "操作失败");
            return;
          }
          if (action === "delete") {
            invalidatePreview();
            setSel("");
            setConfirm("");
          }
          if (action === "remember") {
            if (noteRevision.current === submittedRevision) setNote("");
            clearTimeout(delayedRefresh.current);
            delayedRefresh.current = setTimeout(function () { load(true); }, 2500);
          }
          load();
        }).catch(function (error) {
          if (controller.signal.aborted || operation.current !== controller) return;
          operation.current = null;
          setBusy(false);
          setErr(String(error));
        });
      }

      var off = data && data.enabled === false;

      var listPlaceholder = "";
      if (groups.length === 0) {
        if (loading || (data === null && !loadFailed)) listPlaceholder = "正在加载…";
        else if (loadFailed) listPlaceholder = "加载失败";
        else if (data && Array.isArray(data.entries) && data.entries.length === 0) {
          listPlaceholder = "还没有记忆。回合结束后由插件自动记下。这些文件给模型只读，不要让它改。";
        }
      }
      var listNodes = listPlaceholder
        ? [React.createElement("div", { key: "empty", className: "jy-empty" }, listPlaceholder)]
        : groups.map(function (row) {
          if (row.type === "head") {
            return React.createElement("div", { key: row.key, className: "jy-group" }, row.label);
          }
          var item = row.item;
          return React.createElement(
            "button",
            {
              key: item.path,
              type: "button",
              className: "jy-item" + (sel === item.path ? " is-on" : ""),
              disabled: busy,
              onClick: function () {
                if (busy) return;
                if (sel !== item.path) invalidatePreview();
                setSel(item.path);
                setConfirm("");
              },
            },
            React.createElement("span", { className: "jy-item-name" }, item.label),
            React.createElement("span", { className: "jy-item-sub" }, item.relative),
          );
        });

      var selected = entries.find(function (item) { return item.path === sel; });
      var currentPreview = preview && preview.path === sel && preview.sessionId === sessionId
        && preview.fingerprint === previewFingerprint && preview.refreshVersion === refreshVersion ? preview : null;

      return React.createElement(
        "div",
        { className: "jy-root" },
        React.createElement(
          "div",
          { className: "jy-toolbar" },
          React.createElement("span", { className: "jy-title" }, "记忆"),
          React.createElement("button", {
            type: "button",
            className: "jy-btn" + (data && data.enabled ? " is-on" : ""),
            disabled: busy,
            onClick: function () { run("toggle"); },
          }, data && data.enabled !== false ? "记忆开" : "已停用"),
          React.createElement("button", {
            type: "button",
            className: "jy-btn",
            disabled: busy || off,
            onClick: function () { run("dream"); },
          }, "整理"),
          React.createElement("button", {
            type: "button",
            className: "jy-btn",
            disabled: busy,
            onClick: function () {
              invalidatePreview();
              setRefreshVersion(function (version) { return version + 1; });
              load();
            },
          }, "刷新"),
          React.createElement("input", {
            className: "jy-search",
            value: q,
            placeholder: "筛选…",
            onChange: function (event) { setQ(event.target.value); },
          }),
        ),
        React.createElement(
          "div",
          { className: "jy-meta" },
          (data && data.origin ? data.origin : (data && data.cwd ? data.cwd : "未绑定工作区"))
          + " · 模型只读，写入由插件或下方手动"
          + (data && data.hasCredentials === false ? " · 无抽取凭据" : "")
          + (data && data.lastCapture && data.lastCapture.status === "failed" ? " · 上次采集失败" : "")
          + (data && data.lastDream && data.lastDream.via === "failed" ? " · 上次整理失败" : "")
          + (data && data.lastDream && data.lastDream.coverage === "unverified"
            ? " · 已处理 " + (data.lastDream.processed || 0) + " 条；原文已归档，未逐条验证主题覆盖"
            : (data && data.lastDream && data.lastDream.archived > 0 ? " · 本次归档 " + data.lastDream.archived + " 条原始观察（可恢复）" : ""))
          + (data && data.inboxCount ? " · 待整理 " + data.inboxCount + " 条" : "")
          + (off ? " · 已停用注入/抽取/手记/整理/模型读取/删除" : ""),
        ),
        err ? React.createElement("div", { className: "jy-error" }, err) : null,
        statusErr ? React.createElement("div", { className: "jy-error" }, statusErr) : null,
        React.createElement(
          "div",
          { className: "jy-split" },
          React.createElement("div", { className: "jy-list" }, listNodes),
          React.createElement(
            "div",
            { className: "jy-preview" },
            selected
              ? React.createElement(
                "div",
                { className: "jy-preview-bar" },
                React.createElement("span", { className: "jy-item-sub", title: selected.path }, selected.relative),
                selected.deletable
                  ? React.createElement("button", {
                    type: "button",
                    className: "jy-btn",
                    disabled: busy || off || !currentPreview || !currentPreview.ok,
                    onClick: function () {
                      if (busy || off || !currentPreview || !currentPreview.ok) return;
                      if (confirm !== selected.path) {
                        setConfirm(selected.path);
                        return;
                      }
                      run("delete", { path: selected.path });
                    },
                  }, confirm === selected.path ? "确认删除" : "删除")
                  : null,
              )
              : null,
            React.createElement("pre", { className: "jy-pre" }, selected ? (currentPreview ? currentPreview.content : "加载中…") : "选择左侧一条记忆"),
          ),
        ),
        React.createElement(
          "div",
          { className: "jy-composer" },
          React.createElement("input", {
            className: "jy-input",
            value: note,
            placeholder: "你手动补一条约定…",
            onChange: function (event) { noteRevision.current += 1; setNote(event.target.value); },
            onKeyDown: function (event) {
              if (event.key === "Enter" && note.trim() && !busy && !off) {
                run("remember", { text: note.trim(), scope: "workspace" });
              }
            },
          }),
          React.createElement("button", {
            type: "button",
            className: "jy-btn",
            disabled: busy || off || !note.trim(),
            onClick: function () { run("remember", { text: note.trim(), scope: "workspace" }); },
          }, "记下"),
          React.createElement("button", {
            type: "button",
            className: "jy-btn",
            disabled: busy || off || !note.trim(),
            onClick: function () { run("remember", { text: note.trim(), scope: "global" }); },
          }, "全局"),
        ),
      );
    }

    function apply(ctx) {
      ensureStyle();
      function MemoryTab(props) {
        return React.createElement(MemoryApp, props);
      }
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: "extension",
          title: function () { return "记忆"; },
          guide: [{
            id: "open",
            order: 28,
            title: function () { return "记忆"; },
            description: function () { return "跨会话约定；模型只读，写入由插件完成"; },
            icon: MemoryGlyph,
          }],
        });
      }, "jiyi.type");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab", function () {
          return ctx.slots.register(
            { name: "sidebar.right.pane.tab", key: TAB_ID },
            MemoryTab,
          );
        });
      }, "jiyi.body");
      ctx.effect(function () {
        return ctx.slots.inject("sidebar.right.pane.tab.title", function () {
          return ctx.slots.register(
            { name: "sidebar.right.pane.tab.title", key: TAB_ID },
            MemoryTitle,
          );
        });
      }, "jiyi.title");
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
