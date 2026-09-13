export type ModelId = 'gpt-6-astra' | 'gpt-5.6-sol' | 'gpt-5.6-terra' | 'gpt-5.6-luna';
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ProviderId = 'openai-api' | 'azure-openai' | 'openai-compatible' | 'codex-app-server';
export type AgentMode = 'observe' | 'suggest' | 'assist' | 'autopilot';
export type AgentRunStatus = 'ready' | 'running' | 'waiting' | 'complete' | 'error';
export type AgentActivityPhase = 'Planning' | 'Navigating' | 'Reading' | 'Searching' | 'Annotating' | 'Reviewing' | 'Asking' | 'Continuing' | 'Exporting';

export interface AgentActivityEvent {
  id: string;
  phase: AgentActivityPhase;
  detail: string;
  pageNumber?: number;
  status: 'active' | 'complete' | 'waiting' | 'error';
  createdAt: number;
}

export interface AnnotationTaskPlanSpec {
  title: string;
  objective: string;
  labels: Array<{ name: string; description: string }>;
  actions: string[];
  uncertaintyPolicy: string;
  workflow: string[];
}

export type PageCoverageStatus = 'checked' | 'image_only' | 'opened' | 'failed' | 'demo_only';
export interface AgentPageCoverage {
  pageNumber: number;
  status: PageCoverageStatus;
  findingCount: number;
  reviewCount: number;
  warningCount: number;
  textBlockCount?: number;
  detail?: string;
}

export type HumanDecisionScope = 'item' | 'remaining_pages';
export type HumanDecisionAction = 'approve' | 'correct' | 'reject';

export interface AgentHumanDecisionRecord {
  id: string;
  action: HumanDecisionAction;
  scope: HumanDecisionScope;
  sourceCandidateId: string;
  pageNumber: number;
  text: string;
  createdAt: number;
  /** Present only for a rule explicitly applied to later pages. */
  ruleVersion?: number;
  appliesFromPage?: number;
}

export interface AgentRunHistory {
  id: string;
  fileName: string;
  sourceHash?: string;
  startedAt: number;
  endedAt?: number;
  instruction: string;
  mode: AgentMode;
  status: 'running' | 'waiting' | 'complete' | 'error' | 'interrupted';
  totalPages: number;
  completedPages: number;
  summary?: string;
  taskPlan?: AnnotationTaskPlanSpec;
  observationFindings?: AnnotationCandidate[];
  observationFindingOverflow?: number;
  pageCoverageTargets?: number[];
  pageCoverage?: AgentPageCoverage[];
  humanDecisions?: AgentHumanDecisionRecord[];
  /** Monotonic across the whole run even when older decision records are pruned. */
  lastHumanRuleVersion?: number;
  events: AgentActivityEvent[];
}

export type WorkspaceFileStatus = 'ready' | 'running' | 'complete' | 'review' | 'error';

export interface WorkspaceDocumentEntry {
  id: string;
  relativePath: string;
  selected: boolean;
  status: WorkspaceFileStatus;
  error?: string;
  size?: number;
  lastModified?: number;
  sourceHash?: string;
  nativePath?: string;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  source: 'desktop' | 'browser';
  rootPath?: string;
  connected: boolean;
  documents: WorkspaceDocumentEntry[];
}

export interface AppSettings {
  apiServerUrl: string;
  provider: ProviderId;
  endpoint: string;
  azureDeployment: string;
  model: ModelId;
  reasoningEffort: ReasoningEffort;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

export interface UsageByModel {
  provider: ProviderId;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
}

export interface UsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  byModel: Record<string, UsageByModel>;
}

export interface ConvertedPage {
  pageNumber: number;
  width: number;
  height: number;
  warnings: string[];
  warningCount: number;
}

export interface ConvertedDocument {
  documentId: string;
  sourceHash?: string;
  fileName: string;
  fileType: string;
  pageCount: number;
  elapsedMs: number;
  needsReview: boolean;
  warnings: string[];
  pages: ConvertedPage[];
  demo: boolean;
}

export type NormalizedTextBox = { x: number; y: number; width: number; height: number };
export type TextAnchor = {
  quote: { exact: string; prefix: string; suffix: string };
  position: { start: number; end: number; unit: 'normalized-page-text' };
};

export type SpreadsheetValue = string | number | boolean | null;

export interface SpreadsheetCellChange {
  id: string;
  operation: 'write_cell' | 'write_range' | 'create_column';
  sheetName: string;
  range: string;
  values: SpreadsheetValue[][];
  reason: string;
  confidence?: number;
  reviewPriority?: AnnotationReviewPriority;
  requiresReview: boolean;
  approved?: boolean;
  rejected?: boolean;
  reviewOutcome?: 'approved' | 'corrected';
  approvalRunId?: string;
  approvalId?: string;
}

export interface SpreadsheetSheetSummary {
  name: string;
  rowCount: number;
  columnCount: number;
  headers: string[];
  sampleRows: Array<{ rowNumber: number; values: SpreadsheetValue[] }>;
}

export interface WorkbookSessionSummary {
  fileName: string;
  sheets: SpreadsheetSheetSummary[];
  changes: SpreadsheetCellChange[];
}

export interface Annotation {
  id: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  note: string;
  color: string;
  source: 'manual' | 'ai';
  confidence?: number;
  reviewPriority?: AnnotationReviewPriority;
  reason?: string;
  requiresReview?: boolean;
  excerpt?: string;
  fragments?: NormalizedTextBox[];
  textAnchor?: TextAnchor;
  reviewedByHuman?: boolean;
  reviewOutcome?: 'approved' | 'corrected';
}

export interface AnnotationCandidate extends Annotation {
  approvalRunId?: string;
  approvalId?: string;
}

export type AnnotationTarget =
  | { kind: 'page'; page: number; boundingBox: NormalizedTextBox; fragments?: NormalizedTextBox[]; textAnchor?: TextAnchor }
  | { kind: 'slide'; slide: number; boundingBox: NormalizedTextBox; fragments?: NormalizedTextBox[]; textAnchor?: TextAnchor }
  | { kind: 'sheet'; sheet: string; cellRange: string };

export type AnnotationReviewPriority = 'low' | 'medium' | 'high';
export type DocumentAnnotationStatus = 'auto' | 'needs_review' | 'approved' | 'corrected' | 'rejected';

export interface DocumentAnnotationRecord {
  id: string;
  documentId: string;
  sourceHash?: string;
  target: AnnotationTarget;
  label: string;
  evidence: string;
  explanation: string;
  reviewPriority: AnnotationReviewPriority;
  status: DocumentAnnotationStatus;
  confidence?: number;
  note?: string;
  reason?: string;
  excerpt?: string;
  color?: string;
  source?: 'manual' | 'ai';
  requiresReview?: boolean;
  reviewedByHuman?: boolean;
  approvalRunId?: string;
  approvalId?: string;
  operation?: SpreadsheetCellChange['operation'];
  values?: SpreadsheetCellChange['values'];
  approved?: boolean;
  rejected?: boolean;
}

export type PreparedExportFormat = 'native-annotated' | 'annotations-json' | 'annotations-csv';

export interface PreparedDocumentExport {
  id: string;
  documentId: string;
  sourceDocumentName: string;
  fileName: string;
  format: PreparedExportFormat;
  annotationsExported: number;
  skippedCount: number;
  expiresAt: number;
}

export interface DocumentAnnotationOperation {
  id: string;
  operation: 'update' | 'delete';
  annotationId: string;
  pageNumber: number;
  existingLabel: string;
  existingNote: string;
  proposedLabel?: string;
  proposedNote?: string;
  reason: string;
  status: 'needs_review' | 'approved' | 'rejected';
  approvalRunId?: string;
  approvalId?: string;
}

export interface ApiHealth {
  ok: boolean;
  provider: 'openai' | 'azure';
  aiConfigured: boolean;
  models: ModelId[];
  conversion: string;
  maxUploadMb: number;
  codexAppServerConfigured: boolean;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: ReasoningEffort; description: string }>;
  defaultReasoningEffort: ReasoningEffort;
}
