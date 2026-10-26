import { useRef } from "react";
import type { KeyboardEvent } from "react";
import "./domain-navigation.css";

export interface DomainTab {
  id: string;
  title: string;
}

interface DomainNavigationProps {
  activeId: string;
  tabs: DomainTab[];
  onSelect: (id: string) => void;
}

export function DomainNavigation({ activeId, tabs, onSelect }: DomainNavigationProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const targetIndex = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + direction + tabs.length) % tabs.length;
    if (event.key !== "Home" && event.key !== "End" && !direction) return;
    event.preventDefault();
    tabRefs.current[targetIndex]?.focus();
    onSelect(tabs[targetIndex].id);
  }

  return (
    <nav className="v3-domain-navigation" aria-label="方案与业务领域">
      <div className="v3-domain-tabs" role="tablist" aria-label="演示内容">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            ref={(element) => { tabRefs.current[index] = element; }}
            id={`domain-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeId === tab.id}
            aria-controls="domain-panel"
            tabIndex={activeId === tab.id ? 0 : -1}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {tab.title}
          </button>
        ))}
      </div>
    </nav>
  );
}
