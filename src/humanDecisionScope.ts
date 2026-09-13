import type { AgentHumanDecisionRecord, HumanDecisionScope } from './types';

export type { HumanDecisionScope } from './types';

export interface HumanDecisionContexts {
  pageDecisionContext?: string;
  decisionContext?: string;
}

export function createHumanDecisionRecord(
  prior: AgentHumanDecisionRecord[],
  input: Omit<AgentHumanDecisionRecord, 'ruleVersion' | 'appliesFromPage'> & { appliesFromPage?: number },
  previousRuleVersion = 0,
): AgentHumanDecisionRecord {
  if (input.scope === 'item') return { ...input };
  if (!Number.isInteger(input.appliesFromPage) || input.appliesFromPage! < 1 || input.appliesFromPage! > 120) {
    throw new Error('A remaining-page rule must have a valid first page.');
  }
  const version = Math.max(previousRuleVersion, prior.reduce((maximum, decision) => Math.max(maximum, decision.ruleVersion ?? 0), 0)) + 1;
  return { ...input, ruleVersion: version, appliesFromPage: input.appliesFromPage };
}

export function readHumanDecisionRecords(value: unknown): AgentHumanDecisionRecord[] {
  if (!Array.isArray(value)) return [];
  const allowedActions = new Set(['approve', 'correct', 'reject']);
  const allowedScopes = new Set(['item', 'remaining_pages']);
  const byId = new Map<string, AgentHumanDecisionRecord>();
  for (const item of value.slice(-100)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string' || !record.id.trim() || typeof record.sourceCandidateId !== 'string' || !record.sourceCandidateId.trim() ||
      typeof record.text !== 'string' || !record.text.trim() || !Number.isFinite(record.createdAt) ||
      !Number.isInteger(record.pageNumber) || Number(record.pageNumber) < 1 || Number(record.pageNumber) > 120 ||
      !allowedActions.has(String(record.action)) || !allowedScopes.has(String(record.scope))) continue;
    const decision: AgentHumanDecisionRecord = {
      id: record.id.slice(0, 100),
      action: record.action as AgentHumanDecisionRecord['action'],
      scope: record.scope as HumanDecisionScope,
      sourceCandidateId: record.sourceCandidateId.slice(0, 100),
      pageNumber: Number(record.pageNumber),
      text: record.text.slice(0, 1000),
      createdAt: Number(record.createdAt),
    };
    if (decision.scope === 'remaining_pages') {
      if (!Number.isInteger(record.ruleVersion) || Number(record.ruleVersion) < 1 || Number(record.ruleVersion) > 100_000 ||
        !Number.isInteger(record.appliesFromPage) || Number(record.appliesFromPage) < 1 || Number(record.appliesFromPage) > 120) continue;
      decision.ruleVersion = Number(record.ruleVersion);
      decision.appliesFromPage = Number(record.appliesFromPage);
    }
    byId.set(decision.id, decision);
  }
  return [...byId.values()];
}

export function recordHumanDecision(
  contexts: HumanDecisionContexts,
  decisionText: string,
  decision: AgentHumanDecisionRecord,
): Required<HumanDecisionContexts> {
  const cleanText = decisionText.trim().slice(0, 1000);
  const ruleVersionText = decision.scope === 'remaining_pages'
    ? ` [v${decision.ruleVersion}; applies from P.${decision.appliesFromPage}]`
    : '';
  const pageEntry = `${decision.scope === 'remaining_pages' ? `[RULE FOR REMAINING PAGES]${ruleVersionText}` : '[THIS ITEM ONLY; DO NOT GENERALIZE]'} ${cleanText}`;
  const pageDecisionContext = [contexts.pageDecisionContext, pageEntry].filter(Boolean).join('\n').slice(-4000);
  const decisionContext = decision.scope === 'remaining_pages'
    ? [contexts.decisionContext, `[RULE FOR REMAINING PAGES]${ruleVersionText} ${cleanText}`].filter(Boolean).join('\n').slice(-4000)
    : contexts.decisionContext ?? '';
  return { pageDecisionContext, decisionContext };
}
