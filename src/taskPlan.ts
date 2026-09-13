import type { AgentMode, ProviderId } from './types';
import type { AnnotationTaskPlanSpec } from './types';

export type AnnotationTaskPlan = AnnotationTaskPlanSpec;
export type TaskPlanSource = 'model' | 'local';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function parseTaskPlan(value: unknown): AnnotationTaskPlan | null {
  if (!isRecord(value) || !boundedString(value.title, 120) || !boundedString(value.objective, 500) ||
    !boundedString(value.uncertaintyPolicy, 400) || !Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > 12 ||
    !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 4 ||
    !Array.isArray(value.workflow) || value.workflow.length < 2 || value.workflow.length > 6) return null;
  const labels = value.labels.map((label) => {
    if (!isRecord(label) || !boundedString(label.name, 60) || !boundedString(label.description, 240)) return null;
    return { name: label.name, description: label.description };
  });
  const actions = value.actions.filter((item): item is string => boundedString(item, 80));
  const workflow = value.workflow.filter((item): item is string => boundedString(item, 120));
  if (labels.some((item) => !item) || actions.length !== value.actions.length || workflow.length !== value.workflow.length) return null;
  return {
    title: value.title,
    objective: value.objective,
    labels: labels as AnnotationTaskPlan['labels'],
    actions,
    uncertaintyPolicy: value.uncertaintyPolicy,
    workflow,
  };
}

export const taskPlanJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'objective', 'labels', 'actions', 'uncertaintyPolicy', 'workflow'],
  properties: {
    title: { type: 'string' },
    objective: { type: 'string' },
    labels: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: { name: { type: 'string' }, description: { type: 'string' } },
      },
    },
    actions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
    uncertaintyPolicy: { type: 'string' },
    workflow: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
  },
} as const;

export function taskPlanSignature(instruction: string, guidelines: string, correction: string, mode: AgentMode, model: string, provider: ProviderId) {
  return JSON.stringify([instruction.trim(), guidelines.trim(), correction.trim(), mode, model, provider]);
}

export function localTaskPlan(instruction: string, guidelines = ''): AnnotationTaskPlan {
  const normalized = instruction.trim();
  const text = `${normalized}\n${guidelines}`.toLocaleLowerCase();
  let labels: AnnotationTaskPlan['labels'];
  if (/個人情報|pii|personal information/.test(text)) {
    labels = [
      { name: 'PERSON_NAME', description: '個人を特定できる氏名' },
      { name: 'EMAIL', description: 'メールアドレス' },
      { name: 'PHONE', description: '電話番号' },
      { name: 'ADDRESS', description: '住所または位置情報' },
      { name: 'IDENTIFIER', description: '口座、アカウント、行政などの識別番号' },
    ];
  } else if (/risk|リスク|危険/.test(text)) {
    labels = [
      { name: 'HIGH', description: '重大な不利益や安全上の影響がある箇所' },
      { name: 'MEDIUM', description: '条件、範囲、責任が不明確な箇所' },
      { name: 'LOW', description: '限定的で標準的な注意事項' },
    ];
  } else if (/claim|主張|根拠|citation/.test(text)) {
    labels = [
      { name: 'CLAIM', description: '文書内の主要な主張' },
      { name: 'EVIDENCE', description: '主張を支える根拠' },
      { name: 'ASSUMPTION', description: '明示的な裏付けのない推測' },
      { name: 'CITATION_NEEDED', description: '出典が不足している主張' },
    ];
  } else {
    labels = [{ name: 'MATCH', description: normalized.slice(0, 180) || 'ユーザーの指示に該当する箇所' }];
  }
  const humanReview = /曖昧|不明|uncertain|ambiguous|確認|review/.test(text);
  return {
    title: (normalized || '文書レビュー').slice(0, 120),
    objective: normalized.slice(0, 500) || '文書内の該当箇所を特定し、根拠を付ける。',
    labels,
    actions: ['該当領域をハイライト', 'ラベルと根拠を記録'],
    uncertaintyPolicy: humanReview ? '曖昧、読み取れない、または基準が競合する場合は自動で確定せず、人の確認に回す。' : '根拠が明確でない場合は推測せず、人の確認に回す。',
    workflow: ['文書の各ページを読み、候補箇所を探す。', '候補を分類し、画面上の領域を特定する。', '根拠と短い抜粋を付け、曖昧な候補は確認待ちにする。'],
  } satisfies AnnotationTaskPlan;
}

export function taskPlanAsInstructions(plan: AnnotationTaskPlan) {
  return [
    `Task: ${plan.title}`,
    `Objective: ${plan.objective}`,
    `Labels: ${plan.labels.map((item) => `${item.name} — ${item.description}`).join('; ')}`,
    `Actions: ${plan.actions.join('; ')}`,
    `Uncertainty: ${plan.uncertaintyPolicy}`,
    `Workflow: ${plan.workflow.join(' → ')}`,
  ].join('\n');
}
