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
      ".jy-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f2328); font-size: 13px; }",
      ".jy-toolbar { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--dsw-alias-border-l3, #e6e6e6); background: var(--dsw-alias-bg-layer-1, #f7f7f8); flex: none; flex-wrap: wrap; }",
      ".jy-title { font-weight: 600; margin-right: 4px; }",
      ".jy-btn { border: 1px solid var(--dsw-alias-border-l3, #d0d0d0); background: #fff; border-radius: 6px; padding: 3px 8px; cursor: pointer; font: inherit; color: inherit; }",
      ".jy-btn:hover { background: var(--dsw-alias-bg-module-platform, #ececec); }",
      ".jy-btn:disabled { opacity: 0.45; cursor: default; }",
      ".jy-btn.is-on { background: #094771; border-color: #094771; color: #fff; }",
      ".jy-search { flex: 1; min-width: 80px; border: 1px solid var(--dsw-alias-border-l3, #d0d0d0); border-radius: 6px; padding: 4px 8px; font: inherit; }",
      ".jy-meta { padding: 6px 10px; color: var(--dsw-alias-label-secondary, #868e96); font-size: 12px; flex: none; }",
      ".jy-split { display: flex; flex: 1; min-height: 0; }",
      ".jy-list { width: 42%; min-width: 140px; overflow: auto; border-right: 1px solid var(--dsw-alias-border-l3, #e6e6e6); }",
      ".jy-group { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-secondary, #868e96); }",
      ".jy-item { display: block; width: 100%; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; padding: 6px 10px; cursor: pointer; }",
      ".jy-item:hover { background: rgba(0,0,0,0.05); }",
      ".jy-item.is-on { background: rgba(77,171,247,0.18); }",
      ".jy-item-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".jy-item-sub { display: block; font-size: 11px; color: var(--dsw-alias-label-secondary, #868e96); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
      ".jy-preview { flex: 1; min-width: 0; display: flex; flex-direction: column; }",
      ".jy-preview-bar { display: flex; gap: 6px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--dsw-alias-border-l3, #e6e6e6); flex: none; }",
      ".jy-pre { flex: 1; min-height: 0; margin: 0; padding: 10px 12px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; }",
      ".jy-empty { padding: 24px 12px; text-align: center; color: var(--dsw-alias-label-secondary, #868e96); }",
      ".jy-error { padding: 8px 10px; color: var(--dsw-alias-danger-fg, #c92a2a); font-size: 12px; }",
      ".jy-composer { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l3, #e6e6e6); flex: none; }",
      ".jy-input { flex: 1; min-width: 0; border: 1px solid var(--dsw-alias-border-l3, #d0d0d0); border-radius: 6px; padding: 5px 8px; font: inherit; }",
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

    function apiGet(params) {
      return fetch(API_PATH + "?" + new URLSearchParams(params).toString()).then(function (res) {
        return res.json();
      });
    }

    function apiPost(body) {
      return fetch(API_PATH, {
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
      var previewState = React.useState("");
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
      var previewGen = React.useRef(0);

      var load = React.useCallback(function (silent) {
        if (!silent) setBusy(true);
        apiGet({ action: "status", sessionId: sessionId }).then(function (res) {
          if (!silent) setBusy(false);
          if (!res || !res.ok) {
            setErr((res && res.error) || "加载失败");
            return;
          }
          var dream = res.lastDream;
          if (dream && dream.via === "failed") {
            setErr("整理失败，收件箱仍有 " + (dream.remaining || res.inboxCount || 0) + " 条");
          } else if (dream && dream.remaining > 0) {
            setErr("整理未完成，剩余 " + dream.remaining + " 条");
          } else {
            setErr("");
          }
          setData(res);
        }).catch(function (error) {
          if (!silent) setBusy(false);
          setErr(String(error));
        });
      }, [sessionId]);

      React.useEffect(function () {
        load();
        var timer = setInterval(function () { load(true); }, 12000);
        return function () { clearInterval(timer); };
      }, [load]);

      React.useEffect(function () {
        if (!sel) {
          setPreview("");
          return;
        }
        var gen = previewGen.current + 1;
        previewGen.current = gen;
        apiGet({ action: "read", path: sel, sessionId: sessionId }).then(function (res) {
          if (previewGen.current !== gen) return;
          if (!res || !res.ok) {
            setPreview((res && res.error) || "读取失败");
            return;
          }
          setPreview(res.content || "");
        }).catch(function (error) {
          if (previewGen.current !== gen) return;
          setPreview(String(error));
        });
      }, [sel, sessionId, data]);

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
        if (action === "remember" && extra && extra.scope === "workspace" && !sessionId) {
          setErr("未绑定工作区，无法记下工作区约定");
          return;
        }
        setBusy(true);
        apiPost(Object.assign({ action: action, sessionId: sessionId }, extra || {})).then(function (res) {
          setBusy(false);
          if (!res || !res.ok) {
            setErr((res && res.error) || "操作失败");
            return;
          }
          if (action === "delete") {
            setSel("");
            setConfirm("");
          }
          if (action === "remember") {
            setNote("");
            setTimeout(function () { load(true); }, 2500);
          }
          load();
        }).catch(function (error) {
          setBusy(false);
          setErr(String(error));
        });
      }

      var off = data && data.enabled === false;

      var listNodes = groups.length === 0
        ? [React.createElement("div", { key: "empty", className: "jy-empty" }, "还没有记忆。回合结束后由插件自动记下。这些文件给模型只读，不要让它改。")]
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
              onClick: function () {
                setSel(item.path);
                setConfirm("");
              },
            },
            React.createElement("span", { className: "jy-item-name" }, item.label),
            React.createElement("span", { className: "jy-item-sub" }, item.relative),
          );
        });

      var selected = entries.find(function (item) { return item.path === sel; });

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
            onClick: function () { load(); },
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
          + (data && data.lastDream && data.lastDream.via === "failed" ? " · 上次整理失败" : "")
          + (data && data.inboxCount ? " · 待整理 " + data.inboxCount + " 条" : "")
          + (off ? " · 已停用注入/抽取/手记/整理/模型读取/删除" : ""),
        ),
        err ? React.createElement("div", { className: "jy-error" }, err) : null,
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
                    disabled: busy || off,
                    onClick: function () {
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
            React.createElement("pre", { className: "jy-pre" }, preview || (selected ? "加载中…" : "选择左侧一条记忆")),
          ),
        ),
        React.createElement(
          "div",
          { className: "jy-composer" },
          React.createElement("input", {
            className: "jy-input",
            value: note,
            placeholder: "你手动补一条约定…",
            onChange: function (event) { setNote(event.target.value); },
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
