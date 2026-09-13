export type HumanDecisionScope = 'item' | 'remaining_pages';

export interface HumanDecisionContexts {
  pageDecisionContext?: string;
  decisionContext?: string;
}

export function recordHumanDecision(
  contexts: HumanDecisionContexts,
  decisionText: string,
  scope: HumanDecisionScope,
): Required<HumanDecisionContexts> {
  const cleanText = decisionText.trim().slice(0, 1000);
  const pageEntry = `${scope === 'remaining_pages' ? '[RULE FOR REMAINING PAGES]' : '[THIS ITEM ONLY; DO NOT GENERALIZE]'} ${cleanText}`;
  const pageDecisionContext = [contexts.pageDecisionContext, pageEntry].filter(Boolean).join('\n').slice(-4000);
  const decisionContext = scope === 'remaining_pages'
    ? [contexts.decisionContext, `[RULE FOR REMAINING PAGES] ${cleanText}`].filter(Boolean).join('\n').slice(-4000)
    : contexts.decisionContext ?? '';
  return { pageDecisionContext, decisionContext };
}
