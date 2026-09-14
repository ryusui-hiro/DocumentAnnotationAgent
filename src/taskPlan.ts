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
    title: { type: 'string', minLength: 1, maxLength: 120 },
    objective: { type: 'string', minLength: 1, maxLength: 500 },
    labels: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 60 },
          description: { type: 'string', minLength: 1, maxLength: 240 },
        },
      },
    },
    actions: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string', minLength: 1, maxLength: 80 } },
    uncertaintyPolicy: { type: 'string', minLength: 1, maxLength: 400 },
    workflow: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 120 } },
  },
} as const;

export function taskPlanSignature(instruction: string, guidelines: string, correction: string, mode: AgentMode, model: string, provider: ProviderId) {
  return JSON.stringify([instruction.trim(), guidelines.trim(), correction.trim(), mode, model, provider]);
}

export function localTaskPlan(instruction: string, guidelines = ''): AnnotationTaskPlan {
  const normalized = instruction.trim();
  const taskText = normalized.toLocaleLowerCase();
  const guidanceText = guidelines.toLocaleLowerCase();
  const text = `${taskText}\n${guidanceText}`;
  let labels: AnnotationTaskPlan['labels'];
  let actions = ['該当領域をハイライト', 'ラベルと根拠を記録'];
  let uncertaintyPolicy = /曖昧|不明|uncertain|ambiguous|確認|review/.test(text)
    ? '曖昧、読み取れない、または基準が競合する場合は自動で確定せず、人の確認に回す。'
    : '根拠が明確でない場合は推測せず、人の確認に回す。';
  let workflow = ['文書の各ページを読み、候補箇所を探す。', '候補を分類し、画面上の領域を特定する。', '根拠と短い抜粋を付け、曖昧な候補は確認待ちにする。'];
  const safetyExtraction = /安全|safety|warning|警告/.test(taskText) && /抽出|extract|find|locate|見つけ|探し/.test(taskText);
  const torqueExtraction = /締結トルク|トルク|torque/.test(taskText) && /抽出|extract|find|locate|見つけ|探し/.test(taskText);
  const safetyAndTorqueExtraction = safetyExtraction && torqueExtraction;
  let objective = normalized.slice(0, 500) || '文書内の該当箇所を特定し、根拠を付ける。';
  if (safetyAndTorqueExtraction) {
    labels = [
      { name: 'SAFETY_WARNING', description: '安全を守るために必要な警告、禁止事項、作業手順。必須条件の範囲を対象にする。' },
      { name: 'FASTENING_TORQUE', description: '締結トルクの数値を原文どおり抽出し、単位と関連部品を含める。' },
    ];
    actions = ['警告文またはトルク値の範囲をハイライト', '正確な抜粋・数値・単位を記録'];
    uncertaintyPolicy = '数値、単位、対象部品が欠けている、読み取れない、または一致しない場合は推測せず人に確認する。';
    workflow = ['各ページの警告文と締結トルクを探す。', '根拠のある文または数値の正確な範囲を特定する。', '単位を保って短く引用し、不確かな箇所だけ人に確認する。'];
    objective = '安全上の警告と締結トルク値を抽出し、原文の根拠と位置を付けて記録する。';
  } else if (safetyExtraction) {
    labels = [{ name: 'SAFETY_WARNING', description: '安全を守るために必要な警告、禁止事項、作業手順。必須条件の範囲を対象にする。' }];
    actions = ['警告文または必須手順の範囲をハイライト', '正確な原文抜粋と理由を記録'];
    workflow = ['各ページの安全警告と必須手順を探す。', '文書に書かれた警告の範囲だけを特定する。', '原文を短く引用し、不明な手順だけ人に確認する。'];
    objective = '安全上の警告と必須手順を抽出し、原文の根拠と位置を付けて記録する。';
  } else if (torqueExtraction) {
    labels = [{ name: 'FASTENING_TORQUE', description: '締結トルクの数値を原文どおり抽出し、単位と関連部品を含める。' }];
    actions = ['トルク値と関連部品の範囲をハイライト', '正確な数値・単位・原文抜粋を記録'];
    uncertaintyPolicy = '数値、単位、または対象部品を特定できない場合は推測せず人に確認する。';
    workflow = ['各ページのトルク値と単位を探す。', '対象部品との対応をページ画像で確認する。', '値・単位・短い抜粋を記録し、不明な対応だけ人に確認する。'];
    objective = '締結トルク値を単位・対象部品とともに抽出し、原文の根拠と位置を記録する。';
  } else if (/個人情報|pii|personal information/.test(taskText)) {
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
  } else if (/claim|主張|citation/.test(taskText)) {
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
    objective,
    labels,
    actions,
    uncertaintyPolicy: safetyAndTorqueExtraction ? uncertaintyPolicy : humanReview ? '曖昧、読み取れない、または基準が競合する場合は自動で確定せず、人の確認に回す。' : uncertaintyPolicy,
    workflow,
  } satisfies AnnotationTaskPlan;
}

export function taskPlanAsInstructions(plan: AnnotationTaskPlan) {
  return [
    `Task: ${plan.title}`,
    `Objective: ${plan.objective}`,
    `Labels: ${plan.labels.map((item) => `${item.name} — ${item.description}`).join('; ')}`,
    `Actions: ${plan.actions.join('; ')}`,
    'Evidence: use an exact visible excerpt or addressed cell values; retain page, slide, sheet, and range targets, preserve numeric units, explain the label, and never infer missing content.',
    `Uncertainty: ${plan.uncertaintyPolicy}`,
    `Workflow: ${plan.workflow.join(' → ')}`,
  ].join('\n');
}
