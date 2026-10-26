import type { ReactNode } from 'react';
import type { Presentation } from '../shared/spec.ts';
/** Explicitly wrap customer-facing source content; never relabel the Chinese analysis shell. */
export function CustomerExperience({presentation,children}:{presentation?:Presentation;children:ReactNode}) {
  return <section lang={presentation?.experienceLocale??'zh-CN'} data-customer-experience>{children}</section>;
}
