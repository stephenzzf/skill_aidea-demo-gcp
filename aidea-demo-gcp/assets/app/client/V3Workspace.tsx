import { chatActionUnknownKey } from "./ChatBusinessModel.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconChartBar } from "@tabler/icons-react";
import type { ActionResult, ActionTransition, DataRow, WorkspaceState } from "../shared/workspace.ts";
import { ChatActionError, ChatBusinessContextProvider } from "./ChatBusinessCards.tsx";
import { isPlannedDomain } from "../shared/solution.ts";
import { DomainNavigation } from "./DomainNavigation.tsx";
import { SolutionOverview } from "./SolutionOverview.tsx";
import { api, INITIAL_STATE, safeSavedState, storeState, V3_UI_PREFIX, WorkspaceContent } from "./Workspace.tsx";
import type { DomainRoute, WorkspacePayload, WorkspaceProps } from "./Workspace.tsx";
import { SplitWorkspace } from "./SplitWorkspace.tsx";
import type { DemoExtensionDomainRenderer } from "./extension-contract.ts";

const V3_STATE_PREFIX = "me-demo-workspace:v3:";

function routeFromHash(defaultPageId = "chat"): DomainRoute {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const pageId = params.get("tab");
  if (!pageId) return { pageId: defaultPageId };
  if (pageId === "solution" || pageId === "chat") return { pageId };
  const dataset = params.get("dataset") ?? undefined;
  const recordId = params.get("record") ?? undefined;
  return { pageId, ...(dataset ? { dataset } : {}), ...(recordId && dataset ? { recordId } : {}) };
}

function routeHash(route: DomainRoute) {
  const params = new URLSearchParams();
  params.set("tab", route.pageId);
  if (route.dataset) params.set("dataset", route.dataset);
  if (route.dataset && route.recordId) params.set("record", route.recordId);
  return `#${params.toString()}`;
}

export function V3Workspace({ config, resetKey, onContext, overviewChat, renderDomain, splitLayout, chatScopeLabel, chatScopeSummary, onDomainChange }: WorkspaceProps & { renderDomain?: DemoExtensionDomainRenderer }) {
  const solution = config.solution;
  const pages = solution?.pages ?? [];
  const chatEnabled = pages.some(page => page.components.includes("assistant") && !isPlannedDomain(page, solution?.design?.coverage ?? []));
  const splitEnabled = Boolean(splitLayout && chatEnabled);
  const defaultPageId = chatEnabled && !splitEnabled ? "chat" : "solution";
  const contentScroll = useRef<HTMLDivElement>(null);
  const [payload, setPayload] = useState<WorkspacePayload | null>(null);
  const [state, setState] = useState<WorkspaceState>(INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const actionPending = useRef(false);
  const unknownActions = useRef(new Set<string>());
  const actionEpoch = useRef(0);
  useEffect(() => () => { actionEpoch.current += 1; }, []);
  const [route, setRoute] = useState<DomainRoute>(() => routeFromHash(defaultPageId));
  const routeRef = useRef(route);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [storageWarning, setStorageWarningFlag] = useState(false);
  const stateKey = `${V3_STATE_PREFIX}${config.id}:${config.mode}`;
  const lastReset = useRef(resetKey);
  const page = route.pageId === "solution" ? undefined : pages.find((item) => item.id === route.pageId);

  const navigate = useCallback((next: DomainRoute, replace = false) => {
    if (splitEnabled && next.pageId === "chat") {
      splitLayout?.update(splitLayout.narrow ? { mobileView: "chat" } : { collapsed: false });
      next = { pageId: "solution" };
    }
    const normalized = next.pageId === "solution" || next.pageId === "chat"
      ? { pageId: next.pageId }
      : { pageId: next.pageId, ...(next.dataset ? { dataset: next.dataset } : {}), ...(next.dataset && next.recordId ? { recordId: next.recordId } : {}) };
    if (splitEnabled) onDomainChange?.(normalized.pageId);
    if (normalized.pageId !== routeRef.current.pageId) onContext(splitEnabled ? { domainId: "solution", query: {}, state: stateRef.current } : undefined);
    routeRef.current = normalized;
    const hash = routeHash(normalized);
    if (replace) window.history.replaceState(null, "", hash);
    else if (window.location.hash !== hash) window.history.pushState(null, "", hash);
    setRoute(normalized);
  }, [onContext, splitEnabled, splitLayout?.narrow, splitLayout?.update, onDomainChange]);

  useEffect(() => {
    if (splitEnabled) onDomainChange?.(route.pageId === "chat" ? "solution" : route.pageId);
  }, [splitEnabled, route.pageId, onDomainChange]);

  const extensionDomain = page && !isPlannedDomain(page, solution?.design?.coverage ?? [])
    ? renderDomain?.({ page, navigate }) : undefined;
  const contextualDomain = Boolean(page?.components.includes("assistant") && !isPlannedDomain(page, solution?.design?.coverage ?? []) && extensionDomain === undefined);
  const publishDomainContext = useCallback((context: import("../shared/contracts.ts").WorkspaceChatContext | undefined) => {
    if (!splitEnabled) { onContext(context); return; }
    if (context?.domainId !== routeRef.current.pageId || !contextualDomain) return;
    onContext(context);
  }, [onContext, splitEnabled, contextualDomain]);

  const executeChatAction = useCallback(async ({ pageId, datasetId, record, transition, snapshotRevision, fields }: {
    pageId: string; datasetId: string; record: DataRow; transition: ActionTransition; snapshotRevision: number;
    fields: Record<string, string | number | boolean>;
  }) => {
    const current = stateRef.current;
    const definition = payload?.definition;
    const workflow = definition?.workflow;
    const dataset = definition?.datasets.find(item => item.id === datasetId);
    const domain = pages.find(item => item.id === pageId);
    const recordId = dataset ? String(record[dataset.key]) : "";
    const unknownKey = chatActionUnknownKey(config, datasetId, recordId);
    let unresolved = unknownActions.current.has(unknownKey);
    try { unresolved ||= sessionStorage.getItem(unknownKey) === "1"; } catch { /* In-memory protection remains. */ }
    if (unresolved) throw new ChatActionError("此记录有结果未知的操作，请重新体验后再演示。未重复提交。", "unknown");
    if (actionPending.current) throw new ChatActionError("另一项演示操作正在处理中，请稍后再试。", "rejected");
    if (!workflow || workflow.dataset !== datasetId || !dataset || !domain || !domain.datasets.includes(datasetId) ||
      !domain.actions.includes(transition.id) || !domain.components.includes("workflow")) {
      throw new ChatActionError("此操作未在当前方案中启用。", "rejected");
    }
    if (current.revision !== snapshotRevision) throw new ChatActionError("记录版本已变化，请重新查询后再确认。", "rejected");
    const status = record[workflow.statusField];
    if (typeof status !== "string" || !transition.from.includes(status) ||
      (transition.requireFresh && record[workflow.staleField ?? "__stale"] === true)) {
      throw new ChatActionError("记录状态已变化，当前操作不可用。请重新查询。", "rejected");
    }
    actionPending.current = true;
    const requestId = crypto.randomUUID();
    const epoch = actionEpoch.current;
    try {
      let httpResponse: Response;
      try {
        httpResponse = await fetch("/api/actions", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({
        state: current, expectedRevision: current.revision, requestId, recordId,
        actionId: transition.id, role: transition.role, domainId: pageId,
        ...(Object.keys(fields).length ? { input: fields } : {}),
        }) });
      } catch {
        throw new ChatActionError("提交结果未知。本次结果无法从服务端恢复，请重新体验后再演示；为避免重复操作，当前卡片已锁定。", "unknown");
      }
      if (!httpResponse.ok) {
        let message = `操作未通过校验（${httpResponse.status}），演示状态未更新。`;
        try {
          const body: unknown = await httpResponse.json();
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") message = body.error;
        } catch { /* Keep a bounded status message. */ }
        throw new ChatActionError(message, "rejected");
      }
      let response: ActionResult;
      try { response = await httpResponse.json() as ActionResult; }
      catch { throw new ChatActionError("服务器已响应但回执无法读取。本次结果无法从服务端恢复，请重新体验后再演示；当前卡片已锁定。", "unknown"); }
      const receipt = response.receipt;
      if (!response.state || response.state.revision !== current.revision + 1 || !Array.isArray(response.state.events) ||
        !receipt?.simulated || receipt.requestId !== requestId || receipt.recordId !== recordId ||
        receipt.actionId !== transition.id || receipt.from !== status || receipt.to !== transition.to ||
        receipt.label !== transition.label || receipt.revision !== response.state.revision || response.state.events.length !== response.state.revision ||
        response.state.events.at(-1)?.requestId !== requestId || response.state.events.at(-1)?.recordId !== recordId ||
        response.state.events.at(-1)?.actionId !== transition.id) {
        throw new ChatActionError("服务器返回的处理回执与本次请求不匹配。本次结果无法从服务端恢复，请重新体验后再演示；当前卡片已锁定。", "unknown");
      }
      if (epoch !== actionEpoch.current) throw new ChatActionError("本次体验已重置，旧操作结果未应用。", "rejected");
      stateRef.current = response.state;
      setState(response.state);
      return receipt;
    } catch (cause) {
      if (epoch === actionEpoch.current && cause instanceof ChatActionError && cause.outcome === "unknown") {
        unknownActions.current.add(unknownKey);
        try { sessionStorage.setItem(unknownKey, "1"); } catch { /* Keep the in-memory lock. */ }
      }
      throw cause;
    } finally {
      actionPending.current = false;
    }
  }, [payload?.definition, pages, config]);

  const chatBusinessContext = useMemo(() => payload ? ({
    config, definition: payload.definition, state,
    navigate: (pageId: string, dataset?: string, recordId?: string) => navigate({ pageId, ...(dataset ? { dataset } : {}), ...(recordId && dataset ? { recordId } : {}) }),
    executeAction: executeChatAction,
  }) : null, [config, payload, state, navigate, executeChatAction]);

  useEffect(() => {
    const update = () => {
      const next = routeFromHash(defaultPageId);
      if (splitEnabled && next.pageId === "chat") { navigate(next, true); return; }
      if (splitEnabled) onDomainChange?.(next.pageId);
      if (next.pageId !== routeRef.current.pageId) onContext(splitEnabled ? { domainId: "solution", query: {}, state: stateRef.current } : undefined);
      routeRef.current = next;
      setRoute(next);
    };
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    if (splitEnabled && routeFromHash(defaultPageId).pageId === "chat") navigate({ pageId: "chat" }, true);
    if (!window.location.hash || !new URLSearchParams(window.location.hash.slice(1)).has("tab")) {
      window.history.replaceState(null, "", routeHash({ pageId: defaultPageId }));
      setRoute({ pageId: defaultPageId });
    }
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, [onContext, defaultPageId, splitEnabled, navigate, onDomainChange]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    api<WorkspacePayload>("/api/workspace", { signal: controller.signal }).then((value) => {
      if (!active) return;
      const saved = safeSavedState(stateKey);
      setPayload(value);
      setState(saved.state ?? value.state);
      setStorageWarningFlag(!saved.available);
      setError(saved.state && saved.state.revision !== value.state.revision ? "已从此标签页恢复本地模拟进度。" : "");
      setLoading(false);
    }).catch((cause: unknown) => {
      if (!active || controller.signal.aborted) return;
      setError(cause instanceof Error ? cause.message : "业务工作区暂时无法加载。");
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [config.id, config.mode, stateKey]);

  useEffect(() => { if (payload) setStorageWarningFlag(!storeState(stateKey, state)); }, [payload, state, stateKey]);

  useEffect(() => {
    if (!payload || !solution) return;
    const validPage = route.pageId === "solution" || (route.pageId === "chat" && chatEnabled) || pages.some((item) => item.id === route.pageId);
    if (!validPage) {
      navigate({ pageId: defaultPageId }, true);
      return;
    }
    if (route.dataset && page && !page.datasets.includes(route.dataset)) {
      navigate({ pageId: page.id }, true);
      return;
    }
    if (route.dataset && !payload.definition.datasets.some((item) => item.id === route.dataset)) {
      navigate({ pageId: page?.id ?? "solution" }, true);
    }
  }, [payload, solution, pages, route, page, navigate, chatEnabled, defaultPageId]);

  useEffect(() => {
    const isReset = lastReset.current !== resetKey;
    if (!isReset) return;
    lastReset.current = resetKey;
    actionEpoch.current += 1;
    unknownActions.current.clear();
    setError("");
    try {
      sessionStorage.removeItem(stateKey);
      for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
        const key = sessionStorage.key(index);
        if (key?.startsWith(`${V3_UI_PREFIX}${config.id}:${config.mode}:`) || key?.startsWith(`me-demo-chat-action-unknown:${config.id}:`)) sessionStorage.removeItem(key);
      }
    } catch { setStorageWarningFlag(true); }
    if (payload) setState({ ...payload.state, events: [...payload.state.events] });
    navigate({ pageId: defaultPageId });
  }, [resetKey, stateKey, config.id, config.mode, payload, navigate, defaultPageId]);

  useEffect(() => {
    if (payload && (route.pageId === "chat" || (splitEnabled && !contextualDomain))) {
      const extensionAssistant = page?.components.includes("assistant") && extensionDomain !== undefined && !isPlannedDomain(page, solution?.design?.coverage ?? []);
      onContext({ domainId: extensionAssistant && page ? page.id : "solution", query: {}, state });
    }
  }, [payload, route.pageId, state, onContext, splitEnabled, contextualDomain]);

  useEffect(() => { if (contentScroll.current) contentScroll.current.scrollTop = 0; }, [route.pageId]);

  if (loading && !payload) return <div className="me-workspace mw-frame"><div className="mw-empty">正在载入已确认方案…</div></div>;
  if (!payload || !solution?.design || !solution.blueprint) return <div className="me-workspace mw-frame"><div className="mw-empty" role="alert">{error || "V3 方案配置不完整，无法显示演示内容。"}</div></div>;

  const activePage = page && pages.some((item) => item.id === page.id) ? page : undefined;
  const activeTabId = activePage?.id ?? (route.pageId === "chat" && chatEnabled ? "chat" : "solution");
  const tabs = [...(chatEnabled && !splitEnabled ? [{ id: "chat", title: "AI 智能对话" }] : []), { id: "solution", title: "方案总览" }, ...pages.map((item) => ({ id: item.id, title: item.title }))];
  const workspace = (
    <section className={`me-workspace mw-frame v3-workspace${route.pageId === "chat" ? " chat-ui-active" : ""}`} aria-label={`${config.customer}完整方案演示`}>
      <div className="mw-panel">
        <div className="v3-fixed-heading">
        <div className="mw-topline">
          <div className="mw-title-row"><span className="mw-mark"><IconChartBar size={18} /></span>
            <div><h1>{config.customer}完整方案</h1><p>{solution.goal} · 方案确认后生成的交互演示</p></div>
          </div>
          <span className="mw-demo-label">演示数据 · 本地模拟处理</span>
        </div>
        <DomainNavigation activeId={activeTabId} tabs={tabs} onSelect={(id) => navigate({ pageId: id })} />
        </div>
        <div className="v3-content-scroll" ref={contentScroll}>
        {storageWarning && <div className="mw-access-hint v3-storage-warning" role="status">此浏览器暂时无法保存演示状态；刷新页面后进度可能丢失。</div>}
        {error && <div className="mw-access-hint v3-storage-warning" role="status">{error}</div>}
        <div id="domain-panel" role="tabpanel" aria-labelledby={`domain-tab-${activeTabId}`} className={`v3-domain-panel${route.pageId === "chat" ? " v3-chat-panel" : ""}`}>
          {route.pageId === "chat" ? <div className="v3-overview-chat v3-chat-content">{overviewChat && chatBusinessContext
            ? <ChatBusinessContextProvider value={chatBusinessContext}>{overviewChat}</ChatBusinessContextProvider>
            : overviewChat ?? <div role="status">正在准备 AI 对话…</div>}</div> : activePage ? isPlannedDomain(activePage, solution.design.coverage)
            ? <section className="mw-content v3-domain-content v3-planned-domain" aria-label={`${activePage.title}后续接入说明`}>
              <header className="v3-domain-heading"><span>后续接入</span><h2>{activePage.title}</h2><p>{activePage.goal}</p></header>
              <div className="v3-planned-note" role="status">此领域在已确认方案中属于后续接入能力。本次 Demo 仅展示方案范围，不提供可执行操作、AI 问答或分析请求。</div>
              <div className="so-coverage-list">{solution.design.coverage.filter((claim) => activePage.claimIds.includes(claim.id ?? "")).map((claim) => <article className="so-coverage" key={claim.id ?? claim.claim}>
                <span className="so-status so-status-planned">后续接入</span><div><strong>{claim.claim}</strong><p>{claim.evidence}</p></div>
              </article>)}</div>
            </section>
            : extensionDomain !== undefined ? extensionDomain : <WorkspaceContent
              key={activePage.id}
              config={config}
              resetKey={resetKey}
              onContext={publishDomainContext}
              domainPage={activePage}
              definitionOverride={payload.definition}
              initialStateOverride={payload.state}
              sharedState={state}
              onSharedStateChange={setState}
              onNavigate={(pageId, dataset, recordId) => navigate({ pageId, ...(dataset ? { dataset } : {}), ...(recordId && dataset ? { recordId } : {}) })}
              route={route}
              onRouteChange={navigate}
            />
            : <div className="mw-content v3-solution-content"><SolutionOverview
            customer={config.customer}
            goal={solution.goal}
            solution={solution.solution}
            design={solution.design}
            blueprint={solution.blueprint}
            pages={solution.pages ?? []}
            steps={solution.steps ?? []}
            roles={config.workspace?.roles ?? []}
            onNavigate={(pageId) => navigate({ pageId })}
          /></div>}
        </div>
        </div>
      </div>
    </section>
  );
  if (!splitEnabled || !splitLayout || !chatBusinessContext) return workspace;
  return <ChatBusinessContextProvider value={chatBusinessContext}>
    <SplitWorkspace controller={splitLayout} chat={overviewChat} label={chatScopeLabel ?? "全方案问答"} scope={chatScopeSummary ?? "只读方案上下文"}>{workspace}</SplitWorkspace>
  </ChatBusinessContextProvider>;
}
