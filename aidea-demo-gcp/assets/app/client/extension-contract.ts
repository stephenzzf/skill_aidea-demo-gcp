import type { ComponentType, ReactNode } from 'react';
import type { PublicConfig, ExtensionChatContext } from '../shared/contracts.ts';
import type { DomainPage } from '../shared/solution.ts';
import type { DomainRoute } from './Workspace.tsx';

export interface DemoExtensionProviderProps {
  config: PublicConfig;
  resetKey: number;
  onContext: (context: ExtensionChatContext | undefined) => void;
  children: ReactNode;
}

export type DemoExtensionDomainRenderer = (input: {
  page: DomainPage;
  navigate: (route: DomainRoute, replace?: boolean) => void;
}) => ReactNode | undefined;

export interface DemoClientExtension {
  id: string;
  Provider?: ComponentType<DemoExtensionProviderProps>;
  renderDomain?: DemoExtensionDomainRenderer;
  /** Display-only summary; never adds trusted model instructions. */
  describeContext?: (context: ExtensionChatContext) => string;
}
