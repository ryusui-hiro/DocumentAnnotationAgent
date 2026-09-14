import type { PaperBlock } from './paperOcrTypes';

export type HumanLabelRule = { name: string; description: string };
export const humanLabelRuleLimits = { count: 24, name: 120, description: 1000 } as const;
export type LabelRuleIssue = 'too_many' | 'missing_name' | 'name_too_long' | 'description_too_long' | 'duplicate_name';

/** Only rows explicitly entered by a person become constraints; model labels never enter this function automatically. */
export function prepareHumanLabelRules(input: HumanLabelRule[]): { rules: HumanLabelRule[]; issue?: LabelRuleIssue } {
  const rules = input.map((rule) => ({ name: rule.name.trim(), description: rule.description.trim() })).filter((rule) => rule.name || rule.description);
  if (rules.length > humanLabelRuleLimits.count) return { rules, issue: 'too_many' };
  if (rules.some((rule) => !rule.name)) return { rules, issue: 'missing_name' };
  if (rules.some((rule) => rule.name.length > humanLabelRuleLimits.name)) return { rules, issue: 'name_too_long' };
  if (rules.some((rule) => rule.description.length > humanLabelRuleLimits.description)) return { rules, issue: 'description_too_long' };
  if (new Set(rules.map((rule) => rule.name)).size !== rules.length) return { rules, issue: 'duplicate_name' };
  return { rules };
}

export function enforceHumanLabel(block: PaperBlock, rules: readonly HumanLabelRule[] = []): PaperBlock {
  if (rules.length && !rules.some((rule) => rule.name === block.label)) throw new Error(`The AI returned a label outside your defined labels: ${block.label ?? '(missing label)'}.`);
  return block;
}
