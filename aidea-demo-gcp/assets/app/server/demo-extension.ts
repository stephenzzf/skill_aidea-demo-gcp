import type { DemoServerExtension } from './extension-contract.ts';

export type {
  DemoExtensionAuthoritativeAnalysis,
  DemoExtensionChatBinding,
  DemoServerExtension,
} from './extension-contract.ts';

// Customer-specific code can replace this one static entry point. No module is
// loaded from request data, and the common template has no active extension.
export const demoServerExtension: DemoServerExtension | undefined = undefined;
