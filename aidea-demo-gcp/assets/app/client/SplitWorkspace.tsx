import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconPlayerStop } from "@tabler/icons-react";
import { DEFAULT_SPLIT_LAYOUT, readSplitLayout } from "./split-layout.ts";
import type { SplitLayoutState } from "./split-layout.ts";
import "./split-workspace.css";

function storage() { try { return window.sessionStorage; } catch { return undefined; } }
export function useSplitLayout(id: string, mode: string, resetKey: number) {
  const key = `me-demo-split:v1:${id}:${mode}`;
  const [layout, setLayout] = useState(() => readSplitLayout(storage(), key));
  const [narrow, setNarrow] = useState(() => window.innerWidth < 960);
  const [storageWarning, setStorageWarning] = useState(false);
  const reset = useRef(resetKey);
  const storedKey = useRef(key);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const update = useCallback((patch: Partial<SplitLayoutState>) => setLayout(value => ({ ...value, ...patch })), []);
  useEffect(() => {
    if (storedKey.current !== key) { storedKey.current = key; setLayout(readSplitLayout(storage(), key)); return; }
    if (reset.current !== resetKey) {
      reset.current = resetKey;
      setLayout({ ...DEFAULT_SPLIT_LAYOUT });
      try { storage()?.removeItem(key); } catch { setStorageWarning(true); }
      return;
    }
    try { const target = storage(); if (target) target.setItem(key, JSON.stringify(layout)); else setStorageWarning(true); }
    catch { setStorageWarning(true); }
  }, [key, layout, resetKey]);
  const visible = narrow ? layout.mobileView === "chat" : !layout.collapsed;
  const toggle = useCallback(() => {
    update(narrow ? { mobileView: visible ? "demo" : "chat" } : { collapsed: visible });
    toggleRef.current?.focus();
  }, [narrow, visible, update]);
  return { layout, narrow, setNarrow, update, visible, toggle, toggleRef, storageWarning };
}
export type SplitLayoutController = ReturnType<typeof useSplitLayout>;

export function SplitHeaderControls({ running, onStop }: { controller: SplitLayoutController; running: boolean; onStop: () => void }) {
  return <div className="split-header-controls">
    {running && <span className="split-running" role="status">正在回复</span>}
    {running && <button type="button" className="reset-button split-stop" aria-label="停止回复" title="停止回复" onClick={onStop}><IconPlayerStop size={17} /><span>停止回复</span></button>}
  </div>;
}

export function SplitWorkspace({ controller, chat, children, label, scope }: {
  controller: SplitLayoutController; chat: ReactNode; children: ReactNode; label: string; scope: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chatRegion = useRef<HTMLElement>(null);
  const demoRegion = useRef<HTMLDivElement>(null);
  const lastFocusedElement = useRef<Element | null>(null);
  const group = useRef<import("react-resizable-panels").GroupImperativeHandle>(null);
  const chatPanel = useRef<import("react-resizable-panels").PanelImperativeHandle>(null);
  const { narrow, setNarrow, layout, visible, update } = controller;
  const toggleLabel = narrow ? visible ? "查看 Demo" : "AI 对话" : visible ? "收起 AI 对话" : "展开 AI 对话";
  useLayoutEffect(() => {
    if (!host.current) return;
    const measure = () => setNarrow(host.current!.getBoundingClientRect().width < 960);
    measure();
    const observer = new ResizeObserver(measure); observer.observe(host.current);
    return () => observer.disconnect();
  }, [setNarrow]);
  useLayoutEffect(() => {
    if (narrow) group.current?.setLayout({ assistant: visible ? 100 : 0, demo: visible ? 0 : 100 });
    else if (layout.collapsed) chatPanel.current?.collapse();
    else {
      chatPanel.current?.expand();
      chatPanel.current?.resize(`${layout.chatPercent}%`);
    }
  }, [narrow, visible, layout.collapsed, layout.chatPercent]);
  useLayoutEffect(() => {
    const active = document.activeElement;
    // Some browsers move focus to body as soon as inert becomes effective.
    const candidate = active === document.body ? lastFocusedElement.current : active;
    const hiddenChatHasFocus = !visible && candidate && chatRegion.current?.contains(candidate);
    const hiddenDemoHasFocus = narrow && visible && candidate && demoRegion.current?.contains(candidate);
    if (hiddenChatHasFocus || hiddenDemoHasFocus) controller.toggleRef.current?.focus();
  }, [narrow, visible, controller.toggleRef]);
  return <div ref={host} className={`split-workspace${narrow ? " split-narrow" : ""}${!narrow && !visible ? " split-collapsed" : ""}`}>
    <button ref={controller.toggleRef} type="button" className="split-boundary-toggle" aria-label={toggleLabel} title={toggleLabel} aria-controls="split-chat-region" aria-expanded={visible} onClick={controller.toggle}>
      {visible ? <IconLayoutSidebarLeftCollapse size={18} /> : <IconLayoutSidebarLeftExpand size={18} />}
    </button>
    {narrow && <div className="split-mobile-switch" aria-label="工作区视图">
      <button type="button" aria-pressed={visible} onClick={() => update({ mobileView: "chat" })}>AI 智能对话</button>
      <button type="button" aria-pressed={!visible} onClick={() => update({ mobileView: "demo" })}>Demo 展示</button>
    </div>}
    <Group groupRef={group} orientation="horizontal" className="split-panel-group" disabled={narrow}
      resizeTargetMinimumSize={{ fine: 12, coarse: 24 }}
      onLayoutChange={sizes => host.current?.style.setProperty("--split-assistant-size", `${sizes.assistant ?? 35}%`)}
      onLayoutChanged={(sizes, meta) => {
        if (narrow || !meta.isUserInteraction) return;
        const size = sizes.assistant;
        if (size !== undefined) update(size === 0 ? { collapsed: true } : { collapsed: false, chatPercent: Math.min(50, size) });
      }}>
      <Panel id="assistant" panelRef={chatPanel} defaultSize="35%" minSize={narrow ? 0 : "320px"} maxSize={narrow ? "100%" : "50%"} collapsible collapsedSize={0}>
        <aside ref={chatRegion} onFocusCapture={event => { lastFocusedElement.current = event.target; }} id="split-chat-region" className={`split-chat-region${!visible ? " split-region-hidden" : ""}`} aria-label="AI 智能对话" aria-hidden={!visible} inert={!visible}>
          <div className="split-chat-heading"><strong>AI 智能对话</strong><span>{label}</span><small>{scope}</small></div>
          {controller.storageWarning && <small className="split-storage-warning" role="status">布局暂不能保存，刷新后可能恢复默认。</small>}
          {chat}
        </aside>
      </Panel>
      <Separator className="split-separator" disabled={narrow} aria-label="调整 AI 对话与 Demo 展示宽度"><span /></Separator>
      <Panel id="demo" defaultSize="65%" minSize={narrow ? 0 : "560px"}>
        <div ref={demoRegion} onFocusCapture={event => { lastFocusedElement.current = event.target; }} className={`split-demo-region${narrow && visible ? " split-region-hidden" : ""}`} aria-hidden={narrow && visible} inert={narrow && visible}>{children}</div>
      </Panel>
    </Group>
  </div>;
}
