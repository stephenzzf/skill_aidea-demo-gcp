import type { DemoClientExtension } from './extension-contract.ts';

export type { DemoClientExtension, DemoExtensionDomainRenderer, DemoExtensionProviderProps } from './extension-contract.ts';

// Customer-specific code can replace this one static entry point. The shared
// template intentionally has no active extension by default.
export const demoClientExtension: DemoClientExtension | undefined = undefined;
