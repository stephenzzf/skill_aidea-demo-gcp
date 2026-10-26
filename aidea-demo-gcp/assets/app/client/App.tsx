import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import { IconLock, IconRefresh } from "@tabler/icons-react";
import { ApiRequestError, loadPublicConfig, redeemAccessCode } from "./api.ts";
import type { PublicConfig, WorkspaceChatContext } from "../shared/contracts.ts";
import { NativeChat } from "./NativeChat.tsx";
import { Workspace } from "./WorkspaceRouter.tsx";
import { demoClientExtension } from "./demo-extension.tsx";
import { isPlannedDomain } from "../shared/solution.ts";
import { reduceExtensionContext } from "../shared/extensions/context.ts";
import { clearConversationStorage, getConversationStorage } from "./conversation.ts";
import { createAdkPersistence } from "./adk-history.ts";
import type { PendingComposerDraft } from "./chat-interactions.ts";
import { clearChatInteractions } from "./chat-interactions.ts";
import { SplitHeaderControls, useSplitLayout } from "./SplitWorkspace.tsx";
import { describeChatScope, shouldClearExtensionContext } from "./split-layout.ts";

function chatVisible(config: PublicConfig, context: WorkspaceChatContext | undefined) {
  if (config.solution) return context?.domainId === "solution" && Boolean(config.solution.pages?.some(page => page.components.includes("assistant") && !isPlannedDomain(page, config.solution?.design?.coverage ?? [])));
  return !config.workspace || config.workspace.views.includes("assistant");
}

export function App() {
  const [workspaceContext, setWorkspaceContext] = useState<WorkspaceChatContext | undefined>();
  const [extensionContext, dispatchExtensionContext] = useReducer(reduceExtensionContext, undefined);
  const setExtensionContext = useCallback((context: WorkspaceChatContext["extension"]) => dispatchExtensionContext({ type: "set", context }), []);
  const [resetKey, setResetKey] = useState(0);
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const routeDomain = useRef<string | undefined>(undefined);
  const onWorkspaceDomainChange = useCallback((domainId: string) => {
    if (shouldClearExtensionContext(routeDomain.current, domainId)) dispatchExtensionContext({ type: "reset" });
    routeDomain.current = domainId;
  }, []);
  const [code, setCode] = useState("");
  const [needsAccess, setNeedsAccess] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [notice, setNotice] = useState("");
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const generation = useRef(0);
  const authDraft = useRef<PendingComposerDraft | undefined>(undefined);
  const completeDraftRestore = useCallback(() => { authDraft.current = undefined; }, []);
  const cancelChat = useRef<(() => void) | null>(null);
  const [chatRunning, setChatRunning] = useState(false);
  const stopChat = useRef<(() => void) | null>(null);
  const registerStop = useCallback((stop: (() => void) | null) => { stopChat.current = stop; }, []);
  const splitLayout = useSplitLayout(config?.id ?? "loading", config?.mode ?? "loading", resetKey);
  const registerCancel = useCallback((cancel: (() => void) | null) => { cancelChat.current = cancel; }, []);
  const loadConfig = useCallback(async () => {
    const current = generation.current;
    try {
      const loaded = await loadPublicConfig();
      if (current !== generation.current) return;
      setConfig(loaded); setNeedsAccess(false); setAccessError("");
    } catch (error) {
      if (current !== generation.current) return;
      if (error instanceof ApiRequestError && error.status === 401) { setNeedsAccess(true); setConfig(null); return; }
      setNotice(error instanceof Error ? error.message : "无法加载演示。");
    }
  }, []);
  useEffect(() => { void loadConfig(); return () => { generation.current += 1; }; }, [loadConfig]);
  async function submitAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setAccessError("");
    try { await redeemAccessCode(code.trim()); setCode(""); await loadConfig(); }
    catch (error) { setAccessError(error instanceof Error ? error.message : "访问码验证失败。"); }
  }
  function resetConversation() {
    cancelChat.current?.();
    authDraft.current = undefined;
    if (config) { createAdkPersistence(config).clear(); clearChatInteractions(config); clearConversationStorage(getConversationStorage(), config); }
    setResetKey(key => key + 1); setWorkspaceContext(undefined); dispatchExtensionContext({ type: "reset" }); setNotice("");
  }
  const modelLabel = config?.mode === "vertex" ? "Gemini 实时问答" : config?.mode === "simulated" ? "AI 模拟对话" : "本地测试模型";
  const dataLabel = config?.execution?.data === "bigquery" ? "BigQuery 数据模式" : config?.execution?.data === "local" ? "本地确定性分析" : "数据按方案配置";
  const demoMode = `${modelLabel} · ${dataLabel} · ${config?.synthetic ? "合成数据" : "数据按来源标识"}`;
  if (needsAccess) {
    return (
      <main className="access-page">
        <section className="access-card" aria-labelledby="access-title">
          <img className="access-logo" src="/assets/aideaon-wordmark.png" alt="Aideaon" />
          <span className="access-icon"><IconLock size={22} /></span>
          <h1 id="access-title">输入访问码，开始体验</h1>
          <p>此链接为 Meet Experience 客户演示，请使用邀请中提供的访问码。</p>
          <form onSubmit={submitAccess}>
            <label htmlFor="access-code">访问码</label>
            <input
              id="access-code"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
            {accessError && <p className="access-error" role="alert">{accessError}</p>}
            <button type="submit" disabled={!code.trim()}>继续体验</button>
          </form>
        </section>
      </main>
    );
  }

  if (!config) {
    return <main className="loading-page" role="status">{notice || "正在准备演示…"}</main>;
  }

  const splitEnabled = config.presentation?.workspaceLayout === "split" && Boolean(config.solution?.pages?.some(page => page.components.includes("assistant") && !isPlannedDomain(page, config.solution?.design?.coverage ?? [])));
  const chatContextLabel = config.solution?.pages?.find(
    (page) => page.id === workspaceContext?.domainId,
  )?.title ?? (workspaceContext?.domainId === "solution" ? "全方案问答" : undefined);
  const primaryColor = config.presentation?.brand?.primaryColor;
  const safePrimaryColor =
    typeof primaryColor === "string" && /^#[0-9a-f]{6}$/iu.test(primaryColor)
      ? primaryColor
      : undefined;
  const requestedLogoUrl = config.presentation?.brand?.logoUrl;
  const safeLogoUrl = (() => {
    if (typeof requestedLogoUrl !== "string" || !requestedLogoUrl.trim()) return undefined;
    try {
      const rawUrl = requestedLogoUrl.trim();
      if (!rawUrl.startsWith("/assets/") && !/^https:\/\//iu.test(rawUrl)) return undefined;
      const url = new URL(rawUrl, window.location.origin);
      if (url.username || url.password) return undefined;
      if (rawUrl.startsWith("/assets/") && url.origin !== window.location.origin) return undefined;
      if (rawUrl.startsWith("https://") && url.protocol !== "https:") return undefined;
      return url.href;
    } catch {
      return undefined;
    }
  })();
  const headerLogo = safeLogoUrl && safeLogoUrl !== failedLogoUrl
    ? safeLogoUrl
    : "/assets/aideaon-wordmark.png";
  const appStyle = safePrimaryColor
    ? ({ "--purple": safePrimaryColor } as CSSProperties)
    : undefined;
  const chatPanel = splitEnabled || chatVisible(config, workspaceContext) ? (
    <NativeChat
      key={`${config.id}:${config.mode}:${resetKey}`}
      config={config}
      context={workspaceContext ? { ...workspaceContext, ...(extensionContext ? { extension: extensionContext } : {}) } : undefined}
      demoMode={demoMode}
      contextLabel={chatContextLabel}
      initialDraft={authDraft.current}
      onDraftRestored={completeDraftRestore}
      onUnauthorized={draft => { authDraft.current = draft; setNeedsAccess(true); setConfig(null); }}
      onCancelReady={registerCancel}
      onStopReady={registerStop}
      onRunningChange={setChatRunning}
    />
  ) : null;

  return (
    <div
      lang={config.presentation?.shellLocale ?? "zh-CN"}
      className={`demo-app${config.solution ? " v3-demo-app" : ""}${splitEnabled ? " split-demo-app" : ""}`}
      style={appStyle}
    >
      <header>
        <div className="brand">
          <img
            src={headerLogo}
            alt={headerLogo === "/assets/aideaon-wordmark.png" ? "Aideaon" : config.customer}
            referrerPolicy="no-referrer"
            onError={() => setFailedLogoUrl(safeLogoUrl ?? null)}
          />
          <span />
          <strong>{config.customer} <small>{config.assistantName}</small></strong>
        </div>
        <div className="header-actions">
          <span className="sample-badge">{demoMode}</span>
          {splitEnabled && <SplitHeaderControls controller={splitLayout} running={chatRunning} onStop={() => stopChat.current?.()} />}
          <button className="reset-button" onClick={resetConversation} aria-label="重新体验">
            <IconRefresh size={17} /><span>重新体验</span>
          </button>
        </div>
      </header>
      <main className={config.workspace || config.solution ? "business-layout" : undefined}>
        {(config.workspace || config.solution) && <Workspace config={config} resetKey={resetKey} onContext={setWorkspaceContext} onExtensionContext={setExtensionContext} overviewChat={config.solution ? chatPanel : undefined} splitLayout={splitEnabled ? splitLayout : undefined} onDomainChange={splitEnabled ? onWorkspaceDomainChange : undefined} chatScopeLabel={chatContextLabel ?? "全方案问答"} chatScopeSummary={extensionContext ? (demoClientExtension?.describeContext?.(extensionContext) ?? "业务范围与选中记录见右侧") : describeChatScope(workspaceContext)} />}
        {!config.solution && chatPanel}
      </main>
      <footer>Meet Experience <span>完整方案 · 业务体验 · 结果验证</span></footer>
    </div>
  );
}
