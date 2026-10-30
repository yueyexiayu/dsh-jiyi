window.__ModuleLoader__.load({
  id: "jiyi",
  factory: function (require) {
    var React = require("react");
    var h = React.createElement;
    var inject = ["slots", "sidebarRightTabs", "uiWorkspace"];
    var API_PATH = "/api/jiyi";
    var VERSION = "0.1.18";
    var css = [
      ".jiyi-root{height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:14px;color:var(--dsw-alias-label-primary,#20242a);background:var(--dsw-alias-bg-base,#fff);font:13px/1.55 var(--dsw-font-family,system-ui,sans-serif)}",
      ".jiyi-root *{box-sizing:border-box}.jiyi-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.jiyi-heading{font-size:16px;margin:0}.jiyi-muted{color:var(--dsw-alias-label-secondary,#757b85);font-size:12px;overflow-wrap:anywhere}.jiyi-spacer{flex:1}",
      ".jiyi-root button,.jiyi-root input,.jiyi-root select,.jiyi-root textarea{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l3,#d9dce1);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#f8f9fb);padding:6px 9px;min-width:0}.jiyi-root button{cursor:pointer}.jiyi-root button:disabled{opacity:.5;cursor:default}.jiyi-root button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#eceff4)}",
      ".jiyi-root :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#3478e5);outline-offset:2px}.jiyi-root textarea{display:block;width:100%;min-height:100px;resize:vertical}.jiyi-search{margin:12px 0;display:grid;gap:8px}.jiyi-search input{width:100%}.jiyi-card{border:1px solid var(--dsw-alias-border-l3,#e1e4e9);border-radius:12px;padding:12px;margin:10px 0}.jiyi-content{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}.jiyi-badge{border-radius:6px;padding:1px 6px;background:var(--dsw-alias-bg-layer-1,#eff2f6);font-size:11px}.jiyi-error{color:var(--dsw-alias-danger-fg,#c23b3b);white-space:pre-wrap;overflow-wrap:anywhere}.jiyi-notice{padding:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.jiyi-root details{border-top:1px solid var(--dsw-alias-border-l3,#e1e4e9);margin-top:14px;padding-top:12px}.jiyi-root summary{cursor:pointer;font-weight:600}.jiyi-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin:12px 0}.jiyi-field{display:flex;flex-direction:column;gap:4px}.jiyi-source{margin:8px 0;padding-left:9px;border-left:2px solid var(--dsw-alias-border-l3,#d9dce1)}.jiyi-danger{color:var(--dsw-alias-danger-fg,#c23b3b)!important}.jiyi-root pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.jiyi-root ul{padding-left:18px}"
    ].join("\n");

    function ensureStyle() {
      var style = document.getElementById("jiyi-style");
      if (!style) { style = document.createElement("style"); style.id = "jiyi-style"; document.head.appendChild(style); }
      style.textContent = css;
    }
    function errorText(error) { return error && error.message ? error.message : String(error); }
    async function request(op, body, signal, params) {
      var url = new URL(API_PATH, window.location.origin);
      url.searchParams.set("op", op);
      Object.keys(params || {}).forEach(function (key) { if (params[key] != null) url.searchParams.set(key, params[key]); });
      var options = { method: body ? "POST" : "GET", signal: signal, cache: "no-store" };
      if (body) { options.headers = { "Content-Type": "application/json" }; options.body = JSON.stringify(Object.assign({}, body, { op: op })); }
      var response = await fetch(url.pathname + url.search, options);
      var data;
      try { data = await response.json(); } catch (_) { throw new Error("Host 返回的不是有效 JSON（HTTP " + response.status + "）"); }
      if (response.ok && op === "search" && data && typeof data.status === "string" && Array.isArray(data.memories)) return data;
      if (!response.ok || !data || data.ok !== true) throw new Error(data && data.error ? errorText(data.error) : "请求失败（HTTP " + response.status + "）");
      return data;
    }
    function queueErrorCategory(value) {
      var text = typeof value === "string" ? value : JSON.stringify(value);
      if (/adapter[^\n]*(?:not registered|isn't registered|未注册)|(?:not registered|未注册)[^\n]*adapter|no adapter registered/i.test(text)) return "adapter 未注册";
      if (/EXTRACTION_SCHEMA|抽取结果 schema 无效或超过 12 条|抽取记忆缺少有效内容\/类型\/范围\/来源/i.test(text)) return "抽取 schema 无效";
      return "未知";
    }
    function timestamp(value) {
      if (!value) return "未记录";
      var date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
    }
    function modelText(value) {
      if (!value) return "未记录";
      return typeof value === "string" ? value : JSON.stringify(value);
    }
    function compatibilityProblem(data) {
      if (!data) return "尚未加载 Host 状态，不能修改、检索或验证。";
      if (data.version !== VERSION) return "Host v" + (data.version || "未提供") + " 与 Client v" + VERSION + " 不一致；请安全地完全重启 DSH 后再操作。";
      var relevance = data.settings && data.settings.relevance;
      var retrieval = data.settings && data.settings.retrieval;
      var model = data.models && data.models.relevance;
      if (!relevance || !Object.prototype.hasOwnProperty.call(relevance, "provider") || !Object.prototype.hasOwnProperty.call(relevance, "model") || !Number.isFinite(relevance.timeoutMs) || !retrieval || !Number.isInteger(retrieval.maxCandidates) || !model || typeof model.status !== "string" || typeof model.ready !== "boolean") return "Host 缺少 v" + VERSION + " 相关性配置或状态字段；尚未验证，操作已禁用，请安全地完全重启 DSH。";
      return "";
    }
    function sessionIdOf(props) {
      // useTabInfo is a slot-owned React hook, called consistently by the tab wrapper.
      var info = typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
      return props.sessionId || (info && info.tab && info.tab.sessionId) || "";
    }
    function Glyph(props) {
      return h("svg", { width: (props && props.size) || 24, height: (props && props.size) || 24, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, "aria-hidden": true },
        h("path", { d: "M9 3a4 4 0 0 0-4 4v1a4 4 0 0 0-2 7 4 4 0 0 0 6 5h2V5a2 2 0 0 0-2-2Zm6 0a4 4 0 0 1 4 4v1a4 4 0 0 1 2 7 4 4 0 0 1-6 5h-2V5a2 2 0 0 1 2-2Z" }));
    }
    function button(label, onClick, disabled, extra) { return h("button", Object.assign({ type: "button", onClick: onClick, disabled: disabled }, extra), label); }
    function MemoryCard(props) {
      var memory = props.memory;
      var editing = React.useState(false), draft = React.useState(memory.content), deleting = React.useState(false);
      var edit = editing[0], setEdit = editing[1], content = draft[0], setContent = draft[1];
      return h("article", { className: "jiyi-card", "data-memory-id": memory.id },
        h("div", { className: "jiyi-row" }, h("strong", null, memory.type || "记忆"), h("span", { className: "jiyi-badge" }, memory.scope === "global" ? "全局" : "项目 " + (memory.projectName || memory.projectId || "未记录")), h("span", { className: "jiyi-badge" }, memory.status || "未记录"), h("span", { className: "jiyi-muted" }, "v" + (memory.version == null ? "未记录" : memory.version))),
        edit ? h("textarea", { "aria-label": "纠正记忆内容", value: content, onChange: function (event) { setContent(event.target.value); } }) : h("p", { className: "jiyi-content" }, memory.content),
        h("div", { className: "jiyi-muted" }, "创建：" + timestamp(memory.createdAt) + " · 更新：" + timestamp(memory.updatedAt)),
        h("div", { className: "jiyi-muted" }, "提取模型：" + modelText(memory.extractionModel) + " · Embedding：" + modelText(memory.embeddingModel) + " · 向量版本：" + (memory.embeddingVersion == null ? "未记录" : memory.embeddingVersion)),
        (memory.sources || []).map(function (source, index) {
          var manual = source.origin === "manual" || String(source.sessionId || "").startsWith("jiyi-manual:");
          var manualCreate = source.evidence === "manual-create";
          return h("div", { className: "jiyi-source", key: index },
            h("div", { className: "jiyi-muted" }, (manualCreate ? "管理界面手动新建记录" : manual ? "管理界面手动纠正记录" : "来源 " + (source.sessionId || "未记录")) + " · seq " + (source.eventSeq == null ? "未记录" : source.eventSeq) + (source.eventId ? " · " + source.eventId : "") + " · " + timestamp(source.timestamp || source.eventTime)),
            source.quote ? h("div", { className: "jiyi-content" }, source.quote) : null,
            source.sessionId ? h("div", { className: "jiyi-row" }, !manual ? button("打开来源会话", function () { props.openSource(source.sessionId); }, props.busy, { title: "打开官方会话视图；事件序号在上方展示，不承诺精确定位事件" }) : null, source.eventSeq != null ? button("查看来源事件", function () { props.showSource(source); }, props.busy) : null) : null);
        }),
        !memory.sources || !memory.sources.length ? h("div", { className: "jiyi-muted" }, "未记录来源") : null,
        h("div", { className: "jiyi-row" }, edit ? button("保存纠正", async function () { if (await props.mutate("correct", { id: memory.id, content: content, version: memory.version })) setEdit(false); }, props.busy || !content.trim()) : button("纠正", function () { setContent(memory.content); setEdit(true); }, props.busy || memory.status !== "active"),
          edit ? button("取消纠正", function () { setEdit(false); }, props.busy) : null,
          button(deleting[0] ? "确认删除" : "删除", async function () { if (!deleting[0]) deleting[1](true); else await props.mutate("delete", { id: memory.id, version: memory.version }); }, props.busy || memory.status === "deleted", { className: "jiyi-danger" }),
          deleting[0] ? button("取消删除", function () { deleting[1](false); }, props.busy) : null));
    }
    function ProjectAliases(props) {
      var project=props.project, draft=React.useState("");
      return h("article", { className:"jiyi-card", "data-project-id":project.id },
        h("strong",null,project.name || project.id),
        h("div",{className:"jiyi-muted"},project.path || "未记录路径"),
        project.aliasConflict ? h("p",{className:"jiyi-error",role:"alert"},"文件夹别名冲突："+project.aliasConflict+" 已属于其他项目；不会自动合并，召回须用明确路径或另加唯一别名。") : null,
        h("ul",null,(project.aliases || []).map(function(alias){return h("li",{key:alias},h("span",null,alias),alias===project.path ? h("span",{className:"jiyi-muted"},"（规范路径）") : button("删除别名",function(){props.mutate("deleteProjectAlias",{id:project.id,alias:alias});},props.busy,{"aria-label":"删除别名 "+alias}));})),
        h("div",{className:"jiyi-row"},h("input",{"aria-label":project.name+"的新别名",placeholder:"新别名（忽略空格、全半角及大小写）",value:draft[0],disabled:props.busy,onChange:function(event){draft[1](event.target.value);}}),button("添加别名",async function(){if(await props.mutate("addProjectAlias",{id:project.id,alias:draft[0]}))draft[1]("");},props.busy || !draft[0].trim(),{"aria-label":"添加 "+project.name+" 的别名"})));
    }
    function DiagnosticDetails(props) {
      if (!props.value) return null;
      return h("details", { className: "jiyi-diagnostics" }, h("summary", null, "阶段诊断（失败不等于无命中）"), h("pre", null, JSON.stringify(props.value, null, 2)));
    }
    function SettingsEditor(props) {
      var textState = React.useState(function () { return JSON.stringify(props.settings, null, 2); });
      var text = textState[0], setText = textState[1];
      var localError = React.useState("");
      var parsed;
      try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
      function change(path, value) {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { localError[1]("请先修正高级 JSON 设置"); return; }
        var next = JSON.parse(JSON.stringify(parsed));
        if (path.length === 1) next[path[0]] = value;
        else { next[path[0]] = Object.assign({}, next[path[0]]); next[path[0]][path[1]] = value; }
        setText(JSON.stringify(next, null, 2)); localError[1]("");
      }
      function field(label, path, type) {
        var value = path.length === 1 ? parsed && parsed[path[0]] : parsed && parsed[path[0]] && parsed[path[0]][path[1]];
        return h("label", { className: "jiyi-field", key: path.join(".") }, label, h("input", { "aria-label": label, type: type || "text", step: path[1] === "maxCandidates" ? 1 : type === "number" ? "any" : undefined, min: path[1] === "maxCandidates" ? 1 : undefined, max: path[1] === "maxCandidates" ? 20 : undefined, value: value == null ? "" : value, disabled: props.busy, onChange: function (event) { change(path, type === "number" ? Number(event.target.value) : event.target.value); } }));
      }
      return h("details", null, h("summary", null, "设置与真实验证"),
        h("p", { className: "jiyi-muted" }, "保存配置不等于验证。三个验证按钮分别执行真实提取、真实 embedding 与真实相关性判别；验证使用已保存设置。凭据仅由 Host 管理。"),
        h("p", { className: "jiyi-muted" }, "后台独立 LLM 相关性判别会调用已配置的账号，不是主会话模型工具调用。未配置判别或判别失败时，不退回向量分数注入记忆。"),
        h("p", { className: "jiyi-muted" }, "向量阈值 0.2 仅用于扩展候选，不是注入门槛；只有通过相关性判别的原始事实才可入选，仍受最大召回条数和输出预算限制。界面不会自动修改或保存当前阈值、配置或启用状态。"),
        h("label", { className: "jiyi-row" }, h("input", { type: "checkbox", checked: !!(parsed && parsed.enabled), disabled: props.busy, onChange: function (event) { change(["enabled"], event.target.checked); } }), "启用自动记忆（关闭此面板不会关闭 Host）"),
        h("div", { className: "jiyi-fields" }, field("提取提供方", ["extraction", "provider"]), field("提取模型", ["extraction", "model"]), field("提取超时（ms）", ["extraction", "timeoutMs"], "number"), field("Embedding 后端", ["embedding", "backend"]), field("Embedding 模型", ["embedding", "model"]), field("相关性提供方", ["relevance", "provider"]), field("相关性模型", ["relevance", "model"]), field("相关性超时（ms）", ["relevance", "timeoutMs"], "number"), field("召回超时（ms）", ["retrieval", "timeoutMs"], "number"), field("候选上限（1–20）", ["retrieval", "maxCandidates"], "number"), field("最大召回条数", ["retrieval", "maxMemories"], "number"), field("最大召回字符数", ["retrieval", "maxChars"], "number"), field("向量候选阈值", ["retrieval", "semanticThreshold"], "number"), field("状态记忆降序时长（小时）", ["retrieval", "statusStaleHours"], "number"), field("队列最大尝试次数", ["queue", "maxAttempts"], "number")),
        h("label", { className: "jiyi-field" }, "高级设置 JSON", h("textarea", { "aria-label": "高级设置 JSON", value: text, onChange: function (event) { setText(event.target.value); localError[1](""); }, spellCheck: false, disabled: props.busy })),
        localError[0] ? h("p", { role: "alert", className: "jiyi-error" }, localError[0]) : null,
        h("div", { className: "jiyi-row", style: { marginTop: 10 } }, button("保存设置", async function () {
          try { var settings = JSON.parse(text); if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("设置必须为 JSON 对象"); var saved = await props.mutate("settings", { settings: settings }); if (saved) { localError[1](""); if (saved.settings) setText(JSON.stringify(saved.settings, null, 2)); } } catch (error) { localError[1](errorText(error)); }
        }, props.busy), button("真实验证提取", function () { props.mutate("verifyExtraction", {}); }, props.busy), button("真实验证 Embedding", function () { props.mutate("verifyEmbedding", {}); }, props.busy), button("真实验证相关性", function () { props.mutate("verifyRelevance", {}); }, props.busy)),
        h("p", { className: "jiyi-muted" }, "提取状态：" + modelText(props.models.extraction)), h("p", { className: "jiyi-muted" }, "Embedding 状态：" + modelText(props.models.embedding)), h("p", { className: props.models.relevance && props.models.relevance.error ? "jiyi-error" : "jiyi-muted", "aria-label": "相关性状态" }, "相关性状态：" + (props.models.relevance ? modelText(props.models.relevance) : "Host 未提供（未验证）")));
    }
    function MemoryApp(props) {
      var state = React.useState(null), data = state[0], setData = state[1];
      var errorState = React.useState(""), error = errorState[0], setError = errorState[1];
      var loadErrorState = React.useState(""), loadError = loadErrorState[0], setLoadError = loadErrorState[1];
      var sourceState = React.useState(null), sourceRead = sourceState[0], setSourceRead = sourceState[1];
      var noticeState = React.useState(""), notice = noticeState[0], setNotice = noticeState[1];
      var busyState = React.useState(""), busy = busyState[0], setBusy = busyState[1];
      var queryState = React.useState(""), query = queryState[0], setQuery = queryState[1];
      var scopeState = React.useState("all"), scope = scopeState[0], setScope = scopeState[1];
      var statusState = React.useState("active"), status = statusState[0], setStatus = statusState[1];
      var searchState = React.useState(null), search = searchState[0], setSearch = searchState[1];
      var newContentState = React.useState(""), newContent = newContentState[0], setNewContent = newContentState[1];
      var newScopeState = React.useState("global"), newScope = newScopeState[0], setNewScope = newScopeState[1];
      var newProjectState = React.useState(""), newProject = newProjectState[0], setNewProject = newProjectState[1];
      var failedState = React.useState(null), failed = failedState[0], setFailed = failedState[1];
      var root = React.useRef(null);
      var compatibilityError = compatibilityProblem(data);
      var actionsDisabled = !!busy || !!compatibilityError;
      var currentData = React.useRef(null);
      var live = React.useRef(false), requests = React.useRef(new Set()), searching = React.useRef(0), mutation = React.useRef(false), loading = React.useRef(false), loadSerial = React.useRef(0), sourceSerial = React.useRef(0);
      async function load(force) {
        if (loading.current && force !== true) return;
        loading.current = true;
        var serial = ++loadSerial.current;
        var controller = new AbortController(); requests.current.add(controller);
        try {
          var next = await request("state", null, controller.signal, { sessionId: props.sessionId });
          if (!Array.isArray(next.memories) || !Array.isArray(next.queue) || !Array.isArray(next.retrievals) || !next.settings || !next.models) throw new Error("Host state 数据结构不完整");
          if (live.current && serial === loadSerial.current) { currentData.current = next; setData(next); setLoadError(""); }
          return true;
        } catch (reason) { if (live.current && !controller.signal.aborted && serial === loadSerial.current) setLoadError("加载失败：" + errorText(reason)); return false; }
        finally { requests.current.delete(controller); if (serial === loadSerial.current) loading.current = false; }
      }
      React.useEffect(function () {
        live.current = true;
        var wasVisible = false;
        function isVisible() {
          return !document.hidden && !!root.current && root.current.getClientRects().length > 0 && window.getComputedStyle(root.current).visibility === "visible";
        }
        function pollVisible() {
          var visible = isVisible();
          if (visible) load();
          wasVisible = visible;
        }
        function visibilityChanged() {
          var visible = isVisible();
          if (visible && !wasVisible) load(true);
          wasVisible = visible;
        }
        pollVisible();
        var timer = setInterval(pollVisible, 7000);
        document.addEventListener("visibilitychange", visibilityChanged);
        var observer = typeof IntersectionObserver === "function" ? new IntersectionObserver(visibilityChanged) : null;
        if (observer && root.current) observer.observe(root.current);
        return function () { live.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", visibilityChanged); if (observer) observer.disconnect(); requests.current.forEach(function (controller) { controller.abort(); }); requests.current.clear(); };
      }, [props.sessionId]);
      function resetSearch(setter, value) { searching.current++; setSearch(null); setter(value); }
      async function loadFailed(offset) {
        setBusy("failedQueue"); setError("");
        var controller = new AbortController(); requests.current.add(controller);
        try {
          var result = await request("failedQueue", null, controller.signal, { offset: offset });
          if (!Array.isArray(result.queue) || !Number.isSafeInteger(result.total) || result.total < 0 || result.offset !== offset) throw new Error("Host failedQueue 数据结构不完整");
          if (live.current) setFailed(result);
        } catch (reason) { if (live.current && !controller.signal.aborted) { setFailed(null); setError("加载历史失败队列失败：" + errorText(reason)); } }
        finally { requests.current.delete(controller); if (live.current) setBusy(function (current) { return current === "failedQueue" ? "" : current; }); }
      }
      async function runSearch(event) {
        event.preventDefault();
        var incompatible = compatibilityProblem(currentData.current);
        if (incompatible) { setError(incompatible); return; }
        var serial = ++searching.current;
        setBusy("search"); setError("");
        var controller = new AbortController(); requests.current.add(controller);
        try {
          var result = await request("search", null, controller.signal, { sessionId: props.sessionId, query: query, scope: scope });
          if (!Array.isArray(result.memories) || !["hit", "no-hit", "not-configured", "error", "timeout", "disabled", "skipped", "ambiguous", "cancelled"].includes(result.status)) throw new Error("Host search 数据结构不完整");
          if (live.current && serial === searching.current) setSearch(result);
        } catch (reason) { if (live.current && !controller.signal.aborted && serial === searching.current) setError("搜索失败：" + errorText(reason)); }
        finally { requests.current.delete(controller); if (live.current) setBusy(function (current) { return current === "search" ? "" : current; }); }
      }
      async function mutate(op, body) {
        var incompatible = compatibilityProblem(currentData.current);
        if (incompatible) { setError(incompatible); return false; }
        if (mutation.current) return false;
        mutation.current = true; setBusy(op); setError(""); setNotice("");
        try {
          var result = await request(op, body);
          if (op === "createMemory" && (!result.memory || typeof result.memory.content !== "string" || !result.memory.id)) throw new Error("Host 未返回已保存的记忆内容");
          if (op === "verifyExtraction" || op === "verifyEmbedding" || op === "verifyRelevance") {
            var verification = result.result;
            if (!verification || verification.status !== "ready" || verification.ok === false || verification.ready === false) throw new Error(errorText((verification && verification.error) || result.error || "Host 未返回真实验证成功状态"));
          }
          if (live.current) {
            setNotice(op === "verifyExtraction" ? "真实提取验证成功：\n" + JSON.stringify(result, null, 2) : op === "verifyEmbedding" ? "真实 Embedding 验证成功：\n" + JSON.stringify(result, null, 2) : op === "verifyRelevance" ? "真实相关性验证成功：\n" + JSON.stringify(result, null, 2) : op === "createMemory" ? "记忆已保存：\n" + result.memory.content : op === "settings" ? "设置已保存；尚未因此验证模型" : op === "retry" ? "已请求重试；结果以队列状态为准" : op === "delete" ? "记忆已删除" : op === "addProjectAlias" ? "项目别名已添加" : op === "deleteProjectAlias" ? "项目别名已删除" : "记忆已纠正");
            searching.current++; setSearch(null); await load(true);
          }
          return result;
        } catch (reason) { if (live.current) setError("操作失败：" + errorText(reason)); return false; }
        finally { mutation.current = false; if (live.current) setBusy(""); }
      }
      function openSource(sessionId) {
        try { props.openSource(sessionId); } catch (reason) { setError("打开来源会话失败：" + errorText(reason)); }
      }
      async function showSource(source) {
        var incompatible = compatibilityProblem(currentData.current);
        if (incompatible) { setError(incompatible); return; }
        var serial = ++sourceSerial.current;
        var controller = new AbortController(); requests.current.add(controller);
        setSourceRead({ source: source, pending: true });
        try {
          var result = await request("source", { sessionId: source.sessionId, eventSeq: source.eventSeq }, controller.signal);
          if (!result.source || result.source.event == null) throw new Error("Host 未返回来源事件");
          if (live.current && serial === sourceSerial.current) setSourceRead({ source: result.source });
        } catch (reason) { if (live.current && !controller.signal.aborted && serial === sourceSerial.current) setSourceRead({ source: source, error: errorText(reason) }); }
        finally { requests.current.delete(controller); }
      }
      var memories = (search ? search.memories : data ? data.memories : []).filter(function (memory) {
        return (scope === "all" || (scope === "global" ? memory.scope === "global" : memory.projectId === scope)) && (!status || memory.status === status) && (search || !query.trim() || (memory.content || "").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
      });
      var retrievals = data ? data.retrievals.filter(function (record) { return record.sessionId === props.sessionId; }) : [];
      return h("section", { ref: root, className: "jiyi-root", "aria-label": "记忆管理", "data-jiyi-version": VERSION },
        h("div", { className: "jiyi-row" }, h("h2", { className: "jiyi-heading" }, "记忆"), h("span", { className: "jiyi-muted" }, "Client v" + VERSION + (data ? " / Host v" + data.version : "")), h("span", { className: "jiyi-spacer" }), button("刷新", load, !!busy)),
        h("div", { className: "jiyi-muted" }, "启用时 Host 独立运行；关闭面板不停止提取与召回。"),
        error ? h("div", { className: "jiyi-error jiyi-notice", role: "alert" }, error) : null,
        loadError ? h("div", { className: "jiyi-error jiyi-notice", role: "alert" }, loadError) : null,
        data && compatibilityError ? h("div", { className: "jiyi-error jiyi-notice", role: "alert" }, compatibilityError) : null,
        data && data.settingsError ? h("div", { className: "jiyi-error jiyi-notice", role: "alert" }, "设置文件错误：" + data.settingsError) : null,
        data && data.failure ? h("div", { className: "jiyi-error jiyi-notice", role: "alert" }, "Host 后台失败：" + modelText(data.failure)) : null,
        data && data.evaluation && data.evaluation.active ? h("div",{className:"jiyi-notice",role:"status"},"隔离评测进行中：正式召回和管理照常可用，存记忆的抽取任务排队，评测结束后自动处理。") : null,
        data && !data.settings.enabled ? h("div", { className: "jiyi-notice", role: "status" }, "自动记忆已停用；现有记忆仍可查看，启用请进入设置。") : null,
        notice ? h("div", { className: "jiyi-notice", role: "status" }, notice) : null,
        sourceRead ? h("aside", { className: "jiyi-card", "aria-label": "来源事件" }, h("div", { className: "jiyi-row" }, h("strong", null, "来源事件 · seq " + sourceRead.source.eventSeq), button("关闭来源事件", function () { sourceSerial.current++; setSourceRead(null); })), h("div", { className: "jiyi-muted" }, sourceRead.source.sessionId), sourceRead.pending ? h("p", { role: "status" }, "正在读取引用的原始事件…") : sourceRead.error ? h("p", { role: "alert", className: "jiyi-error" }, sourceRead.error) : h("pre", null, JSON.stringify(sourceRead.source.event, null, 2))) : null,
        !data ? h("p", { role: "status" }, loadError ? "未加载记忆数据" : "正在加载…") : null,
        h("details", null, h("summary", null, "新建记忆"),
          h("label", { className: "jiyi-field" }, "记忆内容", h("textarea", { "aria-label": "新建记忆内容", value: newContent, disabled: actionsDisabled, maxLength: 1500, onChange: function (event) { setNewContent(event.target.value); } })),
          h("div", { className: "jiyi-row" }, h("label", null, "范围 ", h("select", { "aria-label": "新建记忆范围", value: newScope, disabled: actionsDisabled, onChange: function (event) { setNewScope(event.target.value); } }, h("option", { value: "global" }, "全局"), h("option", { value: "project" }, "项目"))),
            newScope === "project" ? h("select", { "aria-label": "新建记忆项目", value: newProject, disabled: actionsDisabled, onChange: function (event) { setNewProject(event.target.value); } }, h("option", { value: "" }, "选择项目"), ((data && data.projects) || []).map(function (project) { return h("option", { key: project.id, value: project.id }, project.name || project.path || project.id); })) : null,
            button("保存新记忆", async function () { if (!newContent.trim() || (newScope === "project" && !newProject)) return; var saved = await mutate("createMemory", { content: newContent, scope: newScope, projectId: newScope === "project" ? newProject : null }); if (saved) setNewContent(""); }, actionsDisabled || !newContent.trim() || (newScope === "project" && !newProject)))),
        h("form", { className: "jiyi-search", onSubmit: runSearch },
          h("input", { "aria-label": "搜索记忆", placeholder: "搜索内容；回车执行 Host 语义检索", value: query, onChange: function (event) { resetSearch(setQuery, event.target.value); } }),
          h("div", { className: "jiyi-row" }, h("select", { "aria-label": "记忆范围", value: scope, onChange: function (event) { resetSearch(setScope, event.target.value); } }, h("option", { value: "all" }, "全部范围"), h("option", { value: "global" }, "全局"), ((data && data.projects) || []).map(function (project) { var id = typeof project === "string" ? project : project.id; return h("option", { key: id, value: id }, typeof project === "string" ? project : project.name || project.path || id); })),
            h("select", { "aria-label": "记忆状态", value: status, onChange: function (event) { resetSearch(setStatus, event.target.value); } }, h("option", { value: "active" }, "有效"), h("option", { value: "" }, "全部状态"), h("option", { value: "deleted" }, "已删除"), h("option", { value: "superseded" }, "已替代")),
            h("button", { type: "submit", disabled: actionsDisabled }, busy === "search" ? "检索中…" : "检索"), search ? button("返回列表", function () { searching.current++; setSearch(null); }, !!busy) : null)),
        search ? h("div", { className: ["error", "timeout", "not-configured", "disabled", "cancelled"].includes(search.status) ? "jiyi-error" : "jiyi-muted", role: "status" }, "检索状态：" + search.status + (search.error ? " · " + errorText(search.error) : ""), search.ambiguities && search.ambiguities.length ? h("pre", null, "歧义：" + JSON.stringify(search.ambiguities, null, 2)) : null) : null,
        search ? h(DiagnosticDetails, { value: search.diagnostics }) : null,
        data ? h("div", { className: "jiyi-muted" }, "显示 " + memories.length + " 条" + (search ? "（Host 检索）" : "（列表内容过滤）")) : null,
        data && !memories.length ? h("p", null, search && ["error", "timeout", "not-configured", "disabled", "cancelled"].includes(search.status) ? "本次检索未能完成，请查看上方状态。" : "没有匹配的记忆") : null,
        memories.map(function (memory) { return h(MemoryCard, { key: memory.id + ":" + memory.version, memory: memory, mutate: mutate, openSource: openSource, showSource: showSource, busy: actionsDisabled }); }),
        data ? h("details", null, h("summary", null, "提取队列 · " + data.queue.length), button("查看历史失败项", function () { loadFailed(0); }, actionsDisabled), failed ? h("div", null, h("p", { className: "jiyi-muted" }, "历史失败项 " + failed.total + " 条 · 当前显示 " + failed.queue.length + " 条"), !failed.queue.length ? h("p", { className: "jiyi-muted" }, "此页没有失败项") : failed.queue.map(function (item) { return h("div", { className: "jiyi-card", key: item.id }, h("div", null, item.status + " · 尝试 " + item.attempts + " 次"), h("div", { className: "jiyi-muted" }, item.sessionId + " · seq " + item.eventSeq + " · " + timestamp(item.updatedAt)), h("div", { className: "jiyi-error" }, "失败分类：" + queueErrorCategory(item.error), h("pre", null, typeof item.error === "string" ? item.error : JSON.stringify(item.error, null, 2)))); }), h("div", { className: "jiyi-row" }, button("上一页失败项", function () { loadFailed(Math.max(0, failed.offset - 100)); }, actionsDisabled || failed.offset === 0), button("下一页失败项", function () { loadFailed(failed.offset + 100); }, actionsDisabled || failed.offset + failed.queue.length >= failed.total))) : null, !data.queue.length ? h("p", { className: "jiyi-muted" }, "队列暂无记录") : data.queue.map(function (item) { return h("div", { className: "jiyi-card", key: item.id }, h("div", null, item.status + " · 尝试 " + item.attempts + " 次"), h("div", { className: "jiyi-muted" }, item.sessionId + " · seq " + item.eventSeq + " · " + timestamp(item.updatedAt)), item.error ? h("div", { className: "jiyi-error" }, "失败分类：" + queueErrorCategory(item.error), h("pre", null, typeof item.error === "string" ? item.error : JSON.stringify(item.error, null, 2))) : null, ["error", "failed", "timeout"].includes(item.status) ? button("重试提取", function () { mutate("retry", { id: item.id }); }, actionsDisabled) : null); })) : null,
        data ? h("details", null, h("summary", null, "本会话 / 本轮自动检索记录 · " + retrievals.length), !retrievals.length ? h("p", { className: "jiyi-muted" }, "本会话暂无自动检索记录") : retrievals.map(function (record, index) { return h("div", { className: "jiyi-card", key: record.messageId || index }, h("div", null, record.status + " · " + timestamp(record.createdAt)), h("div", { className: "jiyi-muted" }, "本轮消息：" + (record.messageId || "未记录")), h("p", { className: "jiyi-content" }, record.query), h("div", { className: "jiyi-muted" }, "命中记忆：" + ((record.memoryIds || []).join(", ") || "无")), record.error ? h("div", { className: "jiyi-error" }, errorText(record.error)) : null, h(DiagnosticDetails, { value: record.details && record.details.diagnostics })); })) : null,
        data ? h("details",null,h("summary",null,"项目别名 · "+((data.projects || []).length)),h("p",{className:"jiyi-muted"},"项目首次识别时登记文件夹名；匹配忽略空格、全半角与大小写。现有别名可增删，规范路径保留。"),(data.projects || []).map(function(project){return h(ProjectAliases,{key:project.id,project:project,busy:actionsDisabled,mutate:mutate});})) : null,
        data ? h(SettingsEditor, { key: data.version + ":" + (compatibilityError ? "incompatible" : "compatible"), settings: data.settings, models: data.models, busy: actionsDisabled, mutate: mutate }) : null);
    }
    function apply(ctx) {
      ensureStyle();
      function MemoryTab(props) {
        var sessionId = sessionIdOf(props);
        return h(MemoryApp, { key: sessionId, sessionId: sessionId, openSource: function (id) { ctx.uiWorkspace.openSession(id); } });
      }
      ctx.effect(function () { return ctx.sidebarRightTabs.register({ id: "jiyi", kind: "jiyi", priority: "extension", title: function () { return "记忆"; }, guide: [{ id: "open", order: 24, title: function () { return "记忆"; }, description: function () { return "查看、搜索与纠正自动记忆"; }, icon: Glyph }] }); }, "jiyi.type");
      ctx.effect(function () { return ctx.slots.inject("sidebar.right.pane.tab", function () { return ctx.slots.register({ name: "sidebar.right.pane.tab", key: "jiyi" }, MemoryTab); }); }, "jiyi.body");
      ctx.effect(function () { return ctx.slots.inject("sidebar.right.pane.tab.title", function () { return ctx.slots.register({ name: "sidebar.right.pane.tab.title", key: "jiyi" }, function () { return h("span", null, "记忆"); }); }); }, "jiyi.title");
    }
    return { inject: inject, apply: apply };
  }
});
