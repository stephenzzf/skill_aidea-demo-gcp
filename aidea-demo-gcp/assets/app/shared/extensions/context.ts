import type { ExtensionChatContext } from '../contracts.ts';

export type ExtensionContextAction =
  | { type: 'set'; context: ExtensionChatContext | undefined }
  | { type: 'reset' };

export function reduceExtensionContext(
  _current: ExtensionChatContext | undefined,
  action: ExtensionContextAction,
): ExtensionChatContext | undefined {
  return action.type === 'set' ? action.context : undefined;
}
