import { V3Workspace } from "./V3Workspace.tsx";
import { WorkspaceContent } from "./Workspace.tsx";
import type { WorkspaceProps } from "./Workspace.tsx";
import type { ExtensionChatContext } from "../shared/contracts.ts";
import { demoClientExtension } from "./demo-extension.tsx";

export interface RoutedWorkspaceProps extends WorkspaceProps {
  onExtensionContext: (context: ExtensionChatContext | undefined) => void;
}

export function Workspace(props: RoutedWorkspaceProps) {
  const { onExtensionContext, ...workspaceProps } = props;
  const content = props.config.solution
    ? <V3Workspace {...workspaceProps} renderDomain={demoClientExtension?.renderDomain} />
    : <WorkspaceContent {...workspaceProps} />;
  const Provider = demoClientExtension?.Provider;
  return Provider
    ? <Provider config={props.config} resetKey={props.resetKey} onContext={onExtensionContext}>{content}</Provider>
    : content;
}
