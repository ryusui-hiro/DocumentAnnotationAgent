import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type PointerEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  CloudUpload,
  Download,
  FileText,
  FileSpreadsheet,
  Files,
  FolderOpen,
  FolderTree,
  Highlighter,
  LoaderCircle,
  MessageSquareText,
  MousePointer2,
  ScanLine,
  Settings2,
  ShieldAlert,
  Sparkles,
  Square,
  StopCircle,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  createSvgPreviewUrl,
  revokeSvgPreviewUrl,
} from 'document-svg/preview-ui';
import type { AgentActivityEvent, AgentActivityPhase, AgentMode, AgentPageCoverage, AgentHumanDecisionRecord, AgentRunHistory, AgentRunStatus, Annotation, AnnotationCandidate, AnnotationReviewPriority, ApiHealth, AppSettings, CodexModel, ConvertedDocument, ConvertedPage, DocumentAnnotationOperation, DocumentAnnotationRecord, ModelId, NormalizedTextBox, PreparedDocumentExport, ProviderId, SpreadsheetCellChange, TokenUsage, UsageTotals, WorkbookSessionSummary, WorkspaceDocumentEntry, WorkspaceProject } from './types';
import SettingsDialog from './components/SettingsDialog';
import { apiFetch } from './api';
import { consumeAgentStream, type LiveToolActivity } from './agentStream';
import { readAgentRunHistory, resolveHumanReviewStatus, upsertAgentRunHistory, writeAgentRunHistory } from './runHistory';
import { localTaskPlan, parseTaskPlan, taskPlanAsInstructions, taskPlanSignature, type AnnotationTaskPlan, type TaskPlanSource } from './taskPlan';
import { findInconsistentRepeatedExcerpts, restoreAnnotationConsistencyIssues, type AnnotationConsistencyIssue } from './consistency';
import { normalizeDocumentAnnotationRecords, readStoredDocumentAnnotationRecords, resolveCandidateReview, restoreDocumentAnnotationRecords } from './documentAnnotations';
import { mergePreparedDocumentExports, restorePreparedDocumentExports } from './preparedExports';
import { createHumanDecisionRecord, readHumanDecisionRecords, recordHumanDecision, type HumanDecisionScope } from './humanDecisionScope';
import { isSupportedWorkspaceFile, loadWorkspaceProject, maxWorkspaceDocuments, saveWorkspaceProject, shouldIgnoreWorkspaceDirectory } from './workspace';
import { readWorkspaceState, writeWorkspaceState } from './workspaceState';
import {
  emptyUsageTotals,
  formatTokens,
  loadApiKey,
  loadSettings,
  loadUsageTotals,
  modelCatalog,
  persistSettings,
  persistUsageTotals,
} from './settings';

type Tool = 'select' | 'rectangle' | 'note';

function reviewPriorityLabel(priority?: AnnotationReviewPriority, requiresReview = false) {
  const value = priority ?? (requiresReview ? 'high' : 'medium');
  return value === 'high' ? '高' : value === 'medium' ? '中' : '低';
}

type ArrayStateAction<T> = T[] | ((previous: T[]) => T[]);

function resolveArrayState<T>(action: ArrayStateAction<T>, previous: T[]) {
  return typeof action === 'function' ? (action as (previous: T[]) => T[])(previous) : action;
}

type AgentPostResult = { ok: boolean; status: number; payload: any; streamedActivityCount: number };

async function postAgentRequest(
  path: string,
  payload: Record<string, unknown>,
  apiServerUrl: string,
  onActivity: (event: LiveToolActivity) => void,
): Promise<AgentPostResult> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ ...payload, stream: true }),
  }, apiServerUrl);
  if (!response.ok) {
    const errorBody = await response.json().catch(() => ({}));
    return { ok: false, status: response.status, payload: errorBody, streamedActivityCount: 0 };
  }
  const { payload: result, streamedActivityCount } = await consumeAgentStream<any>(response, onActivity);
  return { ok: true, status: response.status, payload: result, streamedActivityCount };
}
type PanelTab = 'ai' | 'annotations' | 'workspace';
type GuideTab = 'workflow' | 'concept';
type Point = { x: number; y: number };
type RegionShape = { x: number; y: number; width: number; height: number; fragments?: NormalizedTextBox[] };

function visibleAnnotationFragments(region: RegionShape): NormalizedTextBox[] {
  return region.fragments?.length ? region.fragments : [{ x: region.x, y: region.y, width: region.width, height: region.height }];
}
type AgentContinuation = {
  remainingPages: number[];
  blockedPage: number;
  sourceHash?: string;
  fullDocument?: boolean;
  humanCorrections?: number;
  visitedPages?: number[];
  mode: AgentMode;
  instruction: string;
  guidelines: string;
  correction: string;
  decisionContext: string;
  pageDecisionContext?: string;
  humanDecisions?: AgentHumanDecisionRecord[];
  lastHumanRuleVersion?: number;
  approvalRunId?: string;
  approvalId?: string;
  runHistoryId?: string;
  pendingApprovalDecision?: { approved: boolean; note: string };
};
type AgentApprovalDecision = { runId: string; approvalId: string; approved: boolean; note?: string };
type AgentAnalysisOutcome = { status: 'complete' | 'waiting' | 'error'; completedPages: number; totalPages: number };
type BatchProgress = { status: 'running' | 'complete' | 'stopped'; current: number; total: number; fileName: string };
type TaskPlanSnapshot = { signature: string; source: TaskPlanSource; plan: AnnotationTaskPlan };

const WORKSPACE_MAX_DEPTH = 16;

function waitForRender() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function joinNativePath(directory: string, name: string) {
  const separator = directory.includes('\\') ? '\\' : '/';
  return `${directory.replace(/[\\/]+$/, '')}${separator}${name}`;
}

function nativeDirectoryName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

async function enumerateDesktopWorkspace(rootPath: string): Promise<WorkspaceDocumentEntry[]> {
  const { readDir } = await import('@tauri-apps/plugin-fs');
  const documents: WorkspaceDocumentEntry[] = [];
  const visit = async (directory: string, relativeDirectory: string, depth: number): Promise<void> => {
    if (depth > WORKSPACE_MAX_DEPTH || documents.length >= maxWorkspaceDocuments) return;
    const entries = await readDir(directory);
    for (const entry of entries) {
      if (documents.length >= maxWorkspaceDocuments) break;
      if (!entry.name || entry.isSymlink) continue;
      const nativePath = joinNativePath(directory, entry.name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (!shouldIgnoreWorkspaceDirectory(entry.name)) await visit(nativePath, relativePath, depth + 1);
      } else if (entry.isFile && isSupportedWorkspaceFile(entry.name)) {
        documents.push({ id: relativePath, relativePath, selected: true, status: 'ready', nativePath });
      }
    }
  };
  await visit(rootPath, '', 0);
  return documents.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

const DEFAULT_PROMPT = '安全上の警告と締結トルクを抽出';
const TASK_PRESETS = [
  { id: 'contract', label: '契約リスク', prompt: '契約書全体から解除、損害賠償、更新、秘密保持に関する条項を見つけ、High / Medium / Low riskで分類してください。', guidelines: 'High: 一方的な解除、上限のない賠償など重大な不利益。Medium: 条件や期限が不明確。Low: 標準的で限定的な義務。該当文の範囲を囲み、判断理由と短い原文抜粋を付けてください。' },
  { id: 'pii', label: '個人情報', prompt: '文書内の個人情報をすべて見つけて種類別にマーキングしてください。', guidelines: '氏名、連絡先、住所、識別番号、口座・決済情報を分類してください。推測せず、該当文字列が読める場合は短く引用してください。' },
  { id: 'spreadsheet', label: '表の行リスク', prompt: '表の各行を読み、記載内容に基づいてHigh / Medium / Low riskに分類してください。', guidelines: '行全体を対象範囲にし、分類ラベルと根拠を付けてください。列の値を取り違えないようにし、読めないセルが判断に影響する場合は確認が必要としてください。' },
  { id: 'claims', label: '主張・根拠', prompt: 'レポートの主張を見つけ、事実の根拠・推測・意見に分類してください。', guidelines: '対象段落を囲み、主張と根拠の対応を短く説明してください。根拠が文書内に見つからない場合は推測として扱い、確認が必要としてください。' },
  { id: 'slides', label: 'スライド分類', prompt: '各スライドの内容を Product / Market / Financial / Team に分類してください。', guidelines: 'スライド内の主要な内容を対象範囲にし、最も重要なカテゴリを1つ選んで理由を記してください。複数カテゴリが同程度なら人の確認を求めてください。' },
];
const AGENT_MODES: Array<{ id: AgentMode; label: string; description: string }> = [
  { id: 'observe', label: 'Observe', description: '読み取りのみ。注釈状態を変更しません。' },
  { id: 'suggest', label: 'Suggest', description: '見つけた箇所をすべて候補として提示します。' },
  { id: 'assist', label: 'Assist', description: '明確な箇所を注釈し、曖昧なら確認します。' },
  { id: 'autopilot', label: 'Autopilot', description: '全ページを連続処理し、曖昧な箇所だけ待ちます。' },
];
const PAGE_COVERAGE_LABELS: Record<AgentPageCoverage['status'], string> = {
  checked: '確認済み',
  image_only: '画像のみ・要確認',
  opened: '開いたが未確認',
  failed: '処理失敗',
  demo_only: 'デモ出力・未検証',
};
const LABEL_COLORS = [
  { name: 'Teal', value: '#178b87' },
  { name: 'Amber', value: '#e8a532' },
  { name: 'Violet', value: '#9275d3' },
  { name: 'Blue', value: '#557ec2' },
  { name: 'Rose', value: '#d36c74' },
];

const demoAnnotations: Annotation[] = [
  { id: 'demo-limit', pageNumber: 1, x: 0.585, y: 0.22, width: 0.335, height: 0.16, label: '制限値', note: '運転温度と最大締結トルクを確認してください。', color: '#9275d3', source: 'ai' },
  { id: 'demo-warning', pageNumber: 1, x: 0.075, y: 0.63, width: 0.85, height: 0.105, label: '安全上の注意', note: '作業前に電源を遮断し、ファンが停止したことを確認します。', color: '#e8a532', source: 'ai' },
  { id: 'demo-components', pageNumber: 2, x: 0.12, y: 0.29, width: 0.78, height: 0.43, label: '交換部品', note: '交換対象の部品を特定して、個別に注釈を付けます。', color: '#178b87', source: 'manual' },
  { id: 'demo-measurement', pageNumber: 3, x: 0.58, y: 0.34, width: 0.27, height: 0.24, label: '測定記録', note: '振動計の表示と測定位置を記録します。', color: '#557ec2', source: 'manual' },
];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function scrollAreaContentSize(area: HTMLElement) {
  const style = window.getComputedStyle(area);
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  return {
    width: Math.max(1, area.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight)),
    height: Math.max(1, area.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom)),
  };
}

function visiblePageViewport(area: HTMLElement | null, frame: HTMLElement | null): NormalizedTextBox | undefined {
  if (!area || !frame) return undefined;
  const visible = scrollAreaContentSize(area);
  const areaStyle = window.getComputedStyle(area);
  const pixels = (value: string) => Number.parseFloat(value) || 0;
  const areaRect = area.getBoundingClientRect();
  const frameRect = frame.getBoundingClientRect();
  if (frameRect.width <= 0 || frameRect.height <= 0) return undefined;
  const width = Math.max(0.001, Math.min(1, visible.width / frameRect.width));
  const height = Math.max(0.001, Math.min(1, visible.height / frameRect.height));
  const clipLeft = areaRect.left + area.clientLeft + pixels(areaStyle.paddingLeft);
  const clipTop = areaRect.top + area.clientTop + pixels(areaStyle.paddingTop);
  return {
    x: clamp((clipLeft - frameRect.left) / frameRect.width, 0, 1 - width),
    y: clamp((clipTop - frameRect.top) / frameRect.height, 0, 1 - height),
    width,
    height,
  };
}

function parseDocument(payload: Record<string, unknown>): ConvertedDocument {
  return {
    documentId: String(payload.documentId ?? ''),
    ...(typeof payload.sourceHash === 'string' && /^[\da-f]{64}$/i.test(payload.sourceHash) ? { sourceHash: payload.sourceHash.toLowerCase() } : {}),
    fileName: String(payload.fileName ?? 'document.pdf'),
    fileType: String(payload.fileType ?? 'PDF'),
    pageCount: Number(payload.pageCount ?? 0),
    elapsedMs: Number(payload.elapsedMs ?? 0),
    needsReview: Boolean(payload.needsReview),
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
    pages: Array.isArray(payload.pages) ? payload.pages.map((page) => {
      const entry = page as Record<string, unknown>;
      return {
        pageNumber: Number(entry.pageNumber ?? 0),
        width: Number(entry.width ?? 0),
        height: Number(entry.height ?? 0),
        warnings: Array.isArray(entry.warnings) ? entry.warnings.map(String) : [],
        warningCount: Number(entry.warningCount ?? 0),
      } satisfies ConvertedPage;
    }) : [],
    demo: Boolean(payload.demo),
  };
}

function restoreAnnotationOperations(value: unknown): DocumentAnnotationOperation[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is DocumentAnnotationOperation => {
    if (!entry || typeof entry !== 'object') return false;
    const operation = entry as Partial<DocumentAnnotationOperation>;
    return typeof operation.id === 'string'
      && ['update', 'delete'].includes(String(operation.operation))
      && typeof operation.annotationId === 'string'
      && Number.isInteger(operation.pageNumber) && Number(operation.pageNumber) >= 1 && Number(operation.pageNumber) <= 120
      && typeof operation.existingLabel === 'string'
      && typeof operation.existingNote === 'string'
      && typeof operation.reason === 'string'
      && ['needs_review', 'approved', 'rejected'].includes(String(operation.status));
  }).slice(-50).map((entry) => ({
    ...entry,
    id: entry.id.slice(0, 100),
    annotationId: entry.annotationId.slice(0, 100),
    existingLabel: entry.existingLabel.slice(0, 60),
    existingNote: entry.existingNote.slice(0, 500),
    ...(typeof entry.proposedLabel === 'string' ? { proposedLabel: entry.proposedLabel.slice(0, 60) } : {}),
    ...(typeof entry.proposedNote === 'string' ? { proposedNote: entry.proposedNote.slice(0, 500) } : {}),
    reason: entry.reason.slice(0, 500),
  }));
}

function seededCandidates(pageNumber: number, instruction: string): AnnotationCandidate[] {
  if (pageNumber === 1) {
    return [
      { id: crypto.randomUUID(), pageNumber, x: 0.585, y: 0.22, width: 0.335, height: 0.16, label: '制限値', note: '運転温度と最大締結トルク。指示に基づくデモ候補です。', reason: 'サンプル画面を示すための固定候補です。', excerpt: '最大締結トルク', reviewPriority: 'high', requiresReview: true, color: '#9275d3', source: 'ai' },
      { id: crypto.randomUUID(), pageNumber, x: 0.075, y: 0.63, width: 0.85, height: 0.105, label: '安全上の注意', note: '電源の遮断とファン停止の確認。指示に基づくデモ候補です。', reason: 'サンプル画面を示すための固定候補です。', excerpt: '作業前に電源を遮断', reviewPriority: 'high', requiresReview: true, color: '#e8a532', source: 'ai' },
    ];
  }
  if (pageNumber === 2) {
    return [{ id: crypto.randomUUID(), pageNumber, x: 0.12, y: 0.29, width: 0.78, height: 0.43, label: '部品構成', note: `「${instruction.slice(0, 28)}」に関係するデモ候補です。`, reason: 'サンプル画面を示すための固定候補です。', reviewPriority: 'high', requiresReview: true, color: '#178b87', source: 'ai' }];
  }
  return [{ id: crypto.randomUUID(), pageNumber, x: 0.36, y: 0.3, width: 0.42, height: 0.34, label: '点検記録', note: `「${instruction.slice(0, 28)}」に関係する写真領域のデモ候補です。`, reason: 'サンプル画面を示すための固定候補です。', reviewPriority: 'high', requiresReview: true, color: '#557ec2', source: 'ai' }];
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function colorComponents(hex: string) {
  const value = hex.replace('#', '');
  const normalized = value.length === 3 ? value.split('').map((part) => part + part).join('') : value;
  const number = Number.parseInt(normalized, 16);
  if (!Number.isFinite(number)) return [0.15, 0.5, 0.46] as const;
  return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255] as const;
}

function sameRegion(left: Annotation, right: Annotation) {
  if (left.pageNumber !== right.pageNumber) return false;
  const intersectionWidth = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const intersectionHeight = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  const intersection = intersectionWidth * intersectionHeight;
  const smallerArea = Math.min(left.width * left.height, right.width * right.height);
  return smallerArea > 0 && intersection / smallerArea >= 0.78;
}

function extractSvgTextBlocks(svg: string) {
  const xml = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (xml.querySelector('parsererror')) return [];
  const root = xml.documentElement;
  const viewBox = (root.getAttribute('viewBox') ?? '').split(/[ ,]+/).map(Number);
  const pageWidth = viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : Number.parseFloat(root.getAttribute('width') ?? '') || 612;
  const pageHeight = viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : Number.parseFloat(root.getAttribute('height') ?? '') || 792;
  return Array.from(xml.getElementsByTagName('text')).flatMap((node) => {
    const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return [];
    const x = Number.parseFloat(node.getAttribute('x') ?? '') || 0;
    const y = Number.parseFloat(node.getAttribute('y') ?? '') || 0;
    const fontRule = (node.getAttribute('style') ?? '').match(/font-size\s*:\s*([\d.]+)/i)?.[1];
    const fontSize = Number.parseFloat(node.getAttribute('font-size') ?? fontRule ?? '') || 10;
    const width = Math.max(fontSize, Math.min(pageWidth - x, text.length * fontSize * 0.52));
    const height = fontSize * 1.25;
    return [{
      text,
      x: clamp(x / pageWidth),
      y: clamp((y - fontSize) / pageHeight),
      width: clamp(width / pageWidth),
      height: clamp(height / pageHeight),
    }];
  });
}

function isDesktopShell() {
  return typeof window !== 'undefined' && (
    window.location.protocol === 'tauri:' ||
    window.location.hostname.endsWith('.tauri.localhost') ||
    '__TAURI_INTERNALS__' in window
  );
}

function ToolButton({ selected, label, onClick, children }: { selected: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" className={`tool-button${selected ? ' is-selected' : ''}`} aria-label={label} aria-pressed={selected} title={label} onClick={onClick}>
      {children}<span>{label}</span>
    </button>
  );
}

function App() {
  const desktop = isDesktopShell();
  const [documentData, setDocumentData] = useState<ConvertedDocument | null>(null);
  const [workbookSummary, setWorkbookSummary] = useState<WorkbookSessionSummary | null>(null);
  const [documentAnnotationRecords, setDocumentAnnotationRecords] = useState<DocumentAnnotationRecord[]>([]);
  const documentAnnotationView = useMemo(() => restoreDocumentAnnotationRecords(documentAnnotationRecords), [documentAnnotationRecords]);
  const { annotations, candidates, rejectedCandidates, spreadsheetChanges } = documentAnnotationView;
  const [preparedDocumentExports, setPreparedDocumentExports] = useState<PreparedDocumentExport[]>([]);
  const [annotationOperations, setAnnotationOperations] = useState<DocumentAnnotationOperation[]>([]);
  const [consistencyIssues, setConsistencyIssues] = useState<AnnotationConsistencyIssue[]>([]);
  const [observationFindings, setObservationFindings] = useState<AnnotationCandidate[]>([]);
  const [observationDocumentId, setObservationDocumentId] = useState<string | null>(null);
  const [health, setHealth] = useState<ApiHealth | null>(null);
  const [workspaceProject, setWorkspaceProject] = useState<WorkspaceProject | null>(() => {
    try { return loadWorkspaceProject(window.localStorage); } catch { return null; }
  });
  const [workspaceSessionIds, setWorkspaceSessionIds] = useState<Record<string, string>>({});
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null);
  const [taskPlan, setTaskPlan] = useState<TaskPlanSnapshot | null>(null);
  const [taskPlanLoading, setTaskPlanLoading] = useState(false);
  const [guidelineImporting, setGuidelineImporting] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [apiKey, setApiKey] = useState(() => loadApiKey());
  const [usage, setUsage] = useState<UsageTotals>(loadUsageTotals);
  const [lastUsage, setLastUsage] = useState<TokenUsage | null>(null);
  const [codexModels, setCodexModels] = useState<CodexModel[]>([]);
  const [codexModelsLoading, setCodexModelsLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [connectionTest, setConnectionTest] = useState<{ status: 'idle' | 'testing' | 'success' | 'error'; message: string }>({ status: 'idle', message: '' });
  const [candidateCorrections, setCandidateCorrections] = useState<Record<string, { label: string; note: string }>>({});
  const [candidateCorrectionScopes, setCandidateCorrectionScopes] = useState<Record<string, HumanDecisionScope>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [activeTool, setActiveTool] = useState<Tool>('select');
  const [activeTab, setActiveTab] = useState<PanelTab>('ai');
  const [guideTab, setGuideTab] = useState<GuideTab>('workflow');
  const [agentMode, setAgentMode] = useState<AgentMode>('assist');
  const visibleObservationFindings = agentMode === 'observe' && observationDocumentId === documentData?.documentId
    ? observationFindings
    : [];
  const [agentStatus, setAgentStatus] = useState<AgentRunStatus>('ready');
  const [agentViewport, setAgentViewport] = useState<NormalizedTextBox | null>(null);
  const [agentViewportScale, setAgentViewportScale] = useState<number | null>(null);
  const [agentActivity, setAgentActivity] = useState<AgentActivityEvent[]>([]);
  const [agentRunHistory, setAgentRunHistory] = useState<AgentRunHistory[]>([]);
  const [agentContinuation, setAgentContinuation] = useState<AgentContinuation | null>(null);
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [taskPresetId, setTaskPresetId] = useState('');
  const [guidelines, setGuidelines] = useState('該当箇所を囲み、簡潔なラベルと文書上の根拠を付けてください。判断が曖昧な場合は確認が必要としてください。');
  const [correction, setCorrection] = useState('');
  const [scanProgress, setScanProgress] = useState<{ current: number; total: number; scope: 'current' | 'all' } | null>(null);
  const [working, setWorking] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [exportingWord, setExportingWord] = useState(false);
  const [exportingPowerPoint, setExportingPowerPoint] = useState(false);
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number } | null>(null);
  const [loadingDemo, setLoadingDemo] = useState(true);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [message, setMessage] = useState('');
  const [showGuide, setShowGuide] = useState(false);
  const [saved, setSaved] = useState(true);
  const [dragStart, setDragStart] = useState<Point | null>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(100);
  const [aiMode, setAiMode] = useState<'live' | 'demo' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workspaceFolderInputRef = useRef<HTMLInputElement>(null);
  const guidelineFileInputRef = useRef<HTMLInputElement>(null);
  const fileDragDepthRef = useRef(0);
  const workspaceBrowserFilesRef = useRef(new Map<string, File>());
  const workspaceProjectRef = useRef<WorkspaceProject | null>(workspaceProject);
  const workspaceBatchActiveRef = useRef(false);
  const workspaceBatchCancelledRef = useRef(false);
  const activeDocumentIdRef = useRef<string | null>(documentData?.documentId ?? null);
  const activeFileTypeRef = useRef<string | null>(documentData?.fileType ?? null);
  const taskPlanRef = useRef(taskPlan);
  const pageFrameRef = useRef<HTMLDivElement>(null);
  const pageScrollAreaRef = useRef<HTMLDivElement>(null);
  const pageImageRef = useRef<HTMLImageElement>(null);
  const candidateSectionRef = useRef<HTMLDivElement>(null);
  const activityPanelRef = useRef<HTMLElement>(null);
  const activityLogRef = useRef<HTMLOListElement>(null);
  const agentActivityRef = useRef<AgentActivityEvent[]>([]);
  const agentRunHistoryRef = useRef<AgentRunHistory[]>([]);
  const activeAgentRunRef = useRef<AgentRunHistory | null>(null);
  const annotationOperationsRef = useRef<DocumentAnnotationOperation[]>(annotationOperations);
  const analyzeAgentRef = useRef<((scope: 'current' | 'all', continuation?: AgentContinuation) => Promise<AgentAnalysisOutcome | undefined>) | null>(null);
  const resumeAgentRef = useRef<((continuation: AgentContinuation, decision?: AgentApprovalDecision) => Promise<void>) | null>(null);
  const updateDocumentAnnotationRecords = (update: (current: ReturnType<typeof restoreDocumentAnnotationRecords>) => ReturnType<typeof restoreDocumentAnnotationRecords>) => {
    setDocumentAnnotationRecords((records) => {
      const current = restoreDocumentAnnotationRecords(records);
      const next = update(current);
      return normalizeDocumentAnnotationRecords({
        documentId: activeDocumentIdRef.current ?? records[0]?.documentId ?? documentData?.documentId ?? '',
        sourceHash: documentData?.sourceHash,
        fileType: activeFileTypeRef.current ?? documentData?.fileType ?? 'PDF',
        ...next,
      });
    });
  };
  const setAnnotations = (action: ArrayStateAction<Annotation>) => updateDocumentAnnotationRecords((current) => ({ ...current, annotations: resolveArrayState(action, current.annotations) }));
  const setCandidates = (action: ArrayStateAction<AnnotationCandidate>) => updateDocumentAnnotationRecords((current) => ({ ...current, candidates: resolveArrayState(action, current.candidates) }));
  const setRejectedCandidates = (action: ArrayStateAction<AnnotationCandidate>) => updateDocumentAnnotationRecords((current) => ({ ...current, rejectedCandidates: resolveArrayState(action, current.rejectedCandidates) }));
  const setSpreadsheetChanges = (action: ArrayStateAction<SpreadsheetCellChange>) => updateDocumentAnnotationRecords((current) => ({ ...current, spreadsheetChanges: resolveArrayState(action, current.spreadsheetChanges) }));
  const documentWorkspaceStateRef = useRef({ documentId: documentData?.documentId ?? '', sourceHash: documentData?.sourceHash ?? '', fileType: documentData?.fileType ?? '', documentAnnotationRecords, annotationOperations, consistencyIssues, preparedDocumentExports, continuation: agentContinuation, task: { prompt, guidelines, correction, mode: agentMode, plan: taskPlan } });
  workspaceProjectRef.current = workspaceProject;
  taskPlanRef.current = taskPlan;
  documentWorkspaceStateRef.current = { documentId: documentData?.documentId ?? '', sourceHash: documentData?.sourceHash ?? '', fileType: documentData?.fileType ?? '', documentAnnotationRecords, annotationOperations, consistencyIssues, preparedDocumentExports, continuation: agentContinuation, task: { prompt, guidelines, correction, mode: agentMode, plan: taskPlan } };
  annotationOperationsRef.current = annotationOperations;
  activeDocumentIdRef.current = documentData?.documentId ?? activeDocumentIdRef.current;
  activeFileTypeRef.current = documentData?.fileType ?? activeFileTypeRef.current;

  const refreshWorkbookSummary = async (documentId: string) => {
    const response = await apiFetch(`/api/documents/${encodeURIComponent(documentId)}/workbook`, undefined, settings.apiServerUrl);
    if (!response.ok) throw new Error((await response.json()).error ?? 'Excelブックを読み込めませんでした。');
    const summary = await response.json() as WorkbookSessionSummary;
    if (activeDocumentIdRef.current === documentId) {
      setWorkbookSummary(summary);
      setSpreadsheetChanges((existing) => {
        const byId = new Map(existing.map((change) => [change.id, change]));
        for (const change of summary.changes ?? []) byId.set(change.id, change);
        return [...byId.values()];
      });
    }
    return summary;
  };

  const mergeWorkbookChanges = (items: unknown, approvalRunId?: unknown, approvalId?: unknown) => {
    if (!Array.isArray(items)) return;
    const changes = items.filter((item): item is SpreadsheetCellChange => Boolean(item && typeof item === 'object' && typeof (item as SpreadsheetCellChange).id === 'string'))
      .map((change) => change.id === approvalId && typeof approvalRunId === 'string'
        ? { ...change, approvalRunId, approvalId: change.id }
        : change);
    setSpreadsheetChanges((existing) => {
      const byId = new Map(existing.map((change) => [change.id, change]));
      for (const change of changes) {
        const merged = { ...byId.get(change.id), ...change };
        if (!merged.requiresReview || merged.approved || merged.rejected) {
          delete merged.approvalRunId;
          delete merged.approvalId;
        }
        byId.set(change.id, merged);
      }
      return [...byId.values()];
    });
  };

  const persistRunHistoryEntry = (entry: AgentRunHistory) => {
    const next = upsertAgentRunHistory(agentRunHistoryRef.current, entry);
    agentRunHistoryRef.current = next;
    setAgentRunHistory(next);
    try { writeAgentRunHistory(window.localStorage, entry.fileName, next, entry.sourceHash); } catch { /* Keep history in memory if browser storage is disabled. */ }
  };

  const restoreRunHistory = (fileName: string, sourceHash?: string) => {
    let history: AgentRunHistory[] = [];
    try {
      history = readAgentRunHistory(window.localStorage, fileName, sourceHash);
      writeAgentRunHistory(window.localStorage, fileName, history, sourceHash);
    } catch { /* The work session remains usable without browser storage. */ }
    agentRunHistoryRef.current = history;
    setAgentRunHistory(history);
  };

  const clearAgentActivity = () => {
    agentActivityRef.current = [];
    setAgentActivity([]);
  };

  const persistWorkspaceProject = (project: WorkspaceProject) => {
    workspaceProjectRef.current = project;
    setWorkspaceProject(project);
    try { saveWorkspaceProject(window.localStorage, project); } catch { /* Keep the project in memory if storage is disabled. */ }
  };

  const updateWorkspaceDocument = (id: string, patch: Partial<WorkspaceDocumentEntry>) => {
    const current = workspaceProjectRef.current;
    if (!current) return;
    persistWorkspaceProject({
      ...current,
      documents: current.documents.map((item) => item.id === id ? { ...item, ...patch } : item),
    });
  };

  const saveCurrentDocumentWorkspace = (fileName: string) => {
    const state = documentWorkspaceStateRef.current;
    try {
      const sourceHash = state.sourceHash || undefined;
      writeWorkspaceState(window.localStorage, fileName, sourceHash, {
        version: 4,
        ...(sourceHash ? { sourceHash } : {}),
        documentId: state.documentId,
        fileType: state.fileType,
        documentAnnotations: state.documentAnnotationRecords,
        annotationOperations: state.annotationOperations,
        consistencyIssues: state.consistencyIssues,
        preparedExports: restorePreparedDocumentExports(state.preparedDocumentExports, fileName),
        continuation: state.continuation,
        task: state.task,
      });
    } catch { /* The current analysis remains available in memory. */ }
  };

  const autoSaveDocumentWorkspace = (fileName: string) => {
    window.requestAnimationFrame(() => {
      saveCurrentDocumentWorkspace(fileName);
      setSaved(true);
    });
  };

  const restoreDocumentWorkspace = async (fileName: string, pageCount: number, restoreTask: boolean, sourceHash?: string) => {
    let annotations: Annotation[] = [];
    let candidates: AnnotationCandidate[] = [];
    let rejected: AnnotationCandidate[] = [];
    let restoredSpreadsheetChanges: SpreadsheetCellChange[] = [];
    let restoredAnnotationOperations: DocumentAnnotationOperation[] = [];
    let restoredConsistencyIssues: AnnotationConsistencyIssue[] = [];
    let restoredPreparedExports: PreparedDocumentExport[] = [];
    let continuation: AgentContinuation | null = null;
    let task: { prompt?: string; guidelines?: string; correction?: string; mode?: AgentMode; plan?: unknown } = {};
    let sourceChanged = false;
    let legacySourceVerified = false;
    let continuationInvalid = false;
    const verifyDocumentIdentity = async (documentId: string) => {
      try {
        const response = await apiFetch(`/api/documents/${encodeURIComponent(documentId)}/identity`, undefined, settings.apiServerUrl);
        if (!response.ok) return false;
        const identity = await response.json() as { sourceHash?: unknown };
        return identity.sourceHash === sourceHash;
      } catch {
        return false;
      }
    };
    const latestWorkspace = readWorkspaceState(window.localStorage, fileName);
    const requestedWorkspace = readWorkspaceState(window.localStorage, fileName, sourceHash);
    sourceChanged = requestedWorkspace.status === 'changed';
    let raw = requestedWorkspace.raw;
    if (requestedWorkspace.status === 'legacy' && raw && sourceHash) {
      try {
        const legacy = JSON.parse(raw) as Record<string, unknown>;
        legacySourceVerified = typeof legacy.documentId === 'string' && await verifyDocumentIdentity(legacy.documentId);
      } catch { legacySourceVerified = false; }
      if (!legacySourceVerified) sourceChanged = true;
    }
    if (sourceChanged) raw = latestWorkspace.raw;

    try {
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          if (!sourceHash) annotations = parsed as Annotation[];
          else sourceChanged = true;
        }
        else if (parsed && typeof parsed === 'object') {
          const value = parsed as { version?: unknown; sourceHash?: unknown; documentId?: unknown; documentAnnotations?: unknown; annotationOperations?: unknown; consistencyIssues?: unknown; preparedExports?: unknown; annotations?: unknown; candidates?: unknown; rejectedCandidates?: unknown; spreadsheetChanges?: unknown; continuation?: unknown; task?: typeof task };
          if (value.task && typeof value.task === 'object') task = value.task;
          const storedSourceHash = typeof value.sourceHash === 'string' && /^[\da-f]{64}$/i.test(value.sourceHash) ? value.sourceHash.toLowerCase() : undefined;
          const workspaceVersionMatches = !sourceHash || storedSourceHash === sourceHash || legacySourceVerified;
          if (!workspaceVersionMatches) sourceChanged = true;
          if (workspaceVersionMatches && !sourceChanged) {
            restoredAnnotationOperations = restoreAnnotationOperations(value.annotationOperations);
            restoredConsistencyIssues = restoreAnnotationConsistencyIssues(value.consistencyIssues);
            restoredPreparedExports = restorePreparedDocumentExports(value.preparedExports, fileName);
            if (Number(value.version) >= 3 && Array.isArray(value.documentAnnotations)) {
              const restored = restoreDocumentAnnotationRecords(value.documentAnnotations);
              annotations = restored.annotations;
              candidates = restored.candidates;
              rejected = restored.rejectedCandidates;
              restoredSpreadsheetChanges = restored.spreadsheetChanges;
            } else {
              if (Array.isArray(value.annotations)) annotations = value.annotations as Annotation[];
              if (Array.isArray(value.candidates)) candidates = value.candidates as AnnotationCandidate[];
              if (Array.isArray(value.rejectedCandidates)) rejected = value.rejectedCandidates as AnnotationCandidate[];
              if (Array.isArray(value.spreadsheetChanges)) restoredSpreadsheetChanges = value.spreadsheetChanges.filter((change): change is SpreadsheetCellChange => Boolean(change && typeof change === 'object' && typeof (change as SpreadsheetCellChange).id === 'string'));
            }
          }
          if (!sourceChanged && workspaceVersionMatches && value.continuation && typeof value.continuation === 'object') {
            const pending = value.continuation as Partial<AgentContinuation>;
            if (Array.isArray(pending.remainingPages) && Number.isFinite(pending.blockedPage) && ['observe', 'suggest', 'assist', 'autopilot'].includes(String(pending.mode))) {
              const pendingHashMatches = !sourceHash || pending.sourceHash === sourceHash;
              const legacyRunMatches = Boolean(sourceHash && !pending.sourceHash && typeof value.documentId === 'string' && await verifyDocumentIdentity(value.documentId));
              if (pendingHashMatches || legacyRunMatches) {
                continuation = {
                  remainingPages: pending.remainingPages.map(Number).filter((page) => page >= 1 && page <= pageCount),
                  blockedPage: Number(pending.blockedPage),
                  ...(sourceHash ? { sourceHash } : {}),
                  ...(typeof pending.fullDocument === 'boolean' ? { fullDocument: pending.fullDocument } : {}),
                  ...(Number.isFinite(pending.humanCorrections) ? { humanCorrections: Number(pending.humanCorrections) } : {}),
                  ...(Array.isArray(pending.visitedPages) ? { visitedPages: pending.visitedPages.map(Number).filter((page) => page >= 1 && page <= pageCount) } : {}),
                  mode: pending.mode as AgentMode,
                  instruction: String(pending.instruction ?? ''),
                  guidelines: String(pending.guidelines ?? ''),
                  correction: String(pending.correction ?? ''),
                  decisionContext: String(pending.decisionContext ?? '').slice(0, 4000),
                  pageDecisionContext: String(pending.pageDecisionContext ?? '').slice(0, 4000),
                  humanDecisions: readHumanDecisionRecords(pending.humanDecisions),
                  ...(Number.isInteger(pending.lastHumanRuleVersion) ? { lastHumanRuleVersion: Math.max(0, Math.min(100_000, Number(pending.lastHumanRuleVersion))) } : {}),
                  ...(typeof pending.approvalRunId === 'string' ? { approvalRunId: pending.approvalRunId } : {}),
                  ...(typeof pending.approvalId === 'string' ? { approvalId: pending.approvalId } : {}),
                  ...(typeof pending.runHistoryId === 'string' ? { runHistoryId: pending.runHistoryId } : {}),
                  ...(pending.pendingApprovalDecision && typeof pending.pendingApprovalDecision === 'object' ? {
                    pendingApprovalDecision: {
                      approved: Boolean((pending.pendingApprovalDecision as { approved?: unknown }).approved),
                      note: String((pending.pendingApprovalDecision as { note?: unknown }).note ?? '').slice(0, 500),
                    },
                  } : {}),
                };
              } else continuationInvalid = true;
            }
          }
        }
      }
    } catch { /* Ignore an invalid saved document workspace. */ }

    if (sourceChanged && sourceHash) {
      let previous: unknown = null;
      try { previous = raw ? JSON.parse(raw) as unknown : null; } catch { previous = null; }
      if (previous && typeof previous === 'object') {
        const previousRecord = previous as Record<string, unknown>;
        const previousHash = typeof previousRecord.sourceHash === 'string' ? previousRecord.sourceHash : 'legacy';
        try { writeWorkspaceState(window.localStorage, fileName, previousHash, previous); } catch { /* Preserve the current document even if local storage is full. */ }
      }
      try {
        writeWorkspaceState(window.localStorage, fileName, sourceHash, {
          version: 4, sourceHash, documentId: activeDocumentIdRef.current ?? '',
          fileType: activeFileTypeRef.current ?? 'PDF', documentAnnotations: [], annotationOperations: [],
          consistencyIssues: [], preparedExports: [], continuation: null, task: restoreTask ? task : {},
        });
      } catch { /* The current document remains usable without storage. */ }
    } else if (legacySourceVerified && sourceHash && raw) {
      try {
        const migrated = JSON.parse(raw) as Record<string, unknown>;
        writeWorkspaceState(window.localStorage, fileName, sourceHash, { ...migrated, version: 4, sourceHash });
      } catch { /* Keep the legacy workspace in place if migration storage fails. */ }
    }

    setDocumentAnnotationRecords(normalizeDocumentAnnotationRecords({
      documentId: activeDocumentIdRef.current ?? '',
      sourceHash,
      fileType: activeFileTypeRef.current ?? 'PDF',
      annotations, candidates, rejectedCandidates: rejected, spreadsheetChanges: restoredSpreadsheetChanges,
    }));
    annotationOperationsRef.current = restoredAnnotationOperations;
    setAnnotationOperations(restoredAnnotationOperations);
    setConsistencyIssues(restoredConsistencyIssues);
    setPreparedDocumentExports((current) => mergePreparedDocumentExports(current, restoredPreparedExports));
    setAgentContinuation(restoreTask ? continuation : null);
    setAgentStatus(restoreTask && continuation ? 'waiting' : 'ready');
    if (restoreTask) {
      const restoredPrompt = typeof task.prompt === 'string' ? task.prompt : prompt;
      const restoredGuidelines = typeof task.guidelines === 'string' ? task.guidelines : guidelines;
      const restoredCorrection = typeof task.correction === 'string' ? task.correction : correction;
      const restoredMode = ['observe', 'suggest', 'assist', 'autopilot'].includes(String(task.mode)) ? task.mode as AgentMode : agentMode;
      setPrompt(restoredPrompt);
      setGuidelines(restoredGuidelines);
      setCorrection(restoredCorrection);
      setAgentMode(restoredMode);
      const storedPlan = task.plan as Partial<TaskPlanSnapshot> | undefined;
      const parsedPlan = storedPlan ? parseTaskPlan(storedPlan.plan) : null;
      const expectedSignature = taskPlanSignature(restoredPrompt, restoredGuidelines, restoredCorrection, restoredMode, settings.model, settings.provider);
      const restoredTaskPlan = parsedPlan && storedPlan?.signature === expectedSignature && (storedPlan.source === 'model' || storedPlan.source === 'local')
        ? { signature: expectedSignature, source: storedPlan.source, plan: parsedPlan }
        : null;
      taskPlanRef.current = restoredTaskPlan;
      setTaskPlan(restoredTaskPlan);
    }
    setSaved(true);
    return { sourceChanged, continuationInvalid, foundWorkspace: Boolean(raw) || sourceChanged };
  };

  const addAgentActivity = (phase: AgentActivityPhase, detail: string, status: AgentActivityEvent['status'] = 'complete', targetPage?: number) => {
    const id = crypto.randomUUID();
    const event: AgentActivityEvent = { id, phase, detail: detail.slice(0, 1200), status, ...(targetPage ? { pageNumber: targetPage } : {}), createdAt: Date.now() };
    const events = [...agentActivityRef.current, event].slice(-48);
    agentActivityRef.current = events;
    setAgentActivity(events);
    if (activeAgentRunRef.current) {
      activeAgentRunRef.current = { ...activeAgentRunRef.current, events };
      persistRunHistoryEntry(activeAgentRunRef.current);
    }
    return id;
  };

  const updateAgentActivity = (id: string, patch: Partial<Pick<AgentActivityEvent, 'detail' | 'status' | 'pageNumber'>>) => {
    const events = agentActivityRef.current.map((event) => event.id === id ? { ...event, ...patch, ...(patch.detail ? { detail: patch.detail.slice(0, 1200) } : {}) } : event);
    agentActivityRef.current = events;
    setAgentActivity(events);
    if (activeAgentRunRef.current) {
      activeAgentRunRef.current = { ...activeAgentRunRef.current, events };
      persistRunHistoryEntry(activeAgentRunRef.current);
    }
  };

  const syncViewerToToolEvent = (event: LiveToolActivity) => {
    if (event.toolName === 'navigate_page' && event.pageNumber !== undefined) {
      setAgentViewport(null);
      setAgentViewportScale(null);
      if (event.pageNumber !== pageNumber) setSelectedId(null);
      setPageNumber(event.pageNumber);
      window.requestAnimationFrame(() => pageScrollAreaRef.current?.scrollTo({ left: 0, top: 0 }));
      return;
    }
    if (event.toolName !== 'scroll_document' || !event.viewport) return;
    const viewport = event.viewport;
    const targetPage = event.pageNumber ?? pageNumber;
    if (event.pageNumber !== undefined) setPageNumber(event.pageNumber);
    const page = documentData?.pages.find((item) => item.pageNumber === targetPage);
    const area = pageScrollAreaRef.current;
    let scale = 1 / Math.max(viewport.width, viewport.height);
    if (page && page.width > 0 && page.height > 0 && area) {
      const visible = scrollAreaContentSize(area);
      const pageAspect = page.width / page.height;
      const displayedWidth = targetPage === pageNumber ? pageFrameRef.current?.offsetWidth ?? 0 : 0;
      const displayedHeight = targetPage === pageNumber ? pageFrameRef.current?.offsetHeight ?? 0 : 0;
      const heightLimit = Math.max(1, window.innerHeight - (window.matchMedia('(max-width: 560px)').matches ? 310 : 205));
      const baseWidth = displayedWidth > 0 ? displayedWidth : Math.min(visible.width, heightLimit * pageAspect);
      const baseHeight = displayedHeight > 0 ? displayedHeight : baseWidth / pageAspect;
      scale = Math.min(
        visible.width / (baseWidth * viewport.width),
        visible.height / (baseHeight * viewport.height),
      );
    }
    setAgentViewportScale(Number.isFinite(scale) && scale > 0 ? scale : 1 / Math.max(viewport.width, viewport.height));
    setAgentViewport(viewport);
  };

  const clearAgentViewport = () => {
    setAgentViewport(null);
    setAgentViewportScale(null);
    window.requestAnimationFrame(() => pageScrollAreaRef.current?.scrollTo({ left: 0, top: 0 }));
  };

  const mergeAnnotationOperations = (value: unknown) => {
    const received = restoreAnnotationOperations(value);
    if (!received.length) return;
    const byId = new Map(annotationOperationsRef.current.map((operation) => [operation.id, operation]));
    const newlyApproved: DocumentAnnotationOperation[] = [];
    for (const operation of received) {
      const previous = byId.get(operation.id);
      if (operation.status === 'approved' && previous?.status !== 'approved') newlyApproved.push(operation);
      byId.set(operation.id, operation);
    }
    const next = [...byId.values()].slice(-50);
    annotationOperationsRef.current = next;
    setAnnotationOperations(next);
    for (const operation of newlyApproved) {
      const existing = annotations.find((annotation) => annotation.id === operation.annotationId);
      if (!existing) {
        setMessage(`対象注釈 ${operation.annotationId} が見つからないため、Agentの変更を適用できませんでした。`);
        continue;
      }
      if (operation.operation === 'update') {
        setAnnotations((items) => items.map((annotation) => annotation.id === operation.annotationId
          ? { ...annotation, label: operation.proposedLabel ?? annotation.label, note: operation.proposedNote ?? annotation.note, reason: operation.reason, requiresReview: false, reviewedByHuman: true, reviewOutcome: 'approved' }
          : annotation));
        addAgentActivity('Annotating', `update_annotation → ${operation.existingLabel}を「${operation.proposedLabel ?? operation.existingLabel}」に変更しました。`, 'complete', operation.pageNumber);
      } else {
        setAnnotations((items) => items.filter((annotation) => annotation.id !== operation.annotationId));
        setCandidates((items) => items.filter((candidate) => candidate.id !== operation.annotationId));
        setRejectedCandidates((items) => items.filter((candidate) => candidate.id !== operation.annotationId));
        setSelectedId((current) => current === operation.annotationId ? null : current);
        addAgentActivity('Annotating', `delete_annotation → ${operation.existingLabel}を削除しました。`, 'complete', operation.pageNumber);
      }
      setSaved(false);
    }
  };

  const changeSettings = (patch: Partial<AppSettings>) => {
    if (patch.model || patch.provider || patch.endpoint || patch.azureDeployment) invalidateTaskPlan();
    setSettings((current) => {
      const next = { ...current, ...patch };
      persistSettings(next);
      return next;
    });
  };

  const changeApiKey = (key: string) => {
    setApiKey(key);
  };

  const saveConnectionSettings = () => {
    persistSettings(settings);
    setSettingsOpen(false);
    setMessage('接続設定を保存しました。APIキーはこのセッションのメモリにのみ保持します。');
  };

  const recordUsage = (provider: ProviderId, modelName: string, usageValue?: Partial<TokenUsage>, requestCount = 1) => {
    if (!usageValue) return;
    const increment: TokenUsage = {
      inputTokens: Number(usageValue.inputTokens ?? 0),
      outputTokens: Number(usageValue.outputTokens ?? 0),
      reasoningTokens: Number(usageValue.reasoningTokens ?? 0),
      cachedInputTokens: Number(usageValue.cachedInputTokens ?? 0),
      totalTokens: Number(usageValue.totalTokens ?? 0),
    };
    const key = `${provider}:${modelName}`;
    setUsage((current) => {
      const previous = current.byModel[key] ?? {
        provider, model: modelName, requests: 0, inputTokens: 0, outputTokens: 0,
        reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 0,
      };
      const next: UsageTotals = {
        requests: current.requests + requestCount,
        inputTokens: current.inputTokens + increment.inputTokens,
        outputTokens: current.outputTokens + increment.outputTokens,
        reasoningTokens: current.reasoningTokens + increment.reasoningTokens,
        cachedInputTokens: current.cachedInputTokens + increment.cachedInputTokens,
        totalTokens: current.totalTokens + increment.totalTokens,
        byModel: {
          ...current.byModel,
          [key]: {
            ...previous,
            requests: previous.requests + requestCount,
            inputTokens: previous.inputTokens + increment.inputTokens,
            outputTokens: previous.outputTokens + increment.outputTokens,
            reasoningTokens: previous.reasoningTokens + increment.reasoningTokens,
            cachedInputTokens: previous.cachedInputTokens + increment.cachedInputTokens,
            totalTokens: previous.totalTokens + increment.totalTokens,
          },
        },
      };
      persistUsageTotals(next);
      return next;
    });
    setLastUsage(increment);
  };

  const invalidateTaskPlan = () => {
    taskPlanRef.current = null;
    setTaskPlan(null);
  };

  const prepareTaskPlan = async (instruction: string, taskGuidelines: string, taskCorrection: string, mode: AgentMode) => {
    const signature = taskPlanSignature(instruction, taskGuidelines, taskCorrection, mode, settings.model, settings.provider);
    if (taskPlanRef.current?.signature === signature) return taskPlanRef.current;
    setTaskPlanLoading(true);
    let next: { signature: string; source: TaskPlanSource; plan: AnnotationTaskPlan };
    try {
      const providerMatches = (settings.provider === 'azure-openai' && health?.provider === 'azure') ||
        (settings.provider === 'openai-api' && health?.provider === 'openai');
      const configured = settings.provider === 'codex-app-server'
        ? Boolean(health?.codexAppServerConfigured)
        : settings.provider === 'openai-compatible'
          ? Boolean(settings.endpoint.trim())
          : Boolean(apiKey.trim()) || Boolean(health?.aiConfigured && providerMatches);
      if (!configured) {
        next = { signature, source: 'local', plan: localTaskPlan(instruction, taskGuidelines) };
      } else {
        const response = await apiFetch('/api/ai/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instruction,
            guidelines: taskGuidelines,
            correction: taskCorrection,
            mode,
            model: settings.model,
            settings: { ...settings, apiKey },
          }),
        }, settings.apiServerUrl);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? 'Task Planner could not interpret the instruction.');
        const parsedPlan = parseTaskPlan(result.plan);
        if (!parsedPlan) throw new Error('Task Planner returned an invalid plan.');
        next = { signature, source: result.source === 'model' ? 'model' : 'local', plan: parsedPlan };
        if (result.usage) recordUsage(result.provider as ProviderId, String(result.model ?? settings.model), result.usage as TokenUsage);
      }
    } catch {
      next = { signature, source: 'local', plan: localTaskPlan(instruction, taskGuidelines) };
    } finally {
      setTaskPlanLoading(false);
    }
    taskPlanRef.current = next;
    setTaskPlan(next);
    return next;
  };

  const validateCompletedDocument = async (input: {
    instruction: string;
    taskPlan: string;
    guidelines: string;
    correction?: string;
    humanDecisions?: string;
    annotations: Array<Annotation | AnnotationCandidate>;
  }) => {
    const uniqueAnnotations = [...new Map(input.annotations.map((annotation) => [annotation.id, annotation])).values()].slice(0, 500);
    const summaries = uniqueAnnotations.map((annotation) => ({
      id: annotation.id,
      pageNumber: annotation.pageNumber,
      label: annotation.label.slice(0, 60),
      excerpt: (annotation.excerpt ?? '').slice(0, 1000),
      explanation: [annotation.reason, annotation.note].filter(Boolean).join('\n').slice(0, 1000),
      reviewPriority: annotation.reviewPriority ?? (annotation.requiresReview ? 'high' as const : 'medium' as const),
      status: annotation.reviewOutcome ?? (annotation.reviewedByHuman
        ? annotation.source === 'ai' ? 'approved' as const : 'corrected' as const
        : annotation.requiresReview || annotation.reviewPriority === 'high' ? 'needs_review' as const
          : annotation.source === 'manual' ? 'approved' as const : 'auto' as const),
    }));
    const issues = findInconsistentRepeatedExcerpts(uniqueAnnotations);
    if (!summaries.length) return { issues, usage: undefined as TokenUsage | undefined, modelFindingCount: 0 };
    const providerMatches = (settings.provider === 'azure-openai' && health?.provider === 'azure') ||
      (settings.provider === 'openai-api' && health?.provider === 'openai');
    const validatorConfigured = settings.provider === 'codex-app-server'
      ? Boolean(health?.codexAppServerConfigured)
      : settings.provider === 'openai-compatible'
        ? Boolean(settings.endpoint.trim())
        : Boolean(apiKey.trim()) || Boolean(health?.aiConfigured && providerMatches);
    if (!validatorConfigured) return { issues, usage: undefined as TokenUsage | undefined, modelFindingCount: 0 };

    const activityId = addAgentActivity('Reviewing', 'validator_agent → independently reviewing document-wide labels, evidence, and support.', 'active');
    try {
      const response = await apiFetch('/api/ai/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instruction: input.instruction.trim(),
          taskPlan: input.taskPlan,
          guidelines: input.guidelines.trim(),
          correction: (input.correction ?? '').trim(),
          humanDecisions: (input.humanDecisions ?? '').slice(0, 4000),
          annotations: summaries,
          model: settings.model,
          settings: { ...settings, apiKey },
        }),
      }, settings.apiServerUrl);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Validator Agent could not review the annotation set.');
      const annotationsById = new Map(summaries.map((annotation) => [annotation.id, annotation]));
      const modelIssues: AnnotationConsistencyIssue[] = (Array.isArray(result.findings) ? result.findings : []).flatMap((finding: Record<string, unknown>) => {
        const validatorType = ['label_conflict', 'similar_excerpt', 'unsupported_claim', 'evidence_gap'].includes(String(finding.kind)) ? String(finding.kind) as NonNullable<AnnotationConsistencyIssue['validatorType']> : undefined;
        const annotationIds = Array.isArray(finding.annotationIds) ? [...new Set(finding.annotationIds.map(String))].filter((id) => annotationsById.has(id)).slice(0, 10) : [];
        if (!validatorType || !annotationIds.length || (['label_conflict', 'similar_excerpt'].includes(validatorType) && annotationIds.length < 2)) return [];
        const occurrences = annotationIds.map((id) => {
          const annotation = annotationsById.get(id)!;
          return { annotationId: id, pageNumber: annotation.pageNumber, label: annotation.label, excerpt: annotation.excerpt };
        }).sort((left, right) => left.pageNumber - right.pageNumber);
        if (['label_conflict', 'similar_excerpt'].includes(validatorType) && new Set(occurrences.map((item) => item.label.normalize('NFKC').toLocaleLowerCase())).size < 2) return [];
        return [{
          id: typeof finding.id === 'string' ? finding.id : `validator:${validatorType}:${annotationIds.slice().sort().join(':')}`,
          kind: 'model_review' as const,
          validatorType,
          validatorTitle: typeof finding.title === 'string' ? finding.title.slice(0, 160) : 'Validator Agent review',
          validatorReason: typeof finding.reason === 'string' ? finding.reason.slice(0, 600) : '',
          reviewPriority: ['low', 'medium', 'high'].includes(String(finding.reviewPriority)) ? finding.reviewPriority as AnnotationConsistencyIssue['reviewPriority'] : 'medium',
          excerpt: occurrences[0]?.excerpt ?? '',
          labels: [...new Set(occurrences.map((item) => item.label))],
          occurrences,
        }];
      });
      for (const modelIssue of modelIssues) {
        const modelIds = [...modelIssue.occurrences.map((item) => item.annotationId)].sort().join('\u0000');
        const matchingRuleIssue = issues.find((issue) => [...issue.occurrences.map((item) => item.annotationId)].sort().join('\u0000') === modelIds);
        if (matchingRuleIssue) {
          matchingRuleIssue.validatorTitle = modelIssue.validatorTitle;
          matchingRuleIssue.validatorReason = modelIssue.validatorReason;
          matchingRuleIssue.validatorType = modelIssue.validatorType;
          matchingRuleIssue.reviewPriority = modelIssue.reviewPriority;
        } else {
          issues.push(modelIssue);
        }
      }
      const rawUsage = result.usage as (Partial<TokenUsage> & { requests?: number }) | undefined;
      const usage = rawUsage ? {
        inputTokens: Number(rawUsage.inputTokens ?? 0),
        outputTokens: Number(rawUsage.outputTokens ?? 0),
        reasoningTokens: Number(rawUsage.reasoningTokens ?? 0),
        cachedInputTokens: Number(rawUsage.cachedInputTokens ?? 0),
        totalTokens: Number(rawUsage.totalTokens ?? 0),
      } : undefined;
      if (usage) recordUsage(result.provider as ProviderId, String(result.model ?? settings.model), usage, Math.max(1, Number(rawUsage?.requests ?? 1)));
      updateAgentActivity(activityId, {
        status: 'complete',
        detail: `validator_agent → reviewed ${summaries.length} annotation records; ${modelIssues.length} independent review finding${modelIssues.length === 1 ? '' : 's'}.`,
      });
      return { issues, usage, modelFindingCount: modelIssues.length };
    } catch (error) {
      updateAgentActivity(activityId, {
        status: 'error',
        detail: `validator_agent → independent review unavailable; keeping rule-based results. ${error instanceof Error ? error.message : ''}`,
      });
      return { issues, usage: undefined as TokenUsage | undefined, modelFindingCount: 0 };
    }
  };

  const resetUsage = () => {
    setUsage(emptyUsageTotals);
    setLastUsage(null);
    persistUsageTotals(emptyUsageTotals);
    setMessage('トークン使用量をリセットしました。');
  };

  const refreshCodexModels = useCallback(async () => {
    setCodexModelsLoading(true);
    setConnectionTest({ status: 'testing', message: 'Codex App Serverからモデル一覧を取得しています…' });
    try {
      const response = await apiFetch('/api/codex/models', undefined, settings.apiServerUrl);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Codex App Serverに接続できませんでした。');
      setCodexModels(result.models as CodexModel[]);
      const supported = (result.models as CodexModel[]).filter((item) =>
        ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].some((id) => item.id === id || item.model === id),
      );
      setConnectionTest({ status: 'success', message: supported.length ? `${supported.length}個のGPTモデルを検出しました。` : 'Codex接続済みですが、対象GPTモデルは現在のモデル一覧にありません。' });
    } catch (error) {
      setConnectionTest({ status: 'error', message: error instanceof Error ? error.message : 'Codex App Serverに接続できませんでした。' });
    } finally {
      setCodexModelsLoading(false);
    }
  }, [settings.apiServerUrl]);

  useEffect(() => {
    if (settings.provider === 'codex-app-server') {
      void refreshCodexModels();
    } else {
      setCodexModels([]);
    }
  }, [refreshCodexModels, settings.provider]);

  const testConnection = async () => {
    if (settings.provider === 'codex-app-server') {
      await refreshCodexModels();
      return;
    }
    setConnectionTest({ status: 'testing', message: 'API接続を確認しています…' });
    try {
      const response = await apiFetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: settings.model, settings: { ...settings, apiKey } }),
      }, settings.apiServerUrl);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'API接続を確認できませんでした。');
      recordUsage(result.provider as ProviderId, result.model as string, result.usage as TokenUsage | undefined);
      setConnectionTest({ status: 'success', message: `${result.model} に接続できました。` });
    } catch (error) {
      setConnectionTest({ status: 'error', message: error instanceof Error ? error.message : 'API接続を確認できませんでした。' });
    }
  };

  useEffect(() => {
    let live = true;
    Promise.all([
      apiFetch('/api/health', undefined, settings.apiServerUrl).then((response) => response.ok ? response.json() : null).catch(() => null),
      apiFetch('/api/demo', undefined, settings.apiServerUrl).then(async (response) => {
        if (!response.ok) throw new Error((await response.json()).error ?? 'サンプル文書を読み込めませんでした。');
        return response.json();
      }),
    ]).then(async ([status, sample]) => {
      if (!live) return;
      if (status) setHealth(status as ApiHealth);
      const nextDocument = parseDocument(sample as Record<string, unknown>);
      activeDocumentIdRef.current = nextDocument.documentId;
      activeFileTypeRef.current = nextDocument.fileType;
      setWorkbookSummary(null);
      setSpreadsheetChanges([]);
      setDocumentData(nextDocument);
      restoreRunHistory(nextDocument.fileName, nextDocument.sourceHash);
      const restored = await restoreDocumentWorkspace(nextDocument.fileName, nextDocument.pageCount, true, nextDocument.sourceHash);
      if (!restored.foundWorkspace && nextDocument.demo) setAnnotations(demoAnnotations);
      if (restored.sourceChanged) setMessage('同名文書の内容が前回の作業時から変わったため、旧注釈と承認待ち状態を混ぜずに外しました。保存した指示は引き継いでいます。');
      else if (restored.continuationInvalid) setMessage('文書の版を確認できなかったため、古い承認待ちRunは再開しませんでした。候補は残しています。');
    }).catch((error: unknown) => {
      if (live) setMessage(error instanceof Error ? error.message : 'サンプルを読み込めませんでした。');
    }).finally(() => {
      if (live) setLoadingDemo(false);
    });
    return () => { live = false; };
  }, []);

  const currentPage = documentData?.pages.find((page) => page.pageNumber === pageNumber) ?? null;
  const currentAnnotations = useMemo(() => annotations.filter((item) => item.pageNumber === pageNumber), [annotations, pageNumber]);
  const currentCandidates = useMemo(() => candidates.filter((item) => item.pageNumber === pageNumber), [candidates, pageNumber]);
  const selectedAnnotation = annotations.find((item) => item.id === selectedId) ?? null;
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    const documentId = documentData?.documentId;
    const page = documentData?.pages.find((item) => item.pageNumber === pageNumber);
    if (!documentId || !page) {
      setPreviewUrl(null);
      setPreviewLoading(false);
      return;
    }
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setPreviewUrl(null);
    setPreviewError('');
    setPreviewLoading(true);
    apiFetch(`/api/documents/${documentId}/pages/${page.pageNumber}.svg`, { signal: controller.signal }, settings.apiServerUrl)
      .then(async (response) => {
        if (!response.ok) throw new Error('ページ画像を取得できませんでした。文書を開き直してください。');
        return response.text();
      })
      .then((svg) => {
        const url = createSvgPreviewUrl(svg);
        if (controller.signal.aborted) {
          revokeSvgPreviewUrl(url);
          return;
        }
        objectUrl = url;
        setPreviewUrl(url);
        setPreviewLoading(false);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          const detail = error instanceof Error ? error.message : 'ページ画像を取得できませんでした。';
          setPreviewError(detail);
          setPreviewLoading(false);
          setMessage(detail);
        }
      });
    return () => {
      controller.abort();
      if (objectUrl) revokeSvgPreviewUrl(objectUrl);
    };
  }, [documentData?.documentId, documentData?.pages, pageNumber, settings.apiServerUrl]);

  useEffect(() => {
    if (!agentViewport || !previewUrl) return;
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const area = pageScrollAreaRef.current;
        if (!area) return;
        const horizontalRange = Math.max(0, 1 - agentViewport.width);
        const verticalRange = Math.max(0, 1 - agentViewport.height);
        area.scrollLeft = horizontalRange
          ? Math.round((area.scrollWidth - area.clientWidth) * agentViewport.x / horizontalRange)
          : 0;
        area.scrollTop = verticalRange
          ? Math.round((area.scrollHeight - area.clientHeight) * agentViewport.y / verticalRange)
          : 0;
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [agentViewport, agentViewportScale, previewUrl]);

  const reopenDocument = async () => {
    if (!documentData?.demo) {
      fileInputRef.current?.click();
      return;
    }
    setPreviewError('');
    setPreviewLoading(true);
    try {
      const response = await apiFetch('/api/demo', undefined, settings.apiServerUrl);
      if (!response.ok) throw new Error('サンプル文書を開き直せませんでした。');
      const refreshed = parseDocument(await response.json() as Record<string, unknown>);
      setDocumentData(refreshed);
      setPageNumber((current) => clamp(current, 1, refreshed.pageCount));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : '文書を開き直せませんでした。');
      setPreviewLoading(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if ((target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) || !selectedId) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        setAnnotations((existing) => existing.filter((item) => item.id !== selectedId));
        setSelectedId(null);
        setSaved(false);
        setMessage('注釈を削除しました。');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedId]);

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(''), 4500);
    return () => window.clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (activeTab !== 'ai' || working || !candidates.length) return;
    window.requestAnimationFrame(() => candidateSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [activeTab, candidates.length, working]);

  useEffect(() => {
    const list = activityLogRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [agentActivity]);

  const onFileSelected = useCallback(async (file?: File) => {
    if (!file) return;
    activeDocumentIdRef.current = null;
    activeFileTypeRef.current = null;
    setWorkbookSummary(null);
    setSpreadsheetChanges([]);
    activeAgentRunRef.current = null;
    setUploading(true);
    setCandidates([]);
    setRejectedCandidates([]);
    setConsistencyIssues([]);
    setAgentContinuation(null);
    clearAgentActivity();
    setAgentStatus('ready');
    setSelectedId(null);
    setMessage('文書または画像をSVGページに変換しています…');
    const form = new FormData();
    form.append('file', file);
    try {
      const response = await apiFetch('/api/convert', { method: 'POST', body: form }, settings.apiServerUrl);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? '文書を変換できませんでした。');
      const next = parseDocument(result as Record<string, unknown>);
      activeDocumentIdRef.current = next.documentId;
      activeFileTypeRef.current = next.fileType;
      setWorkbookSummary(null);
      setSpreadsheetChanges([]);
      setDocumentData(next);
      if (next.fileType.toLowerCase() === 'xlsx') void refreshWorkbookSummary(next.documentId).catch((error) => setMessage(error instanceof Error ? error.message : 'Excelブックを読み込めませんでした。'));
      restoreRunHistory(next.fileName, next.sourceHash);
      setPageNumber(1);
      clearAgentViewport();
      const restoredWorkspace = await restoreDocumentWorkspace(next.fileName, next.pageCount, true, next.sourceHash);
      setAiMode(null);
      setMessage(restoredWorkspace.sourceChanged
        ? `${next.fileName} は同名の前回ファイルと内容が異なるため、古い注釈を表示せず新しい作業として開きました。`
        : restoredWorkspace.continuationInvalid
          ? `${next.fileName} を読み込みましたが、元の文書版を確認できない承認待ちRunは再開しませんでした。`
          : `${next.fileName} を読み込みました。${next.pageCount}ページを変換しました。`);
      setActiveTab('annotations');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '変換に失敗しました。');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [settings.apiServerUrl]);

  const onGuidelineFileSelected = async (file?: File) => {
    if (!file) return;
    setGuidelineImporting(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const response = await apiFetch('/api/convert', { method: 'POST', body: form }, settings.apiServerUrl);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'ガイドライン文書を開けませんでした。');
      const guidelineDocument = parseDocument(payload as Record<string, unknown>);
      const extracted: string[] = [];
      for (const page of guidelineDocument.pages.slice(0, 50)) {
        const pageResponse = await apiFetch(`/api/documents/${guidelineDocument.documentId}/pages/${page.pageNumber}.svg`, undefined, settings.apiServerUrl);
        if (!pageResponse.ok) throw new Error(`ガイドラインの${page.pageNumber}ページを取得できませんでした。`);
        const svg = await pageResponse.text();
        const pageText = extractSvgTextBlocks(svg).map((block) => block.text).join('\n').trim();
        if (pageText) extracted.push(`--- ${page.pageNumber}ページ ---\n${pageText}`);
        if (extracted.join('\n').length >= 4000) break;
      }
      const guidelineText = extracted.join('\n\n').trim();
      if (!guidelineText) {
        setMessage('ガイドライン文書からテキストを抽出できませんでした。文字が選択できるPDF / Office文書を使用するか、内容を直接入力してください。');
        return;
      }
      const next = `${guidelines.trim()}${guidelines.trim() ? '\n\n' : ''}[${file.name}]\n${guidelineText}`.slice(0, 4000);
      setGuidelines(next);
      invalidateTaskPlan();
      setSaved(false);
      setMessage(`${file.name} からガイドライン文書のテキストを読み込みました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'ガイドライン文書を読み込めませんでした。');
    } finally {
      setGuidelineImporting(false);
      if (guidelineFileInputRef.current) guidelineFileInputRef.current.value = '';
    }
  };

  const connectWorkspaceFolder = async () => {
    if (!desktop) {
      workspaceFolderInputRef.current?.click();
      return;
    }
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const previous = workspaceProjectRef.current;
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'プロジェクトフォルダーを選択',
        ...(previous?.rootPath ? { defaultPath: previous.rootPath } : {}),
      });
      if (typeof selected !== 'string') return;
      const documents = await enumerateDesktopWorkspace(selected);
      const projectId = selected;
      const oldDocuments = previous?.id === projectId ? new Map(previous.documents.map((item) => [item.relativePath, item])) : new Map<string, WorkspaceDocumentEntry>();
      const project: WorkspaceProject = {
        id: projectId,
        name: nativeDirectoryName(selected),
        source: 'desktop',
        rootPath: selected,
        connected: true,
        documents: documents.map((entry) => {
          const old = oldDocuments.get(entry.relativePath);
          return old ? { ...entry, selected: old.selected, status: old.status, ...(old.error ? { error: old.error } : {}), ...(old.sourceHash ? { sourceHash: old.sourceHash } : {}) } : entry;
        }),
      };
      setWorkspaceSessionIds({});
      persistWorkspaceProject(project);
      setActiveTab('workspace');
      setMessage(`${project.name} をプロジェクトとして開きました。対応文書 ${documents.length} 件。`);
      if (documents.length >= maxWorkspaceDocuments) setMessage(`先頭の${maxWorkspaceDocuments}件を表示しています。対象フォルダーを分けてください。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'プロジェクトフォルダーを開けませんでした。');
    }
  };

  const onWorkspaceFolderSelected = (fileList?: FileList | null) => {
    if (!fileList?.length) return;
    const files = Array.from(fileList).filter((file) => isSupportedWorkspaceFile(file.webkitRelativePath || file.name));
    if (!files.length) {
      setMessage('選択フォルダーに対応文書がありません。PDF、Office文書、画像を選んでください。');
      return;
    }
    const rootName = files[0]?.webkitRelativePath.split('/')[0] || 'Project';
    const previous = workspaceProjectRef.current;
    const projectId = `browser:${rootName}`;
    const oldDocuments = previous?.id === projectId ? new Map(previous.documents.map((item) => [item.relativePath, item])) : new Map<string, WorkspaceDocumentEntry>();
    workspaceBrowserFilesRef.current.clear();
    setWorkspaceSessionIds({});
    const documents = files.slice(0, maxWorkspaceDocuments).map((file) => {
      const relativePath = (file.webkitRelativePath || file.name).replaceAll('\\', '/');
      const old = oldDocuments.get(relativePath);
      const entry: WorkspaceDocumentEntry = {
        id: relativePath,
        relativePath,
        selected: old?.selected ?? true,
        status: old?.status ?? 'ready',
        size: file.size,
        lastModified: file.lastModified,
        ...(old?.error ? { error: old.error } : {}),
        ...(old?.sourceHash ? { sourceHash: old.sourceHash } : {}),
      };
      workspaceBrowserFilesRef.current.set(entry.id, file);
      return entry;
    }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    persistWorkspaceProject({ id: projectId, name: rootName, source: 'browser', connected: true, documents });
    setActiveTab('workspace');
    setMessage(`${rootName} をプロジェクトとして開きました。対応文書 ${documents.length} 件。`);
    if (files.length > maxWorkspaceDocuments) setMessage(`先頭の${maxWorkspaceDocuments}件を読み込みました。対象フォルダーを分けてください。`);
    if (workspaceFolderInputRef.current) workspaceFolderInputRef.current.value = '';
  };

  const handleFileDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    fileDragDepthRef.current += 1;
    setFileDragActive(true);
  };

  const handleFileDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleFileDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setFileDragActive(false);
  };

  const handleFileDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    fileDragDepthRef.current = 0;
    setFileDragActive(false);
    if (uploading) {
      setMessage('現在の文書処理が終わってから、次のファイルを開いてください。');
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    const supportedFiles = files.filter((file) => isSupportedWorkspaceFile(file.webkitRelativePath || file.name));
    if (!supportedFiles.length) {
      setMessage('対応しているPDF、Office文書、画像ファイルをドロップしてください。');
      return;
    }
    if (supportedFiles.length > 1) {
      setMessage('複数文書の一括処理には、左側の「プロジェクト」からフォルダーを開いてください。');
      return;
    }
    void onFileSelected(supportedFiles[0]);
  };

  const openWorkspaceDocument = async (entry: WorkspaceDocumentEntry, restoreTask = true) => {
    if (documentData && documentData.fileName !== entry.relativePath) saveCurrentDocumentWorkspace(documentData.fileName);
    setUploading(true);
    setPreviewError('');
    setSelectedId(null);
    clearAgentActivity();
    setConsistencyIssues([]);
    try {
      let contents: Blob | undefined = workspaceBrowserFilesRef.current.get(entry.id);
      if (!contents && entry.nativePath && desktop) {
        const { readFile } = await import('@tauri-apps/plugin-fs');
        const bytes = await readFile(entry.nativePath);
        contents = new Blob([Uint8Array.from(bytes).buffer]);
      }
      if (!contents) throw new Error('フォルダー内の元ファイルにアクセスできません。プロジェクトフォルダーを再接続してください。');
      const form = new FormData();
      form.append('file', contents, entry.relativePath.split('/').at(-1) || entry.relativePath);
      form.append('relativePath', entry.relativePath);
      const response = await apiFetch('/api/convert', { method: 'POST', body: form }, settings.apiServerUrl);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `${entry.relativePath} を変換できませんでした。`);
      const next = parseDocument(result as Record<string, unknown>);
      setWorkspaceSessionIds((current) => ({ ...current, [entry.id]: next.documentId }));
      const sourceChangedInProject = Boolean(entry.sourceHash && next.sourceHash && entry.sourceHash !== next.sourceHash);
      updateWorkspaceDocument(entry.id, { sourceHash: next.sourceHash, ...(sourceChangedInProject ? { status: 'ready', error: undefined } : {}) });
      activeDocumentIdRef.current = next.documentId;
      activeFileTypeRef.current = next.fileType;
      setWorkbookSummary(null);
      setSpreadsheetChanges([]);
      setDocumentData(next);
      if (next.fileType.toLowerCase() === 'xlsx') await refreshWorkbookSummary(next.documentId);
      setPageNumber(1);
      clearAgentViewport();
      const restoredWorkspace = await restoreDocumentWorkspace(next.fileName, next.pageCount, restoreTask, next.sourceHash);
      restoreRunHistory(next.fileName, next.sourceHash);
      setAiMode(null);
      setActiveTab('ai');
      setMessage(restoredWorkspace.sourceChanged
        ? `${entry.relativePath} は前回処理したファイルから変更されています。古い注釈は引き継がず、新しい内容に再実行してください。`
        : restoredWorkspace.continuationInvalid
          ? `${entry.relativePath} を開きましたが、元の文書版を確認できない承認待ちRunは再開しませんでした。`
          : `${entry.relativePath} を開きました。${next.pageCount}ページ。`);
      await waitForRender();
      return next;
    } finally {
      setUploading(false);
    }
  };

  const runWorkspaceBatch = async () => {
    const project = workspaceProjectRef.current;
    if (!project || !project.connected) {
      setMessage('プロジェクトフォルダーを開くか、再接続してください。');
      return;
    }
    const targets = project.documents.filter((item) => item.selected);
    if (!targets.length) {
      setMessage('実行する文書にチェックを入れてください。');
      return;
    }
    if (!prompt.trim()) {
      setMessage('AIへの指示を入力してください。');
      setActiveTab('ai');
      return;
    }
    if (documentData) saveCurrentDocumentWorkspace(documentData.fileName);
    const task = { prompt, guidelines, correction, mode: agentMode };
    workspaceBatchActiveRef.current = true;
    workspaceBatchCancelledRef.current = false;
    setBatchProgress({ status: 'running', current: 0, total: targets.length, fileName: '' });
    setActiveTab('ai');
    let failed = 0;
    let reviewed = 0;
    let processedCount = 0;
    for (const [index, entry] of targets.entries()) {
      if (workspaceBatchCancelledRef.current) break;
      setBatchProgress({ status: 'running', current: index + 1, total: targets.length, fileName: entry.relativePath });
      updateWorkspaceDocument(entry.id, { status: 'running', error: undefined });
      try {
        await openWorkspaceDocument(entry, false);
        setPrompt(task.prompt);
        setGuidelines(task.guidelines);
        setCorrection(task.correction);
        setAgentMode(task.mode);
        await waitForRender();
        const outcome = await analyzeAgentRef.current?.('all');
        await waitForRender();
        const activeDocumentName = workspaceProjectRef.current?.documents.find((item) => item.id === entry.id)?.relativePath ?? entry.relativePath;
        saveCurrentDocumentWorkspace(activeDocumentName);
        if (outcome?.status === 'error' || !outcome) {
          failed += 1;
          updateWorkspaceDocument(entry.id, { status: 'error', error: 'この文書のAgent実行を完了できませんでした。' });
        } else if (outcome.status === 'waiting') {
          reviewed += 1;
          updateWorkspaceDocument(entry.id, { status: 'review' });
        } else {
          updateWorkspaceDocument(entry.id, { status: 'complete' });
        }
      } catch (error) {
        failed += 1;
        updateWorkspaceDocument(entry.id, { status: 'error', error: error instanceof Error ? error.message : '文書を処理できませんでした。' });
      }
      processedCount += 1;
    }
    workspaceBatchActiveRef.current = false;
    const wasCancelled = workspaceBatchCancelledRef.current;
    const status = wasCancelled ? 'stopped' : 'complete';
    setBatchProgress({ status, current: processedCount, total: targets.length, fileName: '' });
    setMessage(`${wasCancelled ? '一括実行を停止しました' : 'プロジェクトの一括実行が完了しました'}。対象 ${targets.length}件、確認待ち ${reviewed}件、失敗 ${failed}件。`);
  };

  const stopWorkspaceBatch = () => {
    workspaceBatchCancelledRef.current = true;
    setMessage('現在の文書の処理後に一括実行を停止します。');
  };

  const pointFromEvent = (event: PointerEvent<HTMLDivElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
    };
  };

  const onCanvasPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (activeTool === 'select') return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    setDragStart(point);
    setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const onCanvasPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart || activeTool === 'select') return;
    const point = pointFromEvent(event);
    const left = Math.min(point.x, dragStart.x);
    const top = Math.min(point.y, dragStart.y);
    setDraft({ x: left, y: top, width: Math.abs(point.x - dragStart.x), height: Math.abs(point.y - dragStart.y) });
  };

  const onCanvasPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragStart || activeTool === 'select') return;
    const point = pointFromEvent(event);
    const x = Math.min(point.x, dragStart.x);
    const y = Math.min(point.y, dragStart.y);
    const width = Math.max(0.03, Math.abs(point.x - dragStart.x));
    const height = Math.max(0.025, Math.abs(point.y - dragStart.y));
    const next: Annotation = {
      id: crypto.randomUUID(), pageNumber, x, y,
      width: Math.min(width, 1 - x), height: Math.min(height, 1 - y),
      label: activeTool === 'note' ? 'テキスト注釈' : '要確認',
      note: '', color: activeTool === 'note' ? '#557ec2' : '#178b87', source: 'manual', reviewPriority: 'low', reason: '人がページ上で追加しました。', requiresReview: false, reviewedByHuman: true, reviewOutcome: 'approved',
    };
    setAnnotations((items) => [...items, next]);
    setSelectedId(next.id);
    setActiveTab('annotations');
    setDragStart(null);
    setDraft(null);
    setActiveTool('select');
    setSaved(false);
  };

  const addCandidate = (candidate: AnnotationCandidate) => {
    const approvedCandidate = { ...candidate };
    delete approvedCandidate.approvalRunId;
    delete approvedCandidate.approvalId;
    updateDocumentAnnotationRecords((current) => resolveCandidateReview(current, candidate.id, {
      type: 'approve', annotation: { ...approvedCandidate, source: 'ai', requiresReview: false, reviewedByHuman: true, reviewOutcome: 'approved' },
    }));
    setCandidateCorrections((items) => { const next = { ...items }; delete next[candidate.id]; return next; });
    setCandidateCorrectionScopes((items) => { const next = { ...items }; delete next[candidate.id]; return next; });
    addAgentActivity('Annotating', `人が承認: ${candidate.label}`, 'complete', candidate.pageNumber);
    setAgentStatus(candidates.length > 1 ? 'waiting' : 'complete');
    setSelectedId(candidate.id);
    setActiveTab('annotations');
    setSaved(false);
    if (documentData) autoSaveDocumentWorkspace(documentData.fileName);
    continueAfterHumanDecision(candidate, 'approved');
  };

  const correctCandidate = (candidate: AnnotationCandidate) => {
    const edit = candidateCorrections[candidate.id] ?? { label: candidate.label, note: candidate.note };
    const label = edit.label.trim() || candidate.label;
    const note = edit.note.trim() || candidate.note;
    if (label === candidate.label && note === candidate.note) {
      setMessage('ラベルまたはメモを変更してから確定してください。');
      return;
    }
    const corrected: Annotation = {
      ...candidate,
      label,
      note,
      source: 'manual',
      requiresReview: false,
      reviewedByHuman: true,
      reviewOutcome: 'corrected',
      reason: `人が内容を修正して確定。AIの提案理由: ${candidate.reason}`.slice(0, 500),
    };
    delete (corrected as AnnotationCandidate).approvalRunId;
    delete (corrected as AnnotationCandidate).approvalId;
    updateDocumentAnnotationRecords((current) => resolveCandidateReview(current, candidate.id, { type: 'correct', annotation: corrected }));
    setCandidateCorrections((items) => { const next = { ...items }; delete next[candidate.id]; return next; });
    setCandidateCorrectionScopes((items) => { const next = { ...items }; delete next[candidate.id]; return next; });
    addAgentActivity('Annotating', `人が候補を修正して確定: ${candidate.label} → ${label}`, 'complete', candidate.pageNumber);
    setAgentStatus(candidates.length > 1 ? 'waiting' : 'complete');
    setSaved(false);
    setMessage(`P.${candidate.pageNumber}の候補を「${label}」に修正しました。`);
    if (documentData) autoSaveDocumentWorkspace(documentData.fileName);
    const scope = candidateCorrectionScopes[candidate.id] ?? 'item';
    const decisionText = `P.${candidate.pageNumber} ${candidate.label} → ${label}: ${note}`.slice(0, 500);
    continueAfterHumanDecision(candidate, 'approved', { decisionText, sdkApproved: false, scope });
  };

  const rejectCandidate = (candidate: AnnotationCandidate) => {
    updateDocumentAnnotationRecords((current) => resolveCandidateReview(current, candidate.id, { type: 'reject', candidate }));
    setCandidateCorrections((items) => { const next = { ...items }; delete next[candidate.id]; return next; });
    setCandidateCorrectionScopes((items) => { const next = { ...items }; delete next[candidate.id]; return next; });
    addAgentActivity('Reviewing', `人が却下: ${candidate.label}`, 'complete', candidate.pageNumber);
    setAgentStatus(candidates.length > 1 ? 'waiting' : 'complete');
    setSaved(false);
    setMessage('確認候補を却下しました。');
    if (documentData) autoSaveDocumentWorkspace(documentData.fileName);
    continueAfterHumanDecision(candidate, 'rejected');
  };

  function continueAfterHumanDecision(candidate: AnnotationCandidate, decision: 'approved' | 'rejected', options?: { decisionText?: string; sdkApproved?: boolean; scope?: HumanDecisionScope }) {
    const continuation = agentContinuation;
    if (continuation && candidate.pageNumber !== continuation.blockedPage) return;
    const action = options?.sdkApproved === false ? 'correct' : decision === 'approved' ? 'approve' : 'reject';
    const requestedScope = options?.scope ?? 'item';
    const scope: HumanDecisionScope = requestedScope === 'remaining_pages' && Boolean(continuation?.remainingPages.length)
      ? 'remaining_pages'
      : 'item';
    const decisionText = (options?.decisionText ?? `人が${decision === 'approved' ? '確定' : '却下'}: P.${candidate.pageNumber} ${candidate.label}: ${candidate.excerpt || candidate.note}`).slice(0, 1000);
    const historyRun = continuation?.runHistoryId
      ? agentRunHistoryRef.current.find((run) => run.id === continuation.runHistoryId)
      : agentRunHistoryRef.current.find((run) => run.status === 'waiting' && run.fileName === documentData?.fileName && run.sourceHash === documentData?.sourceHash);
    const previousDecisions = [...new Map([...(historyRun?.humanDecisions ?? []), ...(continuation?.humanDecisions ?? [])].map((item) => [item.id, item])).values()];
    const previousRuleVersion = Math.max(historyRun?.lastHumanRuleVersion ?? 0, continuation?.lastHumanRuleVersion ?? 0);
    const appliesFromPage = scope === 'remaining_pages' ? continuation?.remainingPages[0] : undefined;
    const humanDecision = createHumanDecisionRecord(previousDecisions, {
      id: crypto.randomUUID(),
      action,
      scope,
      sourceCandidateId: candidate.id,
      pageNumber: candidate.pageNumber,
      text: decisionText,
      createdAt: Date.now(),
      ...(appliesFromPage ? { appliesFromPage } : {}),
    }, previousRuleVersion);
    const humanDecisions = [...previousDecisions, humanDecision].slice(-100);
    const lastHumanRuleVersion = Math.max(previousRuleVersion, humanDecision.ruleVersion ?? 0);
    const decisionContexts = recordHumanDecision(continuation ?? {}, decisionText, humanDecision);
    if (!continuation) {
      const hasPendingReview = candidates.some((item) => item.id !== candidate.id)
        || spreadsheetChanges.some((change) => change.requiresReview && !change.approved && !change.rejected)
        || annotationOperations.some((operation) => operation.status === 'needs_review');
      const latestWaiting = agentRunHistoryRef.current.find((run) => run.status === 'waiting' && run.fileName === documentData?.fileName && run.sourceHash === documentData?.sourceHash);
      if (latestWaiting) {
        const updatedDecisions = readHumanDecisionRecords([...(latestWaiting.humanDecisions ?? []), humanDecision]);
        const outcome = resolveHumanReviewStatus(hasPendingReview, latestWaiting.pageCoverageTargets, latestWaiting.pageCoverage);
        const updatedRun: AgentRunHistory = {
          ...latestWaiting,
          humanDecisions: updatedDecisions,
          lastHumanRuleVersion,
          status: outcome.status,
          endedAt: Date.now(),
          summary: hasPendingReview
            ? 'Human decision recorded; additional reviews remain.'
            : outcome.coverageStillNeedsReview
              ? 'Human review is resolved; the page coverage list still has items to inspect.'
              : 'Human review is complete.',
        };
        persistRunHistoryEntry(updatedRun);
        if (activeAgentRunRef.current?.id === updatedRun.id) activeAgentRunRef.current = updatedRun;
      }
      return;
    }
    const actionLabel = options?.sdkApproved === false ? '修正' : decision === 'approved' ? '承認' : '却下';
    const anotherCandidateOnBlockedPage = candidates.some((item) => item.id !== candidate.id && item.pageNumber === continuation.blockedPage);
    const currentApprovalDecision = candidate.approvalId && candidate.approvalRunId === continuation.approvalRunId
      ? { approved: options?.sdkApproved ?? decision === 'approved', note: decisionContexts.pageDecisionContext }
      : continuation.pendingApprovalDecision;
    const updatedContinuation = {
      ...continuation,
      ...decisionContexts,
      humanDecisions,
      lastHumanRuleVersion,
      pendingApprovalDecision: currentApprovalDecision,
      ...(options?.sdkApproved === false && scope === 'remaining_pages' ? { humanCorrections: (continuation.humanCorrections ?? 0) + 1 } : {}),
    };
    if (historyRun) {
      const updatedRun = { ...historyRun, humanDecisions, lastHumanRuleVersion };
      persistRunHistoryEntry(updatedRun);
      if (activeAgentRunRef.current?.id === updatedRun.id) activeAgentRunRef.current = updatedRun;
    }
    if (anotherCandidateOnBlockedPage) {
      setAgentContinuation(updatedContinuation);
      setAgentStatus('waiting');
      return;
    }
    if (continuation.approvalRunId && continuation.approvalId && currentApprovalDecision) {
      addAgentActivity('Continuing', `人の${actionLabel}を反映し、Agent SDKの同じRunを再開します。`, 'complete', candidate.pageNumber);
      setAgentContinuation(null);
      setAgentStatus('running');
      void resumeAgentRef.current?.(updatedContinuation, {
        runId: continuation.approvalRunId,
        approvalId: continuation.approvalId,
        approved: currentApprovalDecision.approved,
        note: decisionContexts.pageDecisionContext,
      });
      return;
    }
    if (continuation.remainingPages.length) {
      addAgentActivity('Continuing', `人の${actionLabel}を反映し、P.${continuation.remainingPages[0]}から残りのページを再開します。`, 'complete', candidate.pageNumber);
      setAgentContinuation(null);
      setAgentStatus('running');
      void resumeAgentRef.current?.(updatedContinuation);
    } else {
      const hasPendingReview = candidates.some((item) => item.id !== candidate.id)
        || spreadsheetChanges.some((change) => change.requiresReview && !change.approved && !change.rejected)
        || annotationOperations.some((operation) => operation.status === 'needs_review');
      const outcome = resolveHumanReviewStatus(hasPendingReview, historyRun?.pageCoverageTargets, historyRun?.pageCoverage);
      if (historyRun) {
        const updatedRun: AgentRunHistory = {
          ...historyRun,
          humanDecisions,
          lastHumanRuleVersion,
          status: outcome.status,
          endedAt: Date.now(),
          summary: hasPendingReview
            ? 'Human decision recorded; additional reviews remain.'
            : outcome.coverageStillNeedsReview
              ? 'Human review is resolved; the page coverage list still has items to inspect.'
              : 'Human review is complete.',
        };
        persistRunHistoryEntry(updatedRun);
        if (activeAgentRunRef.current?.id === updatedRun.id) activeAgentRunRef.current = updatedRun;
      }
      setAgentContinuation(null);
      setAgentStatus(outcome.status);
      if (documentData) autoSaveDocumentWorkspace(documentData.fileName);
    }
  }

  const decideSpreadsheetChange = (change: SpreadsheetCellChange, approved: boolean) => {
    const continuation = agentContinuation;
    if (!continuation?.approvalRunId || continuation.approvalId !== change.id) return;
    const note = `人が${approved ? '承認' : '却下'}: ${change.sheetName}!${change.range} ${change.operation}`.slice(0, 500);
    setSpreadsheetChanges((items) => items.map((item) => item.id === change.id ? { ...item, ...(approved ? {} : { rejected: true }) } : item));
    setAgentContinuation(null);
    setAgentStatus('running');
    addAgentActivity('Continuing', `人が${change.sheetName}!${change.range}の表変更を${approved ? '承認' : '却下'}し、同じAgent Runを再開します。`, 'complete', continuation.blockedPage);
    void resumeAgentRef.current?.({ ...continuation, pendingApprovalDecision: { approved, note } }, {
      runId: continuation.approvalRunId,
      approvalId: continuation.approvalId,
      approved,
      note,
    });
  };

  const decideAnnotationOperation = (operation: DocumentAnnotationOperation, approved: boolean) => {
    const continuation = agentContinuation;
    if (!continuation?.approvalRunId || !operation.approvalId || continuation.approvalId !== operation.approvalId) return;
    const note = `人が注釈の${operation.operation === 'update' ? '変更' : '削除'}を${approved ? '承認' : '却下'}: ${operation.existingLabel}。${operation.reason}`.slice(0, 500);
    setAgentContinuation(null);
    setAgentStatus('running');
    addAgentActivity('Continuing', `人が ${operation.existingLabel} の${operation.operation === 'update' ? '変更' : '削除'}を${approved ? '承認' : '却下'}し、同じAgent Runを再開します。`, 'complete', operation.pageNumber);
    void resumeAgentRef.current?.({ ...continuation, pendingApprovalDecision: { approved, note } }, {
      runId: continuation.approvalRunId,
      approvalId: operation.approvalId,
      approved,
      note,
    });
  };

  const exportAnnotatedWorkbook = async () => {
    if (!documentData || documentData.fileType.toLowerCase() !== 'xlsx') return;
    try {
      const documentAnnotations = normalizeDocumentAnnotationRecords({ documentId: documentData.documentId, sourceHash: documentData.sourceHash, fileType: documentData.fileType, ...documentAnnotationView });
      const response = await apiFetch(`/api/documents/${encodeURIComponent(documentData.documentId)}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'native-annotated', documentAnnotations }),
      }, settings.apiServerUrl);
      if (!response.ok) throw new Error((await response.json()).error ?? '注釈済みExcelを書き出せませんでした。');
      const baseName = documentData.fileName.replace(/\.xlsx$/i, '').split('/').at(-1) || 'workbook';
      downloadBlob(await response.blob(), `${baseName}-annotated.xlsx`);
      addAgentActivity('Exporting', '承認済みのセル変更を別のExcelブックに書き出しました。');
      setMessage('元ファイルを変更せず、注釈済みExcelをダウンロードしました。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '注釈済みExcelを書き出せませんでした。');
    }
  };

  const workspaceDocumentAnnotations = (entry: WorkspaceDocumentEntry, documentId: string) => {
    const fileType = entry.relativePath.split('.').at(-1)?.toUpperCase() ?? 'PDF';
    const sourceHash = workspaceProjectRef.current?.documents.find((item) => item.id === entry.id)?.sourceHash
      ?? (documentData?.fileName === entry.relativePath ? documentData.sourceHash : undefined);
    if (documentData?.documentId === documentId && documentData.fileName === entry.relativePath) {
      return normalizeDocumentAnnotationRecords({ documentId, sourceHash, fileType, ...documentAnnotationView });
    }
    try {
      const raw = readWorkspaceState(window.localStorage, entry.relativePath, sourceHash).raw;
      return readStoredDocumentAnnotationRecords(raw, documentId, fileType, sourceHash);
    } catch {
      return [];
    }
  };

  const rememberPreparedExports = (value: unknown, documentId: string) => {
    if (!documentData) return;
    const artifacts = restorePreparedDocumentExports(value, documentData.fileName).filter((artifact) => artifact.documentId === documentId);
    if (artifacts.length) setPreparedDocumentExports((current) => mergePreparedDocumentExports(current, artifacts));
  };

  const preparedExportsForDocument = (sourceDocumentName: string) => {
    let saved: PreparedDocumentExport[] = [];
    try {
      const raw = readWorkspaceState(window.localStorage, sourceDocumentName).raw;
      if (raw) saved = restorePreparedDocumentExports((JSON.parse(raw) as { preparedExports?: unknown }).preparedExports, sourceDocumentName);
    } catch { /* Ignore a damaged local workspace record; current in-memory exports remain available. */ }
    return mergePreparedDocumentExports(saved, restorePreparedDocumentExports(preparedDocumentExports, sourceDocumentName));
  };

  const downloadPreparedExport = async (artifact: PreparedDocumentExport) => {
    try {
      const response = await apiFetch(`/api/document-exports/${encodeURIComponent(artifact.id)}`, undefined, settings.apiServerUrl);
      if (!response.ok) throw new Error((await response.json()).error ?? 'Agentの書き出しファイルが見つからないか、有効期限が切れました。');
      downloadBlob(await response.blob(), artifact.fileName);
      setMessage(`${artifact.fileName} をダウンロードしました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Agentの書き出しをダウンロードできませんでした。');
    }
  };

  const hasWorkspaceNativeAnnotations = (entry: WorkspaceDocumentEntry, records: DocumentAnnotationRecord[]) => {
    const fileType = entry.relativePath.split('.').at(-1)?.toLowerCase();
    return records.some((record) => ['auto', 'approved', 'corrected'].includes(record.status) && (
      fileType === 'xlsx' ? record.target.kind === 'sheet' && Boolean(record.operation)
        : record.target.kind === 'page' || record.target.kind === 'slide'
    ));
  };

  const exportWorkspaceDocument = async (entry: WorkspaceDocumentEntry, format: 'native-annotated' | 'annotations-json' | 'annotations-csv') => {
    const documentId = workspaceSessionIds[entry.id];
    if (!documentId) return;
    const documentAnnotations = workspaceDocumentAnnotations(entry, documentId);
    if (format === 'native-annotated' && !hasWorkspaceNativeAnnotations(entry, documentAnnotations)) {
      setMessage(`${entry.relativePath} に確定済みの注釈がありません。確認待ち候補はJSONまたはCSVで保存できます。`);
      return;
    }
    if (format !== 'native-annotated' && !documentAnnotations.length) {
      setMessage(`${entry.relativePath} に書き出せる注釈がありません。`);
      return;
    }
    try {
      const response = await apiFetch(`/api/documents/${encodeURIComponent(documentId)}/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, documentAnnotations }),
      }, settings.apiServerUrl);
      if (!response.ok) throw new Error((await response.json()).error ?? `${entry.relativePath} を書き出せませんでした。文書を開き直して再実行してください。`);
      const extension = entry.relativePath.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? 'pdf';
      const nativeExtension = extension === 'xlsx' || extension === 'docx' || extension === 'pptx' ? extension : 'pdf';
      const suffix = format === 'native-annotated' ? `-annotated.${nativeExtension}` : format === 'annotations-json' ? '-annotations.json' : '-annotations.csv';
      const baseName = entry.relativePath.replace(/\.[^.]+$/, '').split(/[\\/]/).at(-1) || 'document';
      downloadBlob(await response.blob(), `${baseName}${suffix}`);
      const description = format === 'native-annotated' ? '注釈を元形式の新しいコピーに書き出し' : format === 'annotations-json' ? '構造化JSONを書き出し' : 'CSVを書き出し';
      addAgentActivity('Exporting', `${entry.relativePath} の${description}を行いました。`);
      setMessage(`${entry.relativePath} を書き出しました。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `${entry.relativePath} を書き出せませんでした。`);
    }
  };

  const workspaceExportActions = (entry: WorkspaceDocumentEntry) => {
    const documentId = workspaceSessionIds[entry.id];
    const records = documentId ? workspaceDocumentAnnotations(entry, documentId) : [];
    const canExportNative = hasWorkspaceNativeAnnotations(entry, records);
    const hasRecords = records.length > 0;
    const prepared = preparedExportsForDocument(entry.relativePath);
    if (!hasRecords && !prepared.length) return null;
    const isWorkbook = /\.xlsx$/i.test(entry.relativePath);
    return (
      <div className="workspace-export-actions" role="group" aria-label={`${entry.relativePath}を書き出す`}>
        {documentId && <>
          <button className="workspace-export-button" type="button" aria-label={`${entry.relativePath}の注釈付きコピーを保存`} title={isWorkbook ? '承認済みのExcelコピー' : '注釈付きコピー'} disabled={!canExportNative} onClick={() => void exportWorkspaceDocument(entry, 'native-annotated')}><Download size={11} /><span>{isWorkbook ? 'Excel' : '注釈付き'}</span></button>
          <button className="workspace-export-button" type="button" aria-label={`${entry.relativePath}の注釈CSVを保存`} disabled={!hasRecords} onClick={() => void exportWorkspaceDocument(entry, 'annotations-csv')}><span>CSV</span></button>
          <button className="workspace-export-button" type="button" aria-label={`${entry.relativePath}の注釈JSONを保存`} disabled={!hasRecords} onClick={() => void exportWorkspaceDocument(entry, 'annotations-json')}><span>JSON</span></button>
        </>}
        {prepared.map((artifact) => <button key={artifact.id} className="workspace-export-button" type="button" aria-label={`${artifact.fileName}をAgent出力からダウンロード`} title={`Agentが準備した${artifact.format}`} onClick={() => void downloadPreparedExport(artifact)}><Download size={11} /><span>Agent</span></button>)}
      </div>
    );
  };

  const inspectDocumentPage = async (targetPageNumber: number) => {
    if (!documentData) throw new Error('文書を読み込んでから実行してください。');
    const response = await apiFetch(`/api/documents/${documentData.documentId}/pages/${targetPageNumber}.svg`, undefined, settings.apiServerUrl);
    if (!response.ok) throw new Error(`ページ ${targetPageNumber} を取得できませんでした。`);
    const svg = await response.text();
    const textBlocks = extractSvgTextBlocks(svg);
    const pageText = textBlocks.slice(0, 600)
      .map((block) => `[x=${block.x.toFixed(3)}, y=${block.y.toFixed(3)}, w=${block.width.toFixed(3)}, h=${block.height.toFixed(3)}] ${block.text}`)
      .join('\n')
      .slice(0, 24_000);
    const url = createSvgPreviewUrl(svg);
    try {
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error(`ページ ${targetPageNumber} を画像化できませんでした。`));
      });
      image.src = url;
      await loaded;
      const maxEdge = 2200;
      const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`ページ ${targetPageNumber} を読み取れませんでした。`);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return { imageDataUrl: canvas.toDataURL('image/png'), pageText, textBlockCount: textBlocks.length };
    } finally {
      revokeSvgPreviewUrl(url);
    }
  };

  const rasterizeDocumentPage = async (targetPageNumber: number) => (await inspectDocumentPage(targetPageNumber)).imageDataUrl;

  const analyzeDocument = async (scope: 'current' | 'all' = 'all', continuation?: AgentContinuation): Promise<AgentAnalysisOutcome | undefined> => {
    const selectedMode = continuation?.mode ?? agentMode;
    const taskInstruction = continuation?.instruction ?? prompt;
    const taskGuidelines = continuation?.guidelines ?? guidelines;
    const taskCorrection = continuation?.correction ?? correction;
    if (!taskInstruction.trim()) {
      setMessage('AIへの指示を入力してください。');
      return;
    }
    if (!documentData) return;
    if (!continuation) {
      setConsistencyIssues([]);
      setObservationFindings([]);
      setObservationDocumentId(selectedMode === 'observe' ? documentData.documentId : null);
    }
    const effectiveScope = continuation
      ? continuation.fullDocument === undefined ? continuation.remainingPages.length > 1 ? 'all' : 'current' : continuation.fullDocument ? 'all' : 'current'
      : selectedMode === 'autopilot' ? 'all' : scope;
    const startingPageNumber = pageNumber;
    if (!continuation && effectiveScope === 'all') setZoom(100);
    const isWorkbook = documentData.fileType.toLowerCase() === 'xlsx';
    const envProviderMatches = (settings.provider === 'azure-openai' && health?.provider === 'azure') ||
      (settings.provider === 'openai-api' && health?.provider === 'openai');
    const configuredForThisSession = settings.provider === 'codex-app-server' ||
      (settings.provider === 'openai-compatible' && Boolean(settings.endpoint.trim())) ||
      Boolean(apiKey.trim()) || Boolean(health?.aiConfigured && envProviderMatches);
    const useAgentNavigation = effectiveScope === 'all' && configuredForThisSession && settings.provider !== 'codex-app-server' && !continuation?.visitedPages?.length;
    let pages = continuation?.remainingPages ?? (isWorkbook ? [1] : useAgentNavigation ? [1] : effectiveScope === 'all' ? documentData.pages.map((page) => page.pageNumber) : [pageNumber]);
    const runTotalPages = effectiveScope === 'all' ? documentData.pageCount : pages.length;
    const coverageTargetPages = effectiveScope === 'all'
      ? documentData.pages.map((page) => page.pageNumber)
      : [...new Set(continuation?.remainingPages ?? pages)];
    if (!pages.length) return;
    const runStartedAt = Date.now();
    const resumedRun = continuation?.runHistoryId
      ? agentRunHistoryRef.current.find((run) => run.id === continuation.runHistoryId)
      : undefined;
    setWorking(true);
    setAiMode(null);
    setAgentStatus('running');
    if (resumedRun) {
      if (activeAgentRunRef.current?.id !== resumedRun.id) {
        activeAgentRunRef.current = { ...resumedRun, status: 'running', endedAt: undefined, summary: undefined };
        agentActivityRef.current = resumedRun.events;
        setAgentActivity(resumedRun.events);
      } else {
        activeAgentRunRef.current = { ...activeAgentRunRef.current, status: 'running', endedAt: undefined, summary: undefined };
      }
    } else {
      clearAgentActivity();
      activeAgentRunRef.current = {
        id: crypto.randomUUID(),
        fileName: documentData.fileName,
        ...(documentData.sourceHash ? { sourceHash: documentData.sourceHash } : {}),
        startedAt: runStartedAt,
        instruction: taskInstruction.trim(),
        mode: selectedMode,
        status: 'running',
        totalPages: runTotalPages,
        completedPages: 0,
        events: [],
        pageCoverageTargets: coverageTargetPages,
        pageCoverage: [],
        ...(continuation?.humanDecisions?.length ? { humanDecisions: continuation.humanDecisions } : {}),
        ...(continuation?.lastHumanRuleVersion ? { lastHumanRuleVersion: continuation.lastHumanRuleVersion } : {}),
        ...(selectedMode === 'observe' ? { observationFindings: [] } : {}),
      };
    }
    persistRunHistoryEntry(activeAgentRunRef.current);
    if (!continuation) {
      setAgentContinuation(null);
    }
    setActiveTab('ai');
    if (!window.matchMedia('(max-width: 560px)').matches) {
      window.requestAnimationFrame(() => activityPanelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
    setScanProgress({ current: 0, total: runTotalPages, scope: effectiveScope });
    let failure = '';
    let completedPages = activeAgentRunRef.current?.completedPages ?? 0;
    const completedPagesBeforeInvocation = completedPages;
    let foundCount = 0;
    let autoAppliedCount = 0;
    let reviewCount = 0;
    let spreadsheetReviewCount = 0;
    const runFindings: AnnotationCandidate[] = [];
    const processedPages = new Set<number>(continuation?.visitedPages ?? []);
    let pausedContinuation: AgentContinuation | null = null;
    let runMode: 'live' | 'demo' = configuredForThisSession ? 'live' : 'demo';
    const runUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, totalTokens: 0 };
    let structuredTaskPlan = '';
    const agentVisitedPages = new Set<number>(continuation?.visitedPages ?? []);
    const mergePageCoverage = (updates: AgentPageCoverage[]) => {
      if (!updates.length || !activeAgentRunRef.current) return;
      const byPage = new Map((activeAgentRunRef.current.pageCoverage ?? []).map((item) => [item.pageNumber, item]));
      for (const update of updates) byPage.set(update.pageNumber, update);
      activeAgentRunRef.current = {
        ...activeAgentRunRef.current,
        pageCoverage: [...byPage.values()].sort((left, right) => left.pageNumber - right.pageNumber),
      };
      persistRunHistoryEntry(activeAgentRunRef.current);
    };
    const annotationSnapshot = new Map<string, {
      id: string; pageNumber: number; x: number; y: number; width: number; height: number;
      label: string; note: string; excerpt?: string; reviewPriority?: AnnotationReviewPriority; status: 'active' | 'needs_review';
    }>();
    for (const annotation of annotations) {
      annotationSnapshot.set(annotation.id, {
        id: annotation.id, pageNumber: annotation.pageNumber, x: annotation.x, y: annotation.y,
        width: annotation.width, height: annotation.height, label: annotation.label,
        note: annotation.note.slice(0, 240), ...(annotation.excerpt ? { excerpt: annotation.excerpt.slice(0, 240) } : {}),
        ...(annotation.reviewPriority ? { reviewPriority: annotation.reviewPriority } : {}), status: !annotation.reviewedByHuman && (annotation.requiresReview || annotation.reviewPriority === 'high') ? 'needs_review' : 'active',
      });
    }
    for (const candidate of candidates) {
      annotationSnapshot.set(candidate.id, {
        id: candidate.id, pageNumber: candidate.pageNumber, x: candidate.x, y: candidate.y,
        width: candidate.width, height: candidate.height, label: candidate.label,
        note: candidate.note.slice(0, 240), ...(candidate.excerpt ? { excerpt: candidate.excerpt.slice(0, 240) } : {}),
        ...(candidate.reviewPriority ? { reviewPriority: candidate.reviewPriority } : {}), status: 'needs_review',
      });
    }
    const saveAnnotationSummary = (candidate: AnnotationCandidate, status: 'active' | 'needs_review') => {
      annotationSnapshot.set(candidate.id, {
        id: candidate.id, pageNumber: candidate.pageNumber, x: candidate.x, y: candidate.y,
        width: candidate.width, height: candidate.height, label: candidate.label, note: candidate.note.slice(0, 240),
        ...(candidate.excerpt ? { excerpt: candidate.excerpt.slice(0, 240) } : {}),
        ...(candidate.reviewPriority ? { reviewPriority: candidate.reviewPriority } : {}), status,
      });
    };
    let navigationUsed = false;
    try {
      const planningActivityId = addAgentActivity('Planning', 'plan_annotation_task → interpreting the task and guidelines.', 'active');
      const plannedTask = await prepareTaskPlan(taskInstruction, taskGuidelines, taskCorrection, selectedMode);
      updateAgentActivity(planningActivityId, {
        status: 'complete',
        detail: `${plannedTask.source === 'model' ? 'plan_annotation_task' : 'local_task_draft'} → ${plannedTask.plan.title}; ${plannedTask.plan.labels.length} labels; ${plannedTask.plan.actions.join(', ')}.`,
      });
      structuredTaskPlan = taskPlanAsInstructions(plannedTask.plan);
      if (activeAgentRunRef.current) {
        activeAgentRunRef.current = { ...activeAgentRunRef.current, taskPlan: plannedTask.plan };
        persistRunHistoryEntry(activeAgentRunRef.current);
      }
      addAgentActivity('Planning', `Task: ${taskInstruction.trim().slice(0, 110)}${taskInstruction.trim().length > 110 ? '…' : ''}`);
      addAgentActivity('Planning', `get_document_outline → ${documentData.fileName}, ${isWorkbook ? `${workbookSummary?.sheets.length ?? 0} worksheets, workbook-wide` : `${documentData.pageCount} pages, ${continuation ? `resuming at page ${pages[0]} with ${pages.length} remaining` : effectiveScope === 'all' ? 'whole document' : `page ${pageNumber}`}`}.`);
      if (selectedMode === 'observe') addAgentActivity('Planning', 'Observe mode is read-only; annotations and review queues will not be changed.');
      const acceptedDecisionText = annotations
        .filter((annotation) => annotation.reviewedByHuman || annotation.source === 'manual')
        .slice(0, 20)
        .map((annotation) => `[THIS ITEM ONLY; DO NOT GENERALIZE] 人が確定: P.${annotation.pageNumber} ${annotation.label}: ${annotation.note}`);
      const rejectedDecisionText = rejectedCandidates
        .slice(-20)
        .map((candidate) => `[THIS ITEM ONLY; DO NOT GENERALIZE] 人が却下: P.${candidate.pageNumber} ${candidate.label}: ${candidate.excerpt || candidate.note}`);
      const humanDecisions = [...acceptedDecisionText, ...rejectedDecisionText, continuation?.decisionContext ?? ''].filter(Boolean).join('\n').slice(0, 4000);

      for (const [index, targetPage] of pages.entries()) {
        if (useAgentNavigation && navigationUsed && agentVisitedPages.has(targetPage)) continue;
        const navigateThisCall = useAgentNavigation && !navigationUsed;
        let pageTextBlockCount: number | undefined;
        let pageToolEvents: Array<{ toolName: string; phase: AgentActivityPhase; detail: string; status: 'active' | 'complete' | 'waiting' | 'error'; pageNumber?: number; textBlockCount?: number; warningCount?: number; viewport?: NormalizedTextBox }> = [];
        setScanProgress({ current: useAgentNavigation ? Math.max(1, completedPages) : index + 1, total: runTotalPages, scope: effectiveScope });
        const navigationId = addAgentActivity('Navigating', `navigate_page({ page: ${targetPage} }) → opening page ${targetPage} of ${documentData.pageCount}.`, 'active', targetPage);
        if (targetPage !== startingPageNumber) setSelectedId(null);
        setPageNumber(targetPage);
        const preserveCurrentViewer = !continuation && effectiveScope === 'current' && targetPage === startingPageNumber && !isWorkbook;
        const viewerViewport = preserveCurrentViewer
          ? visiblePageViewport(pageScrollAreaRef.current, pageFrameRef.current)
          : undefined;
        if (!viewerViewport) clearAgentViewport();
        try {
          let workbookApprovalRunId: string | undefined;
          let workbookApprovalId: string | undefined;
          let workbookApproval: SpreadsheetCellChange | undefined;
          const readingId = addAgentActivity('Reading', 'Loading the page image and extracting visible text and layout positions.', 'active', targetPage);
          const pageInspection = await inspectDocumentPage(targetPage);
          pageTextBlockCount = pageInspection.textBlockCount;
          updateAgentActivity(navigationId, { status: 'complete', detail: `navigate_page → page ${targetPage} is visible in the viewer.` });
          updateAgentActivity(readingId, { status: 'complete', detail: `inspect_page → read ${pageInspection.textBlockCount} text blocks with positions and rendered the page image.`, pageNumber: targetPage });

          let pageCandidates: AnnotationCandidate[];
          if (runMode === 'demo') {
            pageCandidates = seededCandidates(targetPage, taskInstruction.trim());
            addAgentActivity('Searching', 'search_document → demo fixture only; no model search was performed.', 'complete', targetPage);
          } else {
            const searchId = addAgentActivity('Searching', 'search_document → checking extracted text, positions, and visual layout for task targets.', 'active', targetPage);
            const existingAnnotationsForRequest = [...annotationSnapshot.values()].slice(-500);
            const selectedAnnotationSummary = selectedId
              ? annotationSnapshot.get(selectedId)?.pageNumber === targetPage ? annotationSnapshot.get(selectedId) : undefined
              : undefined;
            if (selectedAnnotationSummary && !existingAnnotationsForRequest.some((item) => item.id === selectedAnnotationSummary.id)) {
              existingAnnotationsForRequest.unshift(selectedAnnotationSummary);
              if (existingAnnotationsForRequest.length > 500) existingAnnotationsForRequest.pop();
            }
            const pageScrollArea = pageScrollAreaRef.current;
            const visiblePageArea = pageScrollArea ? scrollAreaContentSize(pageScrollArea) : null;
            const viewerAspectRatio = visiblePageArea ? visiblePageArea.width / visiblePageArea.height : undefined;
            const { ok, status, payload: result, streamedActivityCount } = await postAgentRequest('/api/ai/annotate', {
                instruction: taskInstruction.trim(),
                taskPlan: structuredTaskPlan,
                guidelines: taskGuidelines.trim(),
                correction: taskCorrection.trim(),
                humanDecisions,
                documentId: documentData.documentId,
                documentScope: navigateThisCall ? 'all' : 'current',
                exportScope: effectiveScope,
                pageText: pageInspection.pageText,
                imageDataUrl: pageInspection.imageDataUrl,
                model: settings.model,
                pageNumber: targetPage,
                totalPages: documentData.pageCount,
                agentMode: selectedMode,
                requireToolApproval: !workspaceBatchActiveRef.current,
                selectedAnnotationId: selectedAnnotationSummary?.id,
                viewerAspectRatio,
                viewerViewport,
                existingAnnotations: existingAnnotationsForRequest,
                documentAnnotations: normalizeDocumentAnnotationRecords({ documentId: documentData.documentId, sourceHash: documentData.sourceHash, fileType: documentData.fileType, ...documentAnnotationView }),
                settings: { ...settings, apiKey },
              }, settings.apiServerUrl, (toolEvent) => {
                syncViewerToToolEvent(toolEvent);
                addAgentActivity(toolEvent.phase, `${toolEvent.toolName} → ${toolEvent.detail}`, toolEvent.status, toolEvent.pageNumber ?? targetPage);
              });
            if (!ok) {
              if (status === 503 && result.aiConfigured === false && completedPages === 0) {
                runMode = 'demo';
                pageCandidates = seededCandidates(targetPage, taskInstruction.trim());
                updateAgentActivity(searchId, { status: 'complete', detail: 'AI is not configured; showing clearly marked demo candidates.', pageNumber: targetPage });
              } else {
                throw new Error(result.error ?? `ページ ${targetPage} の候補を作成できませんでした。`);
              }
            } else {
              pageCandidates = (Array.isArray(result.annotations) ? result.annotations : []) as AnnotationCandidate[];
              const toolEvents = (Array.isArray(result.toolEvents) ? result.toolEvents : []) as typeof pageToolEvents;
              pageToolEvents = toolEvents;
              if (navigateThisCall) navigationUsed = true;
              if (Array.isArray(result.visitedPages)) {
                for (const visitedPage of result.visitedPages.map(Number).filter((value:number)=>Number.isFinite(value)&&value>=1&&value<=documentData.pageCount)) agentVisitedPages.add(visitedPage);
              }
              for (const toolEvent of toolEvents) {
                if (toolEvent.toolName === 'inspect_page' && Number.isInteger(toolEvent.pageNumber)) agentVisitedPages.add(Number(toolEvent.pageNumber));
              }
              if (streamedActivityCount === 0) {
                for (const toolEvent of toolEvents) {
                  const eventPage = toolEvent.pageNumber ?? targetPage;
                  syncViewerToToolEvent(toolEvent);
                  addAgentActivity(toolEvent.phase, `${toolEvent.toolName} → ${toolEvent.detail}`, toolEvent.status, eventPage);
                }
              }
              mergeWorkbookChanges(result.spreadsheetChanges, result.approvalRunId, result.approvalId);
              rememberPreparedExports(result.exports, documentData.documentId);
              mergeAnnotationOperations(result.annotationOperations);
              workbookApprovalRunId = typeof result.approvalRunId === 'string' ? result.approvalRunId : undefined;
              workbookApprovalId = typeof result.approvalId === 'string' ? result.approvalId : undefined;
              if (Array.isArray(result.spreadsheetChanges)) {
                workbookApproval = (result.spreadsheetChanges as SpreadsheetCellChange[]).find((change) => change.id === workbookApprovalId && change.requiresReview);
                if (workbookApproval) spreadsheetReviewCount += 1;
              }
              const itemUsage = result.usage as (Partial<TokenUsage> & { requests?: number }) | undefined;
              if (itemUsage) {
                const normalized: TokenUsage = {
                  inputTokens: Number(itemUsage.inputTokens ?? 0),
                  outputTokens: Number(itemUsage.outputTokens ?? 0),
                  reasoningTokens: Number(itemUsage.reasoningTokens ?? 0),
                  cachedInputTokens: Number(itemUsage.cachedInputTokens ?? 0),
                  totalTokens: Number(itemUsage.totalTokens ?? 0),
                };
                runUsage.inputTokens += normalized.inputTokens;
                runUsage.outputTokens += normalized.outputTokens;
                runUsage.reasoningTokens += normalized.reasoningTokens;
                runUsage.cachedInputTokens += normalized.cachedInputTokens;
                runUsage.totalTokens += normalized.totalTokens;
                recordUsage(result.provider as ProviderId, String(result.model ?? settings.model), normalized, Number(itemUsage.requests ?? 1));
              }
              const findingPages = [...new Set(pageCandidates.map((candidate) => Number(candidate.pageNumber) || targetPage))];
              updateAgentActivity(searchId, { status: 'complete', detail: useAgentNavigation
                ? `search_document → the Agent returned ${pageCandidates.length} possible region${pageCandidates.length === 1 ? '' : 's'} on ${findingPages.map((page) => `P.${page}`).join(', ') || 'the inspected pages'}.`
                : `search_document → found ${pageCandidates.length} possible region${pageCandidates.length === 1 ? '' : 's'} on page ${targetPage}.`, pageNumber: findingPages[0] ?? targetPage });
            }
          }

          const normalizedCandidates = pageCandidates.map((candidate) => ({ ...candidate, pageNumber: Number(candidate.pageNumber) || targetPage, source: 'ai' as const }));
          const touchedPages = navigateThisCall ? new Set(agentVisitedPages) : new Set([targetPage]);
          normalizedCandidates.forEach((candidate) => touchedPages.add(candidate.pageNumber));
          const existingDecisions = annotations.filter((annotation) => touchedPages.has(annotation.pageNumber));
          const humanRejected = rejectedCandidates.filter((candidate) => touchedPages.has(candidate.pageNumber));
          const eligible = normalizedCandidates.filter((candidate) => {
            if (existingDecisions.some((annotation) => sameRegion(annotation, candidate))) return false;
            return !humanRejected.some((rejected) => rejected.label.trim().toLocaleLowerCase() === candidate.label.trim().toLocaleLowerCase() && ((rejected.excerpt && candidate.excerpt && rejected.excerpt === candidate.excerpt) || rejected.note.trim() === candidate.note.trim()));
          });
          agentVisitedPages.add(targetPage);
          runFindings.push(...eligible);
          foundCount += eligible.length;
          if (selectedMode === 'observe') {
            setObservationFindings((existing) => {
              const merged = [...existing];
              for (const finding of eligible) {
                const index = merged.findIndex((item) => item.id === finding.id);
                if (index >= 0) merged[index] = finding;
                else merged.push(finding);
              }
              return merged.slice(0, 500);
            });
            if (activeAgentRunRef.current) {
              const previous: AnnotationCandidate[] = activeAgentRunRef.current.observationFindings ?? [];
              const previousIds = new Set(previous.map((finding) => finding.id));
              const additions: AnnotationCandidate[] = eligible.filter((finding) => !previousIds.has(finding.id));
              const maxSavedFindings = 100;
              const merged: AnnotationCandidate[] = [...previous, ...additions];
              const savedFindings: AnnotationCandidate[] = merged.slice(0, maxSavedFindings);
              const overflow: number = (activeAgentRunRef.current.observationFindingOverflow ?? 0) + Math.max(0, merged.length - maxSavedFindings);
              activeAgentRunRef.current = {
                ...activeAgentRunRef.current,
                observationFindings: savedFindings,
                ...(overflow > 0 ? { observationFindingOverflow: overflow } : {}),
              };
              persistRunHistoryEntry(activeAgentRunRef.current);
            }
          }
          const mayAutoAnnotate = selectedMode === 'assist' || selectedMode === 'autopilot';
          const autoAccepted = runMode === 'live' && mayAutoAnnotate
            ? eligible.filter((candidate) => !candidate.requiresReview && candidate.reviewPriority !== 'high')
            : [];
          const needsReview = selectedMode === 'observe' ? [] : selectedMode === 'suggest' ? eligible : eligible.filter((candidate) => !autoAccepted.some((accepted) => accepted.id === candidate.id));
          autoAccepted.forEach((candidate) => saveAnnotationSummary(candidate, 'active'));
          needsReview.forEach((candidate) => saveAnnotationSummary(candidate, 'needs_review'));
          const newlyVisited = navigateThisCall
            ? [...agentVisitedPages].filter((visitedPage) => !processedPages.has(visitedPage))
            : [targetPage];
          const pagesProcessedThisPass = [...new Set([targetPage, ...newlyVisited])].filter((visitedPage) => !processedPages.has(visitedPage));
          const openedOnlyPages = pageToolEvents
            .filter((event) => event.toolName === 'navigate_page' && Number.isInteger(event.pageNumber))
            .map((event) => Number(event.pageNumber))
            .filter((visitedPage) => !pagesProcessedThisPass.includes(visitedPage));
          const coveragePageNumbers = [...new Set([...pagesProcessedThisPass, ...openedOnlyPages])];
          const pageCoverageUpdates: AgentPageCoverage[] = coveragePageNumbers.map((coveragePage) => {
            const pageEvents = pageToolEvents.filter((event) => event.pageNumber === coveragePage);
            const hasInspection = coveragePage === targetPage || pageEvents.some((event) => event.toolName === 'inspect_page');
            const eventTextCount = pageEvents.find((event) => event.textBlockCount !== undefined)?.textBlockCount;
            const textBlockCount = coveragePage === targetPage ? pageTextBlockCount : eventTextCount;
            const documentWarningCount = documentData.pages.find((item) => item.pageNumber === coveragePage)?.warningCount ?? 0;
            const eventWarningCount = pageEvents.reduce((maximum, event) => Math.max(maximum, Number(event.warningCount ?? 0)), 0);
            const warningCount = Math.max(documentWarningCount, eventWarningCount);
            const status: AgentPageCoverage['status'] = runMode === 'demo'
              ? 'demo_only'
              : !hasInspection ? 'opened'
                : textBlockCount === 0 ? 'image_only' : 'checked';
            const findingCount = eligible.filter((candidate) => candidate.pageNumber === coveragePage).length;
            const reviewCount = needsReview.filter((candidate) => candidate.pageNumber === coveragePage).length;
            const detail = status === 'opened'
              ? 'Page opened, but no explicit inspect_page result was recorded.'
              : status === 'image_only'
                ? 'No positioned text was extracted; the page image was supplied for visual review.'
                : warningCount > 0
                  ? `The converter reported ${warningCount} warning${warningCount === 1 ? '' : 's'} for this page.`
                  : status === 'demo_only' ? 'Fixed demo output; this page was not analyzed by a live model.' : undefined;
            return { pageNumber: coveragePage, status, findingCount, reviewCount, warningCount, ...(textBlockCount !== undefined ? { textBlockCount } : {}), ...(detail ? { detail } : {}) };
          });
          mergePageCoverage(pageCoverageUpdates);
          completedPages += pagesProcessedThisPass.length;
          if (activeAgentRunRef.current) {
            activeAgentRunRef.current = { ...activeAgentRunRef.current, completedPages };
            persistRunHistoryEntry(activeAgentRunRef.current);
          }
          pagesProcessedThisPass.forEach((visitedPage) => processedPages.add(visitedPage));
          setScanProgress({ current: completedPages, total: runTotalPages, scope: effectiveScope });

          if (selectedMode === 'observe') {
            addAgentActivity('Reviewing', `Read-only review found ${eligible.length} possible region${eligible.length === 1 ? '' : 's'}; no document state changed.`, 'complete', targetPage);
          } else {
            if (selectedMode === 'assist' || selectedMode === 'autopilot') {
              setAnnotations((existing) => {
                const byId = new Map(existing.map((annotation) => [annotation.id, annotation]));
                for (const candidate of autoAccepted) byId.set(candidate.id, { ...candidate, source: 'ai', requiresReview: false });
                return [...byId.values()];
              });
            }
            setCandidates((existing) => [
              ...existing.filter((candidate) => !touchedPages.has(candidate.pageNumber)),
              ...needsReview,
            ]);
            if (autoAccepted.length || needsReview.length) setSaved(false);
            autoAppliedCount += autoAccepted.length;
            reviewCount += needsReview.length;
            if (autoAccepted.length) addAgentActivity('Annotating', `annotate_region → applied ${autoAccepted.length} clear annotation${autoAccepted.length === 1 ? '' : 's'} in the viewer.`, 'complete', autoAccepted[0]?.pageNumber ?? targetPage);
            if (needsReview.length) {
              const firstReviewPage = needsReview[0]?.pageNumber ?? targetPage;
              addAgentActivity(selectedMode === 'suggest' ? 'Reviewing' : 'Asking', `request_review → ${needsReview.length} candidate${needsReview.length === 1 ? '' : 's'} queued for human review.`, 'waiting', firstReviewPage);
            } else if (!autoAccepted.length) {
              addAgentActivity('Reviewing', 'No matching regions found on this page.', 'complete', targetPage);
            }
          }
          const toolApprovalCandidate = needsReview.find((candidate) => candidate.approvalRunId && candidate.approvalId);
          const hasPendingSheetApproval = Boolean(workbookApproval && workbookApprovalRunId && workbookApprovalId);
          const pendingAnnotationOperation = annotationOperationsRef.current.find((operation) => operation.status === 'needs_review' && operation.approvalRunId && operation.approvalId);
          const hasPendingAnnotationApproval = Boolean(pendingAnnotationOperation);
          const hasReviewWork = needsReview.length > 0 || hasPendingSheetApproval || hasPendingAnnotationApproval;
          if (!workspaceBatchActiveRef.current && (selectedMode === 'assist' || selectedMode === 'autopilot') && hasReviewWork && (index < pages.length - 1 || Boolean(toolApprovalCandidate) || hasPendingSheetApproval || hasPendingAnnotationApproval)) {
            const blockingPage = toolApprovalCandidate?.pageNumber ?? pendingAnnotationOperation?.pageNumber ?? targetPage;
            pausedContinuation = {
              ...(documentData.sourceHash ? { sourceHash: documentData.sourceHash } : {}),
              remainingPages: navigateThisCall && effectiveScope === 'all'
                ? documentData.pages.map((page) => page.pageNumber).filter((page) => !agentVisitedPages.has(page))
                : pages.slice(index + 1).filter((page) => !agentVisitedPages.has(page)),
              blockedPage: blockingPage,
              fullDocument: effectiveScope === 'all',
              humanCorrections: continuation?.humanCorrections ?? 0,
              visitedPages: [...agentVisitedPages],
              mode: selectedMode,
              instruction: taskInstruction,
              guidelines: taskGuidelines,
              correction: taskCorrection,
              decisionContext: continuation?.decisionContext ?? '',
              humanDecisions: continuation?.humanDecisions ?? [],
              ...(continuation?.lastHumanRuleVersion ? { lastHumanRuleVersion: continuation.lastHumanRuleVersion } : {}),
              ...((toolApprovalCandidate?.approvalRunId ?? pendingAnnotationOperation?.approvalRunId ?? workbookApprovalRunId) ? { approvalRunId: toolApprovalCandidate?.approvalRunId ?? pendingAnnotationOperation?.approvalRunId ?? workbookApprovalRunId } : {}),
              ...((toolApprovalCandidate?.approvalId ?? pendingAnnotationOperation?.approvalId ?? workbookApprovalId) ? { approvalId: toolApprovalCandidate?.approvalId ?? pendingAnnotationOperation?.approvalId ?? workbookApprovalId } : {}),
              ...(activeAgentRunRef.current?.id ? { runHistoryId: activeAgentRunRef.current.id } : {}),
            };
            const pendingCount = needsReview.length + (hasPendingSheetApproval ? 1 : 0) + (hasPendingAnnotationApproval ? 1 : 0);
            const resumeDetail = pausedContinuation.remainingPages.length
              ? `Resolve these ${pendingCount} item${pendingCount === 1 ? '' : 's'} to continue with page ${pausedContinuation.remainingPages[0]}.`
              : `Resolve these ${pendingCount} item${pendingCount === 1 ? '' : 's'} to finish the current task.`;
            addAgentActivity('Asking', `Agent paused on page ${blockingPage}. ${resumeDetail}`, 'waiting', blockingPage);
            break;
          }
          if (navigateThisCall && effectiveScope === 'all' && !pausedContinuation) {
            const scheduled = new Set(pages);
            const unvisitedPages = documentData.pages.map((page) => page.pageNumber).filter((page) => !agentVisitedPages.has(page) && !scheduled.has(page));
            if (unvisitedPages.length) {
              pages.push(...unvisitedPages);
              addAgentActivity('Continuing', `The Agent visited ${agentVisitedPages.size} pages; opening ${unvisitedPages.length} remaining page${unvisitedPages.length === 1 ? '' : 's'} for visual coverage.`, 'complete', targetPage);
            }
          }
          if (index < pages.length - 1) addAgentActivity('Continuing', `Moving on from page ${targetPage} to the next page.`, 'complete', targetPage);
        } catch (error) {
          failure = error instanceof Error ? error.message : `ページ ${targetPage} の解析に失敗しました。`;
          const warningCount = documentData.pages.find((item) => item.pageNumber === targetPage)?.warningCount ?? 0;
          mergePageCoverage([{ pageNumber: targetPage, status: 'failed', findingCount: 0, reviewCount: 0, warningCount, ...(pageTextBlockCount !== undefined ? { textBlockCount: pageTextBlockCount } : {}), detail: failure.slice(0, 500) }]);
          updateAgentActivity(navigationId, { status: 'error', detail: failure });
          addAgentActivity('Reviewing', failure, 'error', targetPage);
          break;
        }
      }
      if (isWorkbook) {
        try { await refreshWorkbookSummary(documentData.documentId); } catch { /* Preserve agent changes if the workbook preview session has expired. */ }
      }
      const documentPassComplete = effectiveScope === 'all' && runMode === 'live' && !failure
        && (!pausedContinuation || pausedContinuation.remainingPages.length === 0);
      const finalValidation = documentPassComplete
        ? await validateCompletedDocument({
          instruction: taskInstruction,
          taskPlan: structuredTaskPlan,
          guidelines: taskGuidelines,
          correction: taskCorrection,
          humanDecisions,
          annotations: [...annotations, ...candidates, ...runFindings],
        })
        : { issues: [], usage: undefined, modelFindingCount: 0 };
      const nextConsistencyIssues = finalValidation.issues;
      const modelValidationCount = finalValidation.modelFindingCount;
      if (finalValidation.usage) {
        runUsage.inputTokens += finalValidation.usage.inputTokens;
        runUsage.outputTokens += finalValidation.usage.outputTokens;
        runUsage.reasoningTokens += finalValidation.usage.reasoningTokens;
        runUsage.cachedInputTokens += finalValidation.usage.cachedInputTokens;
        runUsage.totalTokens += finalValidation.usage.totalTokens;
      }
      setConsistencyIssues(nextConsistencyIssues);
      nextConsistencyIssues.forEach((issue) => {
        if (issue.kind === 'model_review') return;
        const occurrences = issue.occurrences.map((item) => `P.${item.pageNumber} ${item.label}`).join(' · ');
        const finding = issue.kind === 'same_excerpt' ? 'the same excerpt has conflicting labels' : 'similar excerpts have conflicting labels';
        addAgentActivity('Reviewing', `validate_consistency → ${finding}: ${occurrences}.`, 'complete', issue.occurrences[0]?.pageNumber);
      });
      setAiMode(runMode);
      if (pausedContinuation) setAgentContinuation(pausedContinuation);
      else if (!failure) setAgentContinuation(null);
      if (completedPages && selectedMode !== 'observe') setSaved(false);
      if (runUsage.totalTokens > 0) setLastUsage(runUsage);
      const coverageByPage = new Map((activeAgentRunRef.current?.pageCoverage ?? []).map((item) => [item.pageNumber, item]));
      const scopedCoverage = coverageTargetPages.map((target) => coverageByPage.get(target));
      const checkedCoverageCount = scopedCoverage.filter((item) => item?.status === 'checked').length;
      const noFindingCoverageCount = scopedCoverage.filter((item) => item?.status === 'checked' && item.findingCount === 0).length;
      const imageOnlyCoverageCount = scopedCoverage.filter((item) => item?.status === 'image_only').length;
      const openedCoverageCount = scopedCoverage.filter((item) => item?.status === 'opened').length;
      const failedCoverageCount = scopedCoverage.filter((item) => item?.status === 'failed').length;
      const warningCoverageCount = scopedCoverage.filter((item) => Boolean(item && item.warningCount > 0)).length;
      const unprocessedCoverageCount = scopedCoverage.filter((item) => !item).length;
      const coverageAttentionCount = scopedCoverage.filter((item) => !item || ['image_only', 'opened', 'failed'].includes(item.status) || item.warningCount > 0).length;
      const remainingReviewCount = selectedMode === 'observe'
        ? candidates.length
        : candidates.filter((candidate) => !processedPages.has(candidate.pageNumber)).length + reviewCount + spreadsheetReviewCount;
      const finalStatus: AgentRunStatus = failure ? 'error' : remainingReviewCount || coverageAttentionCount ? 'waiting' : 'complete';
      setAgentStatus(finalStatus);
      const invocationCompletedPages = completedPages - completedPagesBeforeInvocation;
      if (failure) addAgentActivity('Reviewing', `Run stopped after ${invocationCompletedPages} of ${runTotalPages} pages in this pass. ${failure}`, 'error');
      else if (remainingReviewCount || coverageAttentionCount) addAgentActivity('Asking', [
        remainingReviewCount ? spreadsheetReviewCount
          ? `${reviewCount} annotation candidate${reviewCount === 1 ? '' : 's'} and ${spreadsheetReviewCount} workbook change${spreadsheetReviewCount === 1 ? '' : 's'} need human review.`
          : `${remainingReviewCount} regions need your review before they are finalized.` : '',
        coverageAttentionCount ? `${coverageAttentionCount} page${coverageAttentionCount === 1 ? '' : 's'} still need coverage review.` : '',
      ].filter(Boolean).join(' '), 'waiting');
      else addAgentActivity('Continuing', selectedMode === 'observe' ? `Finished reading ${completedPages} pages. No annotations were changed.` : pausedContinuation ? `Paused on page ${pausedContinuation.blockedPage}; waiting for human review before continuing.` : `Finished ${completedPages} page${completedPages === 1 ? '' : 's'} with no pending reviews.`, pausedContinuation ? 'waiting' : 'complete');
      const modeSummary = selectedMode === 'observe'
        ? `${foundCount}件の可能性のある範囲を読み取りました。文書は変更していません。`
        : selectedMode === 'suggest'
          ? `${reviewCount}件の候補を確認待ちにしました。`
          : `${autoAppliedCount}件を注釈し、${reviewCount}件の範囲と${spreadsheetReviewCount}件のセル変更を人の確認待ちにしました。`;
      const demoText = runMode === 'demo' ? ' デモ候補は実モデルの解析結果ではありません。' : '';
      const partialText = failure ? ` ${failure} ここまでの結果を保持しました。` : '';
      const usageText = runUsage.totalTokens ? ` 使用量 ${formatTokens(runUsage.totalTokens)} tokens` : '';
      const consistencyText = nextConsistencyIssues.length
        ? ` 一貫性レビューで${nextConsistencyIssues.length}件の確認候補を検出しました。${modelValidationCount ? ` Validator Agentの独立指摘が${modelValidationCount}件あります。` : ''}`
        : '';
      const humanCorrectionText = continuation?.humanCorrections ? ` 人の修正を${continuation.humanCorrections}件後続ページに反映しました。` : '';
      const coverageText = `確認範囲: ${checkedCoverageCount}/${coverageTargetPages.length}ページをテキスト付きで確認し、${noFindingCoverageCount}ページは該当なし。${imageOnlyCoverageCount ? ` 文字抽出なし ${imageOnlyCoverageCount}ページ。` : ''}${warningCoverageCount ? ` 変換警告 ${warningCoverageCount}ページ。` : ''}${openedCoverageCount ? ` 開いたが未確認 ${openedCoverageCount}ページ。` : ''}${failedCoverageCount ? ` 失敗 ${failedCoverageCount}ページ。` : ''}${unprocessedCoverageCount ? ` 未処理 ${unprocessedCoverageCount}ページ。` : ''}`;
      const runSummary = `${completedPages} / ${runTotalPages}ページを処理しました。${coverageText}${modeSummary}${humanCorrectionText}${consistencyText}${usageText}${demoText}${partialText}`;
      setMessage(runSummary);
      setActiveTab('ai');
      if (activeAgentRunRef.current) {
        persistRunHistoryEntry({ ...activeAgentRunRef.current, status: finalStatus, endedAt: Date.now(), completedPages, summary: runSummary });
        activeAgentRunRef.current = null;
      }
      await waitForRender();
      saveCurrentDocumentWorkspace(documentData.fileName);
      setSaved(true);
      return { status: finalStatus === 'error' ? 'error' : finalStatus === 'waiting' ? 'waiting' : 'complete', completedPages: invocationCompletedPages, totalPages: runTotalPages };
    } catch (error) {
      setAgentStatus('error');
      const detail = error instanceof Error ? error.message : 'Agent run failed.';
      addAgentActivity('Reviewing', detail, 'error');
      setMessage(error instanceof Error ? error.message : 'AI候補の作成に失敗しました。');
      if (activeAgentRunRef.current) {
        persistRunHistoryEntry({ ...activeAgentRunRef.current, status: 'error', endedAt: Date.now(), summary: detail });
        activeAgentRunRef.current = null;
      }
      await waitForRender();
      saveCurrentDocumentWorkspace(documentData.fileName);
      return { status: 'error', completedPages, totalPages: runTotalPages };
    } finally {
      setWorking(false);
      setScanProgress(null);
    }
  };

  analyzeAgentRef.current = analyzeDocument;
  resumeAgentRef.current = async (pending, decision) => {
    if (pending.runHistoryId && activeAgentRunRef.current?.id !== pending.runHistoryId) {
      const savedRun = agentRunHistoryRef.current.find((item) => item.id === pending.runHistoryId);
      if (savedRun) {
        activeAgentRunRef.current = { ...savedRun, status: 'running', endedAt: undefined, summary: undefined };
        agentActivityRef.current = savedRun.events;
        setAgentActivity(savedRun.events);
        persistRunHistoryEntry(activeAgentRunRef.current);
      }
    }
    const finishRunHistory = (status: AgentRunHistory['status'], summary: string) => {
      if (!activeAgentRunRef.current) return;
      persistRunHistoryEntry({ ...activeAgentRunRef.current, status, endedAt: Date.now(), summary });
      activeAgentRunRef.current = null;
    };
    const rerunFinalConsistency = async () => {
      if (!pending.fullDocument || !documentData) return 0;
      await waitForRender();
      const current = restoreDocumentAnnotationRecords(documentWorkspaceStateRef.current.documentAnnotationRecords);
      const review = await validateCompletedDocument({
        instruction: pending.instruction,
        taskPlan: taskPlanRef.current ? taskPlanAsInstructions(taskPlanRef.current.plan) : '',
        guidelines: pending.guidelines,
        correction: pending.correction,
        humanDecisions: [pending.decisionContext, decision?.note ?? ''].filter(Boolean).join('\n').slice(0, 4000),
        annotations: [...current.annotations, ...current.candidates],
      });
      setConsistencyIssues(review.issues);
      await waitForRender();
      if (review.usage) setLastUsage(review.usage);
      review.issues.forEach((issue) => {
        if (issue.kind === 'model_review') return;
        const occurrences = issue.occurrences.map((item) => `P.${item.pageNumber} ${item.label}`).join(' · ');
        const finding = issue.kind === 'same_excerpt' ? 'the same excerpt has conflicting labels' : 'similar excerpts have conflicting labels';
        addAgentActivity('Reviewing', `validate_consistency → ${finding}: ${occurrences}.`, 'complete', issue.occurrences[0]?.pageNumber);
      });
      return review.issues.length;
    };
    if (!decision) {
      if (pending.remainingPages.length) {
        await waitForRender();
        await analyzeAgentRef.current?.('all', pending);
      } else {
        setAgentContinuation(null);
        setWorking(true);
        setAgentStatus('running');
        const issueCount = await rerunFinalConsistency();
        setAgentStatus('complete');
        await waitForRender();
        if (documentData) saveCurrentDocumentWorkspace(documentData.fileName);
        setSaved(true);
        finishRunHistory('complete', `人の判断を記録しました。残りのページはありません。${issueCount ? ` 一貫性レビューで${issueCount}件の確認候補があります。` : ''}`);
        setWorking(false);
      }
      return;
    }

    setWorking(true);
    setAgentStatus('running');
    setActiveTab('ai');
    setSelectedId(null);
    try {
      const { ok, payload: result, streamedActivityCount } = await postAgentRequest('/api/ai/approve', {
        ...decision,
        ...(documentData?.documentId ? { documentId: documentData.documentId } : {}),
        ...(documentData?.sourceHash ? { sourceHash: documentData.sourceHash } : {}),
        settings: { ...settings, apiKey },
      }, settings.apiServerUrl, (toolEvent) => {
        syncViewerToToolEvent(toolEvent);
        addAgentActivity(toolEvent.phase, `${toolEvent.toolName} → ${toolEvent.detail}`, toolEvent.status, toolEvent.pageNumber);
      });
      if (!ok) throw new Error(result.error ?? 'Agent Runを再開できませんでした。');
      const resumedVisitedPages = Array.isArray(result.visitedPages)
        ? result.visitedPages.map(Number).filter((page: number) => Number.isFinite(page) && page >= 1 && page <= (documentData?.pageCount ?? 120))
        : [];
      const visitedPages = [...new Set([...(pending.visitedPages ?? []), ...resumedVisitedPages])];
      const visitedPageSet = new Set(visitedPages);
      const remainingPages = pending.fullDocument && documentData
        ? documentData.pages.map((page) => page.pageNumber).filter((page) => !visitedPageSet.has(page))
        : pending.remainingPages.filter((page) => !visitedPageSet.has(page));
      const blockedPage = Number(result.blockedPage) || pending.blockedPage;
      if (activeAgentRunRef.current) {
        const completedPages = Math.max(activeAgentRunRef.current.completedPages, visitedPages.length);
        activeAgentRunRef.current = { ...activeAgentRunRef.current, completedPages };
        persistRunHistoryEntry(activeAgentRunRef.current);
      }
      if (result.usage) recordUsage(result.provider as ProviderId, String(result.model ?? settings.model), result.usage as TokenUsage, Math.max(1, Number(result.usage.requests ?? 0)));
      if (streamedActivityCount === 0) {
        const events = (Array.isArray(result.toolEvents) ? result.toolEvents : []) as Array<{ toolName: string; phase: AgentActivityPhase; detail: string; status: 'active' | 'complete' | 'waiting' | 'error'; pageNumber?: number; viewport?: NormalizedTextBox }>;
        for (const event of events) {
          syncViewerToToolEvent(event);
          addAgentActivity(event.phase, `${event.toolName} → ${event.detail}`, event.status, event.pageNumber);
        }
      }
      mergeWorkbookChanges(result.spreadsheetChanges, result.approvalRunId, result.approvalId);
      if (documentData?.documentId) rememberPreparedExports(result.exports, documentData.documentId);
      mergeAnnotationOperations(result.annotationOperations);
      if (documentData?.fileType.toLowerCase() === 'xlsx') {
        try { await refreshWorkbookSummary(documentData.documentId); } catch { /* Keep the live Agent result if the workbook session expired. */ }
      }
      const returnedCandidates = (Array.isArray(result.annotations) ? result.annotations : []) as AnnotationCandidate[];
      const autoAccepted = returnedCandidates.filter((candidate) => candidate.reviewedByHuman || (!candidate.requiresReview && candidate.reviewPriority !== 'high'));
      const needsReview = returnedCandidates.filter((candidate) => !autoAccepted.some((accepted) => accepted.id === candidate.id));
      if (autoAccepted.length) {
        setAnnotations((existing) => {
          const next = new Map(existing.map((item) => [item.id, item]));
          for (const candidate of autoAccepted) next.set(candidate.id, { ...candidate, source: 'ai', requiresReview: false });
          return [...next.values()];
        });
        setSaved(false);
      }
      if (needsReview.length) {
        setCandidates((existing) => [...existing.filter((candidate) => !needsReview.some((item) => item.id === candidate.id)), ...needsReview]);
        setSaved(false);
      }

      if (result.status === 'interrupted' && typeof result.approvalRunId === 'string' && typeof result.approvalId === 'string') {
        const nextContinuation: AgentContinuation = {
          ...pending,
          blockedPage,
          remainingPages,
          visitedPages,
          approvalRunId: result.approvalRunId,
          approvalId: result.approvalId,
          pendingApprovalDecision: undefined,
          decisionContext: pending.decisionContext,
        };
        setAgentContinuation(nextContinuation);
        setAgentStatus('waiting');
        addAgentActivity('Asking', 'Agent paused again for another human approval in the same Run.', 'waiting', blockedPage);
        await waitForRender();
        if (documentData) saveCurrentDocumentWorkspace(documentData.fileName);
        setSaved(true);
        finishRunHistory('waiting', 'Agent Run is paused for another human approval.');
        return;
      }

      if (needsReview.length && (pending.mode === 'assist' || pending.mode === 'autopilot')) {
        setAgentContinuation({ ...pending, blockedPage, remainingPages, visitedPages, approvalRunId: undefined, approvalId: undefined, pendingApprovalDecision: undefined, decisionContext: pending.decisionContext });
        setAgentStatus('waiting');
        addAgentActivity('Asking', `${needsReview.length} additional region${needsReview.length === 1 ? '' : 's'} need review before continuing.`, 'waiting', blockedPage);
        await waitForRender();
        if (documentData) saveCurrentDocumentWorkspace(documentData.fileName);
        setSaved(true);
        finishRunHistory('waiting', `${needsReview.length} additional candidates are waiting for review.`);
        return;
      }

      const decisionContext = pending.decisionContext;
      if (remainingPages.length) {
        const nextContinuation = { ...pending, blockedPage, remainingPages, visitedPages, approvalRunId: undefined, approvalId: undefined, pendingApprovalDecision: undefined, decisionContext };
        setAgentContinuation(null);
        setAgentStatus('running');
        addAgentActivity('Continuing', `The same Agent Run resumed with the human decision; continuing at page ${remainingPages[0]}.`, 'complete', blockedPage);
        await waitForRender();
        await analyzeAgentRef.current?.('all', nextContinuation);
      } else {
        setAgentContinuation(null);
        setAgentStatus('running');
        addAgentActivity('Continuing', 'The Agent Run resumed with the human decision and finished; there are no remaining pages.', 'complete', blockedPage);
        await waitForRender();
        const issueCount = await rerunFinalConsistency();
        setAgentStatus('complete');
        if (documentData) saveCurrentDocumentWorkspace(documentData.fileName);
        setSaved(true);
        finishRunHistory('complete', `Agent Run resumed after approval and finished the document.${issueCount ? ` ${issueCount} consistency finding${issueCount === 1 ? '' : 's'} need human review.` : ''}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Agent Run could not be resumed.';
      setAgentContinuation(null);
      setAgentStatus('error');
      addAgentActivity('Reviewing', detail, 'error', pending.blockedPage);
      setMessage(detail);
      await waitForRender();
      if (documentData) saveCurrentDocumentWorkspace(documentData.fileName);
      setSaved(true);
      finishRunHistory('error', detail);
    } finally {
      setWorking(false);
    }
  };

  const updateSelected = (patch: Partial<Annotation>) => {
    if (!selectedAnnotation) return;
    setAnnotations((items) => items.map((item) => item.id === selectedAnnotation.id ? { ...item, ...patch, source: 'manual', requiresReview: false, reviewedByHuman: true, reviewOutcome: 'corrected' } : item));
    setSaved(false);
  };

  const deleteSelected = () => {
    if (!selectedAnnotation) return;
    setAnnotations((items) => items.filter((item) => item.id !== selectedAnnotation.id));
    setSelectedId(null);
    setSaved(false);
    setMessage('注釈を削除しました。');
  };

  const saveAnnotations = () => {
    if (!documentData) return;
    saveCurrentDocumentWorkspace(documentData.fileName);
    addAgentActivity('Continuing', '注釈、レビュー、タスク指示をローカルに保存しました。');
    setSaved(true);
    setMessage('注釈、確認状態、タスク指示をこのブラウザーに保存しました。');
  };

  const exportJson = () => {
    if (!documentData) return;
    const payload = {
      schemaVersion: 1,
      document: { documentId: documentData.documentId, fileName: documentData.fileName, fileType: documentData.fileType, pageCount: documentData.pageCount },
      task: { instruction: prompt, guidelines, correction, mode: agentMode, model: settings.model, provider: settings.provider, plan: taskPlan?.plan ?? null },
      annotations,
      reviewQueue: candidates,
      humanRejected: rejectedCandidates,
      documentAnnotations: normalizeDocumentAnnotationRecords({ documentId: documentData.documentId, sourceHash: documentData.sourceHash, fileType: documentData.fileType, annotations, candidates, rejectedCandidates, spreadsheetChanges }),
      usage,
      exportedAt: new Date().toISOString(),
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${documentData.fileName.replace(/\.[^.]+$/, '')}-annotations.json`);
    addAgentActivity('Exporting', '構造化JSONを書き出しました。');
    setMessage('注釈・確認待ち・タスク情報を含む構造化JSONを書き出しました。');
  };

  const exportRunHistory = () => {
    if (!documentData || !agentRunHistory.length) return;
    const payload = {
      schemaVersion: 1,
      document: { fileName: documentData.fileName, fileType: documentData.fileType, pageCount: documentData.pageCount },
      exportedAt: new Date().toISOString(),
      runs: agentRunHistory,
    };
    downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${documentData.fileName.replace(/\.[^.]+$/, '')}-history.json`);
    setMessage(`${agentRunHistory.length}件の作業履歴をJSONで保存しました。`);
  };

  const exportCsv = () => {
    if (!documentData) return;
    const headers = ['page', 'status', 'label', 'note', 'reason', 'excerpt', 'review_priority', 'confidence_hint', 'x', 'y', 'width', 'height', 'source'];
    const rows = [
      ...annotations.map((item) => ({ ...item, status: !item.reviewedByHuman && (item.requiresReview || item.reviewPriority === 'high') ? '確認待ち' : '確定' })),
      ...candidates.map((item) => ({ ...item, status: '確認待ち' })),
      ...rejectedCandidates.map((item) => ({ ...item, status: '却下' })),
    ];
    const escape = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = [headers, ...rows.map((item) => [item.pageNumber, item.status, item.label, item.note, item.reason, item.excerpt, item.reviewPriority ?? (item.requiresReview ? 'high' : item.source === 'manual' ? 'low' : 'medium'), item.confidence, item.x, item.y, item.width, item.height, item.source])]
      .map((row) => row.map(escape).join(','))
      .join('\r\n');
    downloadBlob(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }), `${documentData.fileName.replace(/\.[^.]+$/, '')}-annotations.csv`);
    addAgentActivity('Exporting', '注釈とレビュー状態をCSVに書き出しました。');
    setMessage('確定注釈と確認待ちをCSVに書き出しました。');
  };

  const exportAnnotatedWord = async () => {
    if (!documentData || documentData.fileType.toLowerCase() !== 'docx' || exportingWord) return;
    const exportableAnnotations = annotations.filter((annotation) => !annotation.requiresReview && (annotation.reviewedByHuman || annotation.reviewPriority !== 'high'));
    if (!exportableAnnotations.length) {
      setMessage('Wordへ書き出す確定注釈がありません。');
      return;
    }
    setExportingWord(true);
    try {
      const response = await apiFetch(`/api/documents/${encodeURIComponent(documentData.documentId)}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'native-annotated', documentAnnotations: normalizeDocumentAnnotationRecords({ documentId: documentData.documentId, sourceHash: documentData.sourceHash, fileType: documentData.fileType, ...documentAnnotationView }) }),
      }, settings.apiServerUrl);
      if (!response.ok) throw new Error((await response.json()).error ?? 'Wordコメントを書き出せませんでした。');
      const commentCount = Number(response.headers.get('X-Word-Comments-Added') ?? 0);
      const skippedCount = Number(response.headers.get('X-Document-Export-Skipped') ?? 0);
      const baseName = documentData.fileName.replace(/\.docx$/i, '').split(/[\\/]/).at(-1) || 'document';
      downloadBlob(await response.blob(), `${baseName}-annotated.docx`);
      addAgentActivity('Exporting', `Wordコメントを${commentCount}段落に書き出しました。${skippedCount ? ` ${skippedCount}件は抜粋を特定できずスキップしました。` : ''}`);
      setMessage(`元の文書を変更せず、${commentCount}段落にコメントを追加したDOCXを保存しました。${skippedCount ? `${skippedCount}件は抜粋を特定できずスキップしました。` : ''}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Wordコメントを書き出せませんでした。');
    } finally {
      setExportingWord(false);
    }
  };

  const exportAnnotatedPowerPoint = async () => {
    if (!documentData || documentData.fileType.toLowerCase() !== 'pptx' || exportingPowerPoint) return;
    const exportableAnnotations = annotations.filter((annotation) => !annotation.requiresReview && (annotation.reviewedByHuman || annotation.reviewPriority !== 'high'));
    if (!exportableAnnotations.length) {
      setMessage('PowerPointへ書き出す確定注釈がありません。');
      return;
    }
    setExportingPowerPoint(true);
    try {
      const response = await apiFetch(`/api/documents/${encodeURIComponent(documentData.documentId)}/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'native-annotated', documentAnnotations: normalizeDocumentAnnotationRecords({ documentId: documentData.documentId, sourceHash: documentData.sourceHash, fileType: documentData.fileType, ...documentAnnotationView }) }),
      }, settings.apiServerUrl);
      if (!response.ok) throw new Error((await response.json()).error ?? 'PowerPoint注釈を書き出せませんでした。');
      const addedCount = Number(response.headers.get('X-PPTX-Annotations-Added') ?? 0);
      const slidesModified = Number(response.headers.get('X-PPTX-Slides-Modified') ?? 0);
      const slidesTagged = Number(response.headers.get('X-PPTX-Slides-Tagged') ?? 0);
      const skippedCount = Number(response.headers.get('X-Document-Export-Skipped') ?? 0);
      const baseName = documentData.fileName.replace(/\.pptx$/i, '').split(/[\\/]/).at(-1) || 'presentation';
      downloadBlob(await response.blob(), `${baseName}-annotated.pptx`);
      addAgentActivity('Exporting', `PowerPointの${slidesModified}スライドに${addedCount}件の注釈シェイプと${slidesTagged}件の意味タグを書き出しました。${skippedCount ? ` ${skippedCount}件はスライド位置を特定できずスキップしました。` : ''}`);
      setMessage(`元ファイルを変更せず、${slidesModified}スライドに注釈シェイプと分類・根拠タグを追加したPPTXを保存しました。${skippedCount ? `${skippedCount}件はスライド位置を特定できずスキップしました。` : ''}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'PowerPoint注釈を書き出せませんでした。');
    } finally {
      setExportingPowerPoint(false);
    }
  };

  const exportAnnotatedPdf = async () => {
    if (!documentData || exportingPdf) return;
    setExportingPdf(true);
    setExportProgress({ current: 0, total: documentData.pageCount });
    const activityId = addAgentActivity('Exporting', `${documentData.pageCount}ページの注釈PDFを準備しています。`, 'active');
    setAgentStatus('running');
    try {
      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
      const pdf = await PDFDocument.create();
      pdf.setTitle(`${documentData.fileName} · Annotated`);
      pdf.setAuthor('Annotation Studio');
      const font = await pdf.embedFont(StandardFonts.Helvetica);
      for (const [index, sourcePage] of documentData.pages.entries()) {
        setExportProgress({ current: index + 1, total: documentData.pageCount });
        const dataUrl = await rasterizeDocumentPage(sourcePage.pageNumber);
        const width = Math.max(1, sourcePage.width);
        const height = Math.max(1, sourcePage.height);
        const page = pdf.addPage([width, height]);
        const image = await pdf.embedPng(dataUrl);
        page.drawImage(image, { x: 0, y: 0, width, height });
        const marks = [
          ...annotations.filter((item) => item.pageNumber === sourcePage.pageNumber).map((item) => ({ item, pending: false })),
          ...candidates.filter((item) => item.pageNumber === sourcePage.pageNumber).map((item) => ({ item, pending: true })),
        ];
        marks.forEach(({ item, pending }, markIndex) => {
          const color = pending ? rgb(0.91, 0.57, 0.12) : rgb(...colorComponents(item.color));
          const x = item.x * width;
          const y = height - (item.y + item.height) * height;
          const markWidth = Math.max(1, item.width * width);
          const markHeight = Math.max(1, item.height * height);
          page.drawRectangle({ x, y, width: markWidth, height: markHeight, borderColor: color, borderWidth: 1.5 });
          const tagY = Math.min(height - 13, Math.max(0, height - item.y * height - 13));
          page.drawRectangle({ x, y: tagY, width: 15, height: 13, color });
          page.drawText(String(markIndex + 1), { x: x + 4, y: tagY + 3, size: 8, font, color: rgb(1, 1, 1) });
        });
      }
      const bytes = await pdf.save();
      const pdfBytes = new Uint8Array(bytes.byteLength);
      pdfBytes.set(bytes);
      downloadBlob(new Blob([pdfBytes.buffer], { type: 'application/pdf' }), `${documentData.fileName.replace(/\.[^.]+$/, '')}-annotated.pdf`);
      updateAgentActivity(activityId, { status: 'complete', detail: `${documentData.pageCount}ページの注釈PDFを書き出しました。` });
      setMessage('注釈枠を重ねた視覚的なPDFを書き出しました。ラベルと理由はJSON/CSVに含まれます。');
    } catch (error) {
      updateAgentActivity(activityId, { status: 'error', detail: error instanceof Error ? error.message : '注釈PDFを書き出せませんでした。' });
      setMessage(error instanceof Error ? error.message : '注釈PDFを書き出せませんでした。');
    } finally {
      setExportingPdf(false);
      setExportProgress(null);
      setAgentStatus(candidates.length ? 'waiting' : 'complete');
    }
  };

  const exportSelection = () => {
    if (!selectedAnnotation || !pageImageRef.current) return;
    const image = pageImageRef.current;
    const canvas = document.createElement('canvas');
    const left = Math.round(selectedAnnotation.x * image.naturalWidth);
    const top = Math.round(selectedAnnotation.y * image.naturalHeight);
    const width = Math.max(1, Math.round(selectedAnnotation.width * image.naturalWidth));
    const height = Math.max(1, Math.round(selectedAnnotation.height * image.naturalHeight));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(image, left, top, width, height, 0, 0, width, height);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${selectedAnnotation.label || 'annotation'}-page-${selectedAnnotation.pageNumber}.png`;
      anchor.click();
      URL.revokeObjectURL(url);
      addAgentActivity('Exporting', `${selectedAnnotation.label} の範囲をPNGで抽出しました。`, 'complete', selectedAnnotation.pageNumber);
      setMessage('選択した範囲をPNGで書き出しました。');
    }, 'image/png');
  };

  const goToPage = (nextPage: number) => {
    if (!documentData) return;
    setPageNumber(clamp(nextPage, 1, documentData.pageCount));
    clearAgentViewport();
    setSelectedId(null);
    setDraft(null);
  };

  const recheckCoveragePage = (targetPage: number, sourceRun: AgentRunHistory) => {
    if (!documentData || working) return;
    const page = clamp(targetPage, 1, documentData.pageCount);
    goToPage(page);
    setMessage(`P.${page}を現在のガイドラインで新しい1ページ確認として実行します。`);
    void analyzeDocument('current', {
      remainingPages: [page],
      blockedPage: page,
      ...(documentData.sourceHash ? { sourceHash: documentData.sourceHash } : {}),
      fullDocument: false,
      mode: sourceRun.mode,
      instruction: sourceRun.instruction,
      guidelines,
      correction,
      decisionContext: '',
    });
  };

  const pageStyle = currentPage ? ({ '--page-ratio': `${currentPage.width} / ${currentPage.height}`, '--zoom': agentViewport ? agentViewportScale ?? 1 / Math.max(agentViewport.width, agentViewport.height) : zoom / 100 } as CSSProperties) : undefined;
  const envProviderMatches = (settings.provider === 'azure-openai' && health?.provider === 'azure') ||
    (settings.provider === 'openai-api' && health?.provider === 'openai');
  const apiConfiguredForSession = (settings.provider === 'openai-compatible' && Boolean(settings.endpoint.trim())) ||
    Boolean(apiKey.trim()) || Boolean(health?.aiConfigured && envProviderMatches);
  const aiConfiguredForSession = (settings.provider === 'codex-app-server' && codexModels.length > 0) ||
    apiConfiguredForSession;
  const activeProviderLabel = settings.provider === 'codex-app-server'
    ? 'Codex App Server · ローカルCLI'
    : settings.provider === 'azure-openai'
      ? `Azure OpenAI · ${settings.model}`
      : settings.provider === 'openai-compatible'
        ? `OpenAI互換API · ${settings.model}`
        : `OpenAI API · ${settings.model}`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark"><ScanLine size={19} strokeWidth={2.2} /></div>
          <span className="brand-name">Annotation Studio</span>
          <span className="brand-divider" />
          <span className="brand-section">Visual Document Work Agent</span>
        </div>
        <div className="topbar-actions">
          <div className={`save-status${saved ? '' : ' is-pending'}`}>
            <span className="save-dot">{saved ? <Check size={12} /> : <span />}</span>
            {saved ? '保存済み' : '未保存の変更'}
          </div>
          <button className="button button-secondary top-save" type="button" onClick={saveAnnotations} disabled={!documentData || saved}>
            <CheckCheck size={16} /> 保存
          </button>
          <div className="export-menu">
            <button className="button button-primary" type="button" onClick={selectedAnnotation ? exportSelection : exportJson} disabled={!documentData || exportingPdf || exportingWord || exportingPowerPoint}>
              <Download size={16} /> {selectedAnnotation ? '選択範囲を書き出す' : '注釈を書き出す'} <ChevronDown size={14} />
            </button>
            <div className="export-popover">
              <button type="button" onClick={exportSelection} disabled={!selectedAnnotation}><Download size={15} /> 選択範囲をPNGで保存</button>
              <button type="button" onClick={() => void exportAnnotatedPdf()} disabled={!documentData || exportingPdf}><FileText size={15} /> 注釈入りPDFを保存</button>
              {documentData?.fileType.toLowerCase() === 'docx' && <button type="button" onClick={() => void exportAnnotatedWord()} disabled={exportingWord || !annotations.some((annotation) => !annotation.requiresReview && (annotation.reviewedByHuman || annotation.reviewPriority !== 'high'))}><FileText size={15} /> Wordにコメントを追加して保存</button>}
              {documentData?.fileType.toLowerCase() === 'pptx' && <button type="button" onClick={() => void exportAnnotatedPowerPoint()} disabled={exportingPowerPoint || !annotations.some((annotation) => !annotation.requiresReview && (annotation.reviewedByHuman || annotation.reviewPriority !== 'high'))}><FileText size={15} /> PowerPointに注釈と分類タグを追加して保存</button>}
              <button type="button" onClick={exportCsv}><FileText size={15} /> 注釈一覧をCSVで保存</button>
              <button type="button" onClick={exportJson}><FileText size={15} /> 構造化JSONを保存</button>
              <button type="button" onClick={exportRunHistory} disabled={!agentRunHistory.length}><FileText size={15} /> 作業履歴をJSONで保存</button>
              {documentData && preparedExportsForDocument(documentData.fileName).map((artifact) => <button key={artifact.id} type="button" onClick={() => void downloadPreparedExport(artifact)}><Download size={15} /> Agent出力をダウンロード: {artifact.fileName}</button>)}
            </div>
          </div>
        </div>
      </header>

      <div className="workspace" onDragEnter={handleFileDragEnter} onDragOver={handleFileDragOver} onDragLeave={handleFileDragLeave} onDrop={handleFileDrop}>
        {fileDragActive && <div className="file-drop-overlay" aria-live="polite">
          <div className="file-drop-card">
            <CloudUpload size={28} />
            <strong>ここにドロップして文書を開く</strong>
            <span>PDF · Word · PowerPoint · Excel · PNG · JPEG · WebP · TIFF</span>
          </div>
        </div>}
        <nav className="rail" aria-label="メインナビゲーション">
          <button className="rail-button is-active" type="button" aria-current="page" title="アノテーション"><ScanLine size={19} /><span>注釈</span></button>
          <button className="rail-button" type="button" title="文書を追加" onClick={() => fileInputRef.current?.click()}><Files size={19} /><span>文書</span></button>
          <button className={`rail-button${activeTab === 'workspace' ? ' is-current' : ''}`} type="button" title="プロジェクトフォルダー" onClick={() => { setActiveTab('workspace'); void connectWorkspaceFolder(); }}><FolderOpen size={19} /><span>プロジェクト</span></button>
          <button className="rail-button" type="button" title="接続・使用量設定" onClick={() => setSettingsOpen(true)}><Settings2 size={19} /><span>設定</span></button>
          <button className="rail-button" type="button" title="使い方" onClick={() => { setGuideTab('workflow'); setShowGuide(true); }}><CircleHelp size={19} /><span>ガイド</span></button>
          <div className="rail-spacer" />
          <button className="rail-button rail-settings" type="button" title="AI接続設定を開く" onClick={() => setSettingsOpen(true)}><span className={aiConfiguredForSession ? 'connection-dot is-connected' : 'connection-dot'} /><span>{aiConfiguredForSession ? settings.provider === 'codex-app-server' ? 'Codex' : 'AI接続中' : 'デモ中'}</span></button>
        </nav>

        <main className="main-column">
          <div className="document-toolbar">
            <div className="document-title-wrap">
              <div className="document-icon"><FileText size={18} /></div>
              <div className="document-heading">
                <div className="document-title-row">
                  <h1 title={documentData?.fileName ?? '文書を読み込み中'}>{documentData?.fileName ?? '文書を読み込み中'}</h1>
                  {documentData?.demo && <span className="sample-badge">サンプル</span>}
                  {uploading && <LoaderCircle className="spin" size={15} />}
                </div>
                <span>{documentData ? `${documentData.pageCount} ページ · ${documentData.fileType.toUpperCase()} · ${documentData.elapsedMs} ms` : '変換中…'}</span>
              </div>
              <input ref={fileInputRef} className="visually-hidden" type="file" accept=".pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp,.tif,.tiff" onChange={(event) => void onFileSelected(event.target.files?.[0])} />
              <input
                ref={workspaceFolderInputRef}
                className="visually-hidden"
                type="file"
                multiple
                accept=".pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp,.tif,.tiff"
                {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                onChange={(event) => onWorkspaceFolderSelected(event.target.files)}
              />
              <button className="upload-link" type="button" onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                <Upload size={15} /> 別の文書を開く
              </button>
            </div>
            <div className="page-controls">
              <button type="button" aria-label="前のページ" disabled={pageNumber <= 1 || !documentData} onClick={() => goToPage(pageNumber - 1)}><ArrowLeft size={15} /></button>
              <span>ページ <strong>{pageNumber}</strong> / {documentData?.pageCount ?? '—'}</span>
              <button type="button" aria-label="次のページ" disabled={!documentData || pageNumber >= documentData.pageCount} onClick={() => goToPage(pageNumber + 1)}><ArrowRight size={15} /></button>
              <span className="control-divider" />
              <button type="button" aria-label="ズームアウト" onClick={() => { clearAgentViewport(); setZoom((value) => Math.max(70, value - 10)); }}><ZoomOut size={15} /></button>
              <span className="zoom-readout">{agentViewport ? `${Math.round(100 * (agentViewportScale ?? 1 / Math.max(agentViewport.width, agentViewport.height)))}%` : `${zoom}%`}</span>
              <button type="button" aria-label="ズームイン" onClick={() => { clearAgentViewport(); setZoom((value) => Math.min(130, value + 10)); }}><ZoomIn size={15} /></button>
              <span className="control-divider" />
              <button className="toolbar-help" type="button" title="使い方" aria-label="使い方" onClick={() => { setGuideTab('workflow'); setShowGuide(true); }}><CircleHelp size={16} /></button>
            </div>
          </div>

          {documentData?.needsReview && <div className="conversion-notice"><ShieldAlert size={16} /><span>変換時の警告があります。表示内容を原本と照合してください。</span><button type="button" onClick={() => setMessage(documentData.warnings.join(' · ') || '一部の要素は簡略化されている可能性があります。')}>詳細</button></div>}

          <section className="canvas-zone" aria-label="文書ページ">
            <div className="canvas-hint"><span><MousePointer2 size={14} /> 領域を選択するか、ツールを選んでドラッグ</span><span>{currentAnnotations.length} 件の注釈</span></div>
            <div ref={pageScrollAreaRef} className={`page-scroll-area${agentViewport ? ' is-agent-viewport' : ''}${working || agentViewport ? ' is-agent-scanning' : ''}`}>
              {loadingDemo ? (
                <div className="loading-state"><LoaderCircle className="spin" size={26} /><span>サンプル文書を準備しています</span></div>
              ) : previewLoading ? (
                <div className="loading-state"><LoaderCircle className="spin" size={26} /><span>ページを読み込んでいます</span></div>
              ) : previewError ? (
                <div className="empty-state"><div className="empty-icon"><FileText size={26} /></div><h2>ページを開けません</h2><p>{previewError}</p><button className="button button-primary" type="button" onClick={() => void reopenDocument()}>{documentData?.demo ? 'サンプルを開き直す' : '文書を再選択'}</button></div>
              ) : currentPage && previewUrl ? (
                <div className={`page-frame-wrap${agentViewport ? ' is-agent-viewport' : ''}`} style={pageStyle}>
                  <div className="page-frame" ref={pageFrameRef}>
                    <img ref={pageImageRef} className="document-page-image" src={previewUrl} alt={`${documentData?.fileName ?? '文書'} の ${pageNumber} ページ`} draggable={false} />
                    <div
                      className={`annotation-layer${activeTool !== 'select' ? ' is-drawing' : ''}`}
                      role="application"
                      aria-label="注釈を配置する文書ページ。選択ツール以外でドラッグすると領域を追加します。"
                      onPointerDown={onCanvasPointerDown}
                      onPointerMove={onCanvasPointerMove}
                      onPointerUp={onCanvasPointerUp}
                      onPointerCancel={() => { setDragStart(null); setDraft(null); }}
                    >
                      {currentCandidates.flatMap((candidate) => visibleAnnotationFragments(candidate).map((fragment, fragmentIndex) => (
                        <button
                          key={`candidate-${candidate.id}-${fragmentIndex}`}
                          type="button"
                          className="annotation-box annotation-candidate-box"
                          style={{ left: `${fragment.x * 100}%`, top: `${fragment.y * 100}%`, width: `${fragment.width * 100}%`, height: `${fragment.height * 100}%`, '--annotation-color': candidate.color } as CSSProperties}
                          aria-label={`${candidate.label}、確認候補${fragmentIndex ? `、位置 ${fragmentIndex + 1}` : ''}、レビュー優先度 ${reviewPriorityLabel(candidate.reviewPriority, true)}、ページ ${candidate.pageNumber}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => { event.stopPropagation(); setActiveTab('ai'); }}
                        >
                          {fragmentIndex === 0 && <><span className="annotation-index">?</span><span className="annotation-tag">{candidate.label || '確認候補'}</span></>}
                        </button>
                      )))}
                      {currentAnnotations.flatMap((annotation, index) => visibleAnnotationFragments(annotation).map((fragment, fragmentIndex) => (
                        <button
                          key={`${annotation.id}-${fragmentIndex}`}
                          type="button"
                          className={`annotation-box${selectedId === annotation.id ? ' is-current' : ''}`}
                          style={{ left: `${fragment.x * 100}%`, top: `${fragment.y * 100}%`, width: `${fragment.width * 100}%`, height: `${fragment.height * 100}%`, '--annotation-color': annotation.color } as CSSProperties}
                          aria-label={`${annotation.label}、${fragmentIndex ? `位置 ${fragmentIndex + 1}、` : ''}ページ ${annotation.pageNumber}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => { event.stopPropagation(); setSelectedId(annotation.id); setActiveTab('annotations'); }}
                        >
                          {fragmentIndex === 0 && <><span className="annotation-index">{String(index + 1).padStart(2, '0')}</span><span className="annotation-tag">{annotation.label || 'ラベルなし'}</span></>}
                        </button>
                      )))}
                      {draft && <div className="annotation-box annotation-draft" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${Math.max(0.03, draft.width) * 100}%`, height: `${Math.max(0.025, draft.height) * 100}%` }} />}
                    </div>
                  </div>
                </div>
              ) : !documentData ? (
                <div className="empty-state">
                  <div className="empty-icon"><CloudUpload size={28} /></div>
                  <h2>注釈する文書を読み込みましょう</h2>
                  <p>PDF、Word、PowerPoint、Excelに加え、PNG / JPEG / WebP / TIFF画像を読み込めます。</p>
                  <p className="empty-drop-hint">ファイルをこの画面へドラッグ＆ドロップして開くこともできます。</p>
                  <button className="button button-primary" type="button" onClick={() => fileInputRef.current?.click()}><Upload size={16} /> 文書を選択</button>
                </div>
              ) : (
                <div className="loading-state"><LoaderCircle className="spin" size={26} /><span>ページを準備しています</span></div>
              )}
            </div>
            <div className="canvas-footer"><span>{['PNG', 'JPEG', 'WEBP', 'TIFF'].includes(documentData?.fileType.toUpperCase() ?? '') ? '画像を1ページのSVGプレビューとして表示' : <>document-svg <span className="footer-separator">·</span> {documentData?.fileType.toUpperCase() ?? '—'} をページSVGに変換</>}</span><span>{documentData?.needsReview ? '原本との確認が必要です' : 'SVGプレビュー'}</span></div>
          </section>

          <div className="tool-dock" role="toolbar" aria-label="注釈ツール">
            <span className="dock-label">ツール</span>
            <ToolButton selected={activeTool === 'select'} label="選択" onClick={() => setActiveTool('select')}><MousePointer2 size={16} /></ToolButton>
            <ToolButton selected={activeTool === 'rectangle'} label="範囲" onClick={() => setActiveTool('rectangle')}><Square size={16} /></ToolButton>
            <ToolButton selected={activeTool === 'note'} label="テキスト注釈" onClick={() => setActiveTool('note')}><MessageSquareText size={16} /></ToolButton>
            <span className="dock-divider" />
            <button className="dock-export" type="button" disabled={!selectedAnnotation} onClick={exportSelection}><Download size={15} /> 選択箇所を抽出</button>
            <span className="dock-shortcut">Delete で削除</span>
          </div>
        </main>

        <aside className="side-panel" aria-label="Document work agent and annotations">
          <div className="panel-tabs" role="tablist" aria-label="サイドパネル">
            <button type="button" role="tab" aria-selected={activeTab === 'ai'} className={activeTab === 'ai' ? 'is-active' : ''} onClick={() => setActiveTab('ai')}><Sparkles size={15} /> Agent</button>
            <button type="button" role="tab" aria-selected={activeTab === 'annotations'} className={activeTab === 'annotations' ? 'is-active' : ''} onClick={() => setActiveTab('annotations')}><Highlighter size={15} /> 注釈 <span className="tab-count">{annotations.length}</span></button>
            <button type="button" role="tab" aria-selected={activeTab === 'workspace'} className={activeTab === 'workspace' ? 'is-active' : ''} onClick={() => setActiveTab('workspace')}><FolderTree size={15} /> プロジェクト <span className="tab-count">{workspaceProject?.documents.length ?? 0}</span></button>
          </div>

          {activeTab === 'ai' ? (
            <div className="panel-content ai-content">
              <div className="panel-intro">
                <div className="intro-icon"><Sparkles size={16} /></div>
                <div><h2>Visual Document Work Agent</h2><p>文書を開き、ページを読み、注釈し、迷う箇所だけ確認します。</p></div>
              </div>
              {workbookSummary && <section className="workbook-panel" aria-label="Excel workbook">
                <div className="workbook-panel-heading"><div><strong><FileSpreadsheet size={14} /> Excel workbook</strong><span>{workbookSummary.sheets.length} sheets · {spreadsheetChanges.length} cell changes</span></div><button className="button button-secondary" type="button" onClick={() => void exportAnnotatedWorkbook()} disabled={!spreadsheetChanges.some((change) => change.approved)}><Download size={12} /> 編集済みExcelを保存</button></div>
                {settings.provider === 'codex-app-server' && <p className="workbook-provider-note">Codex App Serverはページ画像の確認に対応します。Excelセルを読む・書くToolはOpenAI / Azure / OpenAI互換APIのAgent実行で利用できます。</p>}
                <div className="workbook-sheet-list">{workbookSummary.sheets.slice(0, 8).map((sheet) => <details className="workbook-sheet" key={sheet.name}>
                  <summary><strong>{sheet.name}</strong><span>{sheet.rowCount} rows · {sheet.columnCount} columns</span></summary>
                  <div className="workbook-table-wrap"><table><thead><tr>{sheet.headers.slice(0, 8).map((header, index) => <th key={`${sheet.name}-head-${index}`}>{header || `Column ${index + 1}`}</th>)}</tr></thead><tbody>{sheet.sampleRows.slice(0, 6).map((row) => <tr key={`${sheet.name}-${row.rowNumber}`}>{row.values.slice(0, 8).map((value, index) => <td key={`${row.rowNumber}-${index}`}>{value === null ? '' : String(value)}</td>)}</tr>)}</tbody></table></div>
                </details>)}</div>
                {spreadsheetChanges.length > 0 && <div className="workbook-change-list" aria-label="Agent cell changes">
                  <strong>Agentのセル変更</strong>
                  {spreadsheetChanges.slice(-20).map((change) => {
                    const currentApproval = Boolean(agentContinuation?.approvalId === change.id && change.requiresReview);
                    const operationLabel = change.operation === 'create_column' ? '列を追加' : change.operation === 'write_cell' ? 'セルを更新' : '範囲を更新';
                    const proposedValues = change.values.slice(0, 3).map((row) => row.slice(0, 5).map((value) => value === null ? '空' : String(value)).join(' · ')).join(' / ');
                    return <article className={`workbook-change${change.requiresReview ? ' is-pending' : change.rejected ? ' is-rejected' : ' is-approved'}`} key={change.id}>
                      <div><strong>{change.sheetName}!{change.range}</strong><span>{change.rejected ? '却下' : change.requiresReview ? '承認待ち' : change.approved ? '承認済み' : '適用済み'}</span></div>
                      <p>{operationLabel}: {proposedValues}</p><small>{change.reason}</small>
                      {currentApproval && <div className="workbook-change-actions"><button className="candidate-add" type="button" disabled={working} onClick={() => decideSpreadsheetChange(change, true)}><Check size={13} /> 承認して続行</button><button className="candidate-reject" type="button" disabled={working} onClick={() => decideSpreadsheetChange(change, false)}>却下</button></div>}
                    </article>;
                  })}
                </div>}
              </section>}
              <div className="agent-mode-picker">
                <div className="agent-mode-heading"><span>Agent mode</span><span className={`agent-status-pill is-${agentStatus}`}>{agentStatus === 'ready' ? 'Ready' : agentStatus === 'running' ? 'Working' : agentStatus === 'waiting' ? 'Review needed' : agentStatus === 'error' ? 'Stopped' : 'Complete'}</span></div>
                <div className="agent-mode-grid" role="group" aria-label="Agent mode">
                  {AGENT_MODES.map((mode) => <button key={mode.id} type="button" className={`agent-mode-option${agentMode === mode.id ? ' is-selected' : ''}`} aria-pressed={agentMode === mode.id} onClick={() => { setAgentMode(mode.id); invalidateTaskPlan(); setAgentContinuation(null); setAgentStatus('ready'); setSaved(false); }}><strong>{mode.label}</strong><span>{mode.description}</span></button>)}
                </div>
              </div>
              <label className="field-label" htmlFor="task-preset">タスク例</label>
              <div className="model-select-wrap"><select id="task-preset" value={taskPresetId} onChange={(event) => {
                const preset = TASK_PRESETS.find((item) => item.id === event.target.value);
                setTaskPresetId(event.target.value);
                if (preset) { setPrompt(preset.prompt); setGuidelines(preset.guidelines); invalidateTaskPlan(); setRejectedCandidates([]); setAgentContinuation(null); setAgentStatus('ready'); setSaved(false); }
              }}><option value="">タスク例を選択…</option>{TASK_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select><ChevronDown size={15} /></div>
              <label className="field-label" htmlFor="model-choice">使用モデル</label>
              <div className="model-select-wrap"><select id="model-choice" value={settings.model} onChange={(event) => changeSettings({ model: event.target.value as ModelId })}>{modelCatalog.map((modelItem) => {
                const available = settings.provider !== 'codex-app-server' || !codexModels.length || codexModels.some((item) => item.id === modelItem.id || item.model === modelItem.id);
                return <option key={modelItem.id} value={modelItem.id} disabled={!available}>{modelItem.label}{available ? '' : '（Codex未検出）'}</option>;
              })}</select><ChevronDown size={15} /></div>
              <div className="reasoning-readout"><span>推論レベル <strong>{settings.reasoningEffort}</strong></span><button type="button" onClick={() => setSettingsOpen(true)}>変更</button></div>
              <label className="field-label prompt-label" htmlFor="ai-prompt">抽出の指示</label>
              <textarea id="ai-prompt" className="prompt-input" value={prompt} onChange={(event) => { setPrompt(event.target.value); invalidateTaskPlan(); setRejectedCandidates([]); setAgentContinuation(null); setAgentStatus('ready'); setSaved(false); }} maxLength={2000} placeholder="例：安全上の警告、締結トルクの値を探してください" />
              <div className="prompt-meta"><span>{documentData?.fileType.toLowerCase() === 'xlsx' ? `${workbookSummary?.sheets.length ?? 0}シートを読込み · Agentは表の意味を調べてセルを分類` : aiConfiguredForSession && settings.provider !== 'codex-app-server' ? `${documentData?.pageCount ?? 0}ページ · Agentが検索結果から文書内を移動して確認` : `${documentData?.pageCount ?? 0}ページを順に解析 · 1ページごとにAPIを実行`}</span><span>{prompt.length} / 2000</span></div>
              <label className="field-label prompt-label" htmlFor="annotation-guidelines">アノテーションガイドライン</label>
              <textarea id="annotation-guidelines" className="guideline-input" value={guidelines} onChange={(event) => { setGuidelines(event.target.value); invalidateTaskPlan(); setRejectedCandidates([]); setAgentContinuation(null); setAgentStatus('ready'); setSaved(false); }} maxLength={4000} placeholder="ラベルの定義、判断基準、例外を入力" />
              <div className="task-plan-actions">
                <input ref={guidelineFileInputRef} className="visually-hidden" type="file" accept=".pdf,.docx,.pptx,.xlsx" onChange={(event) => void onGuidelineFileSelected(event.target.files?.[0])} />
                <button className="button button-secondary guideline-import-button" type="button" onClick={() => guidelineFileInputRef.current?.click()} disabled={guidelineImporting || working || batchProgress?.status === 'running'}>
                  {guidelineImporting ? <LoaderCircle className="spin" size={13} /> : <Upload size={13} />}{guidelineImporting ? 'ガイドラインを読込中…' : 'ガイドライン文書を読み込む'}
                </button>
                <button className="button button-secondary task-plan-button" type="button" onClick={() => void prepareTaskPlan(prompt, guidelines, correction, agentMode)} disabled={!prompt.trim() || taskPlanLoading || working || batchProgress?.status === 'running'}>
                  {taskPlanLoading ? <LoaderCircle className="spin" size={13} /> : <Sparkles size={13} />}{taskPlanLoading ? '指示を整理中…' : '指示をTaskに整理'}
                </button>
              </div>
              {taskPlan && <section className="task-plan-card" aria-label="Annotation Task Plan" aria-live="polite">
                <div className="task-plan-heading"><strong>Annotation Task</strong><span className={`task-plan-source is-${taskPlan.source}`}>{taskPlan.source === 'model' ? 'AIで整理' : 'ローカル下書き'}</span></div>
                <h3>{taskPlan.plan.title}</h3>
                <p>{taskPlan.plan.objective}</p>
                <div className="task-plan-labels">{taskPlan.plan.labels.map((label) => <span key={label.name}><strong>{label.name}</strong>{label.description}</span>)}</div>
                <p><strong>操作:</strong> {taskPlan.plan.actions.join(' · ')}</p>
                <p><strong>曖昧な場合:</strong> {taskPlan.plan.uncertaintyPolicy}</p>
                <ol>{taskPlan.plan.workflow.map((step, index) => <li key={`${index}-${step}`}>{step}</li>)}</ol>
              </section>}
              <button className="button button-primary ai-run-button" type="button" onClick={() => void analyzeDocument('all')} disabled={working || uploading || !documentData || Boolean(agentContinuation)}>
                {working ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{working ? 'Agentが作業中…' : agentMode === 'observe' ? '文書を読み取る' : agentMode === 'suggest' ? '候補を提案' : agentMode === 'autopilot' ? 'Autopilotを開始' : 'Assistで全ページを実行'}
              </button>
              <button className="button button-secondary page-run-button" type="button" onClick={() => void analyzeDocument('current')} disabled={working || uploading || !currentPage || agentMode === 'autopilot' || Boolean(agentContinuation)}>
                {working ? 'Agentが作業中…' : `現在のページ（${pageNumber}）だけ実行`}
              </button>
              {workspaceProject && <button className="button button-secondary workspace-run-button" type="button" onClick={() => void runWorkspaceBatch()} disabled={working || uploading || batchProgress?.status === 'running' || !workspaceProject.connected || !workspaceProject.documents.some((item) => item.selected)}><FolderTree size={14} /> プロジェクトの選択文書を一括実行（{workspaceProject.documents.filter((item) => item.selected).length}件）</button>}
              {batchProgress && <div className="scan-progress workspace-progress" role="status"><div className="progress-copy"><span>{batchProgress.status === 'running' ? `${batchProgress.fileName} を処理中` : batchProgress.status === 'stopped' ? '一括実行を停止しました' : 'プロジェクトを処理しました'}</span><span>{batchProgress.current} / {batchProgress.total}</span></div><div className="progress-track"><span style={{ width: `${Math.round(batchProgress.current / Math.max(1, batchProgress.total) * 100)}%` }} /></div>{batchProgress.status === 'running' && <button className="workspace-stop-button" type="button" onClick={stopWorkspaceBatch}><StopCircle size={13} /> 現在の文書後に停止</button>}</div>}
              {scanProgress && <div className="scan-progress" role="status"><div className="progress-copy"><span>{scanProgress.scope === 'all' ? '文書全体を解析中' : 'ページを解析中'}</span><span>{scanProgress.current} / {scanProgress.total}</span></div><div className="progress-track"><span style={{ width: `${Math.round(scanProgress.current / scanProgress.total * 100)}%` }} /></div></div>}
              {exportProgress && <div className="scan-progress" role="status"><div className="progress-copy"><span>PDFを書き出し中</span><span>{exportProgress.current} / {exportProgress.total}</span></div><div className="progress-track"><span style={{ width: `${Math.round(exportProgress.current / exportProgress.total * 100)}%` }} /></div></div>}
              <section className="agent-activity-panel" ref={activityPanelRef} aria-label="Agent Activity" aria-live="polite">
                <div className="agent-activity-heading"><div><span className="activity-kicker">LIVE RUN</span><h3>Agent Activity</h3></div><span className={`agent-status-pill is-${agentStatus}`}>{agentStatus === 'ready' ? 'Ready' : agentStatus === 'running' ? 'Working' : agentStatus === 'waiting' ? 'Waiting' : agentStatus === 'error' ? 'Stopped' : 'Complete'}</span></div>
                {agentActivity.length ? (
                  <ol className="agent-activity-list" ref={activityLogRef}>
                    {agentActivity.slice(-24).map((event) => (
                      <li key={event.id} className={`agent-activity-entry is-${event.status}`}>
                        <span className="activity-marker">{event.status === 'active' ? <LoaderCircle className="spin" size={12} /> : event.status === 'waiting' ? <ShieldAlert size={12} /> : event.status === 'error' ? <X size={12} /> : <Check size={12} />}</span>
                        <div className="activity-copy"><div><strong>{event.phase}</strong><span>{event.pageNumber ? `P.${event.pageNumber}` : ''}</span></div><p>{event.detail}</p></div>
                      </li>
                    ))}
                  </ol>
                ) : <p className="agent-activity-empty">Planning → Navigating → Reading → Searching → Annotating → Reviewing → Asking → Exporting</p>}
                {agentRunHistory.length > 0 && (
                  <details className="correction-details run-history-details">
                    <summary>過去の作業履歴（{agentRunHistory.length}件）・この端末に自動保存</summary>
                    <div className="run-history-list">
                      {agentRunHistory.map((run) => (
                        <details className="run-history-item" key={run.id}>
                          <summary>
                            <span>{new Date(run.startedAt).toLocaleString('ja-JP')}</span>
                            <span>{run.mode === 'observe' ? 'Observe' : run.mode === 'suggest' ? 'Suggest' : run.mode === 'autopilot' ? 'Autopilot' : 'Assist'}</span>
                            <span>{run.status === 'complete' ? '完了' : run.status === 'waiting' ? '確認待ち' : run.status === 'error' ? 'エラー' : run.status === 'interrupted' ? '中断' : '実行中'}</span>
                            <span>{run.completedPages} / {run.totalPages}ページ</span>
                          </summary>
                          <p className="run-history-instruction">{run.instruction}</p>
                          {run.summary && <p className="run-history-summary">{run.summary}</p>}
                          {run.humanDecisions?.length ? <section className="run-human-decisions" aria-label="Saved human decisions">
                            <strong>人の判断・修正ルール</strong>
                            <ol>
                              {run.humanDecisions.map((item) => <li key={item.id}>
                                <div className="run-human-decision-meta">
                                  <span>{item.action === 'correct' ? '修正' : item.action === 'approve' ? '承認' : '却下'}</span>
                                  <span>{item.scope === 'remaining_pages' ? `残りページのルール v${item.ruleVersion} · P.${item.appliesFromPage}以降` : 'この候補のみ'}</span>
                                  <button type="button" className="candidate-page" onClick={() => goToPage(item.pageNumber)}>P.{item.pageNumber}</button>
                                </div>
                                <p>{item.text}</p>
                              </li>)}
                            </ol>
                          </section> : null}
                          {run.pageCoverage?.length || run.pageCoverageTargets?.length ? <section className="run-page-coverage" aria-label="Page coverage">
                            <div className="run-page-coverage-heading"><strong>ページ確認範囲</strong><span>{(run.pageCoverage ?? []).filter((item) => item.status === 'checked').length}/{run.pageCoverageTargets?.length ?? run.totalPages} テキスト確認</span></div>
                            <p className="run-page-coverage-summary">
                              該当なし {(run.pageCoverage ?? []).filter((item) => item.status === 'checked' && item.findingCount === 0 && item.reviewCount === 0).length}ページ
                              {(run.pageCoverage ?? []).some((item) => item.warningCount > 0) ? ` · 変換警告 ${(run.pageCoverage ?? []).filter((item) => item.warningCount > 0).length}ページ` : ''}
                              {(run.pageCoverage ?? []).some((item) => item.status === 'image_only') ? ` · 画像のみ ${(run.pageCoverage ?? []).filter((item) => item.status === 'image_only').length}ページ` : ''}
                              {(run.pageCoverage ?? []).some((item) => item.status === 'failed') ? ` · 失敗 ${(run.pageCoverage ?? []).filter((item) => item.status === 'failed').length}ページ` : ''}
                            </p>
                            <ol className="run-page-coverage-list">
                              {(run.pageCoverage ?? []).map((coverage) => <li className={`run-page-coverage-entry is-${coverage.status}`} key={`${run.id}-coverage-${coverage.pageNumber}`}>
                                <button type="button" className="candidate-page" onClick={() => goToPage(coverage.pageNumber)}>P.{coverage.pageNumber}</button>
                                <span className="run-page-coverage-status">{PAGE_COVERAGE_LABELS[coverage.status]}</span>
                                <span className="run-page-coverage-counts">{coverage.findingCount}件該当{coverage.reviewCount ? ` · ${coverage.reviewCount}件確認待ち` : ''}{coverage.warningCount ? ` · 警告${coverage.warningCount}` : ''}{coverage.textBlockCount !== undefined ? ` · テキスト${coverage.textBlockCount}ブロック` : ''}</span>
                                {coverage.detail && <small>{coverage.detail}</small>}
                                {(coverage.status !== 'checked' || coverage.warningCount > 0) && <button type="button" className="candidate-recheck" disabled={working || !documentData} onClick={() => recheckCoveragePage(coverage.pageNumber, run)}>このページを再確認</button>}
                              </li>)}
                            </ol>
                            {run.pageCoverageTargets && run.pageCoverageTargets.filter((page) => !run.pageCoverage?.some((coverage) => coverage.pageNumber === page)).length > 0 && <div className="run-page-coverage-unprocessed">
                              <strong>未処理ページ</strong>
                              {run.pageCoverageTargets.filter((page) => !run.pageCoverage?.some((coverage) => coverage.pageNumber === page)).map((page) => <span className="run-page-unprocessed-entry" key={`${run.id}-unprocessed-${page}`}><button type="button" className="candidate-page" onClick={() => goToPage(page)}>P.{page}</button><button type="button" className="candidate-recheck" disabled={working || !documentData} onClick={() => recheckCoveragePage(page, run)}>再確認</button></span>)}
                            </div>}
                          </section> : null}
                          {run.observationFindings?.length ? <section className="run-history-observation-findings" aria-label="Saved read-only findings">
                            <strong>読み取り結果（{run.observationFindings.length + (run.observationFindingOverflow ?? 0)}件）</strong>
                            <div className="candidate-list">
                              {run.observationFindings.slice(0, 12).map((finding) => <article className="candidate-card observation-card" key={finding.id} style={{ '--annotation-color': finding.color } as CSSProperties}>
                                <div className="candidate-top"><span className="candidate-color" /><span className="candidate-label">{finding.label}</span><span className="review-priority-badge">優先度 {reviewPriorityLabel(finding.reviewPriority, true)}</span><button type="button" className="candidate-page" onClick={() => goToPage(finding.pageNumber)}>P.{finding.pageNumber}</button></div>
                                <p>{finding.note}</p>
                                {finding.reason && <div className="candidate-reason"><strong>理由</strong> {finding.reason}</div>}
                                {finding.excerpt && <blockquote className="candidate-excerpt">「{finding.excerpt}」</blockquote>}
                              </article>)}
                            </div>
                            {(run.observationFindingOverflow ?? 0) > 0 && <small className="consistency-overflow">保存上限を超えたため、ほか {run.observationFindingOverflow} 件はこの履歴に保存されていません。</small>}
                          </section> : null}
                          <ol className="agent-activity-list run-history-events">
                            {run.events.map((event) => (
                              <li key={event.id} className={`agent-activity-entry is-${event.status}`}>
                                <span className="activity-marker">{event.status === 'error' ? <X size={12} /> : event.status === 'waiting' ? <ShieldAlert size={12} /> : <Check size={12} />}</span>
                                <div className="activity-copy"><div><strong>{event.phase}</strong><span>{event.pageNumber ? `P.${event.pageNumber}` : ''}</span></div><p>{event.detail}</p></div>
                              </li>
                            ))}
                          </ol>
                        </details>
                      ))}
                    </div>
                  </details>
                )}
              </section>
              <details className="correction-details">
                <summary>人の修正を反映して再解析</summary>
                <p>修正ルールを加えて全ページを再評価します。人が確定した注釈は残し、AI注釈を更新します。</p>
                <textarea className="guideline-input" value={correction} onChange={(event) => { const next = event.target.value; setCorrection(next); invalidateTaskPlan(); setAgentContinuation((current) => current ? { ...current, correction: next } : null); setAgentStatus(agentContinuation ? 'waiting' : 'ready'); setSaved(false); }} maxLength={2000} placeholder="例：期限が明記されていない解除条項はHigh riskにしてください" />
                <button className="button button-secondary correction-run-button" type="button" onClick={() => void analyzeDocument('all')} disabled={working || !correction.trim() || !documentData}>修正を反映して全ページを再解析</button>
              </details>
              <div className={"connection-note" + (aiConfiguredForSession ? " is-connected" : "")}>
                <span className="connection-dot" />
                {aiConfiguredForSession ? activeProviderLabel : 'API未設定 · デモ候補で試せます'}
              </div>
              {lastUsage && <div className="token-usage-inline">今回の使用量 <strong>{formatTokens(lastUsage.totalTokens)}</strong> tokens <span>入力 {formatTokens(lastUsage.inputTokens)} · 出力 {formatTokens(lastUsage.outputTokens)} · 推論 {formatTokens(lastUsage.reasoningTokens)}</span></div>}

              {visibleObservationFindings.length > 0 && <section className="observation-findings" aria-label="Observe mode findings">
                <div className="section-heading"><div><h3>読み取り結果</h3><span>{visibleObservationFindings.length} 件 · 文書は未変更</span></div></div>
                <p className="observation-findings-intro">Observeモードの候補です。注釈やレビュー状態には追加されていません。</p>
                <div className="candidate-list">
                  {visibleObservationFindings.slice(0, 24).map((finding) => <article className="candidate-card observation-card" key={finding.id} style={{ '--annotation-color': finding.color } as CSSProperties}>
                    <div className="candidate-top"><span className="candidate-color" /><span className="candidate-label">{finding.label}</span><span className="review-priority-badge">確認優先度 {reviewPriorityLabel(finding.reviewPriority, true)}</span><button type="button" className="candidate-page" onClick={() => goToPage(finding.pageNumber)}>P.{finding.pageNumber}</button></div>
                    <p>{finding.note}</p>
                    {finding.reason && <div className="candidate-reason"><strong>理由</strong> {finding.reason}</div>}
                    {finding.excerpt && <blockquote className="candidate-excerpt">「{finding.excerpt}」</blockquote>}
                    {finding.requiresReview && <span className="observation-review-note">人による確認が必要です</span>}
                  </article>)}
                </div>
                {visibleObservationFindings.length > 24 && <details className="observation-findings-extra">
                  <summary>残り {visibleObservationFindings.length - 24} 件を表示</summary>
                  <div className="candidate-list">
                    {visibleObservationFindings.slice(24).map((finding) => <article className="candidate-card observation-card" key={finding.id} style={{ '--annotation-color': finding.color } as CSSProperties}>
                      <div className="candidate-top"><span className="candidate-color" /><span className="candidate-label">{finding.label}</span><span className="review-priority-badge">確認優先度 {reviewPriorityLabel(finding.reviewPriority, true)}</span><button type="button" className="candidate-page" onClick={() => goToPage(finding.pageNumber)}>P.{finding.pageNumber}</button></div>
                      <p>{finding.note}</p>
                      {finding.reason && <div className="candidate-reason"><strong>理由</strong> {finding.reason}</div>}
                      {finding.excerpt && <blockquote className="candidate-excerpt">「{finding.excerpt}」</blockquote>}
                      {finding.requiresReview && <span className="observation-review-note">人による確認が必要です</span>}
                    </article>)}
                  </div>
                </details>}
              </section>}

              {consistencyIssues.length > 0 && <section className="consistency-panel" aria-label="Annotation consistency review">
                <div className="consistency-heading"><div><span className="activity-kicker">FINAL REVIEW</span><h3>一貫性チェック</h3></div><span>{consistencyIssues.length}件</span></div>
                <p className="consistency-intro">同じ抜粋、似た表現、根拠の弱い注釈を確認候補にまとめました。類似判定とValidator Agentの指摘は確認ヒントなので、ページの文脈を見てください。</p>
                {consistencyIssues.slice(0, 12).map((issue) => <article className="consistency-issue" key={issue.id}>
                  <blockquote>{issue.kind === 'model_review' ? issue.validatorTitle : `${issue.kind === 'same_excerpt' ? '同じ抜粋' : '似た抜粋の候補'}：「${issue.excerpt}」`}</blockquote>
                  {issue.validatorReason && <p className="consistency-validator-note"><strong>Validator Agent</strong> · {issue.validatorReason}</p>}
                  {issue.reviewPriority && <span className="consistency-review-priority">確認優先度: {reviewPriorityLabel(issue.reviewPriority)}</span>}
                  <div className="consistency-occurrences">{issue.occurrences.map((occurrence) => <button type="button" key={`${issue.id}-${occurrence.annotationId}`} onClick={() => goToPage(occurrence.pageNumber)}><span>P.{occurrence.pageNumber} · {occurrence.label}</span>{issue.kind !== 'same_excerpt' && <small>「{occurrence.excerpt}」</small>}</button>)}</div>
                </article>)}
                {consistencyIssues.length > 12 && <small className="consistency-overflow">ほか {consistencyIssues.length - 12} 件はActivity履歴で確認できます。</small>}
              </section>}

              {annotationOperations.length > 0 && <section className="annotation-operation-list" aria-label="Agent proposed annotation changes">
                <div className="section-heading"><div><h3>既存注釈への変更</h3><span>{annotationOperations.filter((operation) => operation.status === 'needs_review').length} 件が確認待ち</span></div></div>
                {annotationOperations.slice(-12).map((operation) => {
                  const canDecide = operation.status === 'needs_review'
                    && Boolean(agentContinuation?.approvalRunId)
                    && agentContinuation?.approvalId === operation.approvalId;
                  const statusLabel = operation.status === 'needs_review' ? '承認待ち' : operation.status === 'approved' ? '承認済み' : '却下';
                  return <article className={`candidate-card annotation-operation-card${operation.status === 'needs_review' ? ' is-pending' : ''}`} key={operation.id} style={{ '--annotation-color': '#9275d3' } as CSSProperties}>
                    <div className="candidate-top"><span className="candidate-color" /><span className="candidate-label">{operation.operation === 'update' ? '注釈の変更' : '注釈の削除'}</span><span className="review-priority-badge">{statusLabel}</span><button type="button" className="candidate-page" onClick={() => goToPage(operation.pageNumber)}>P.{operation.pageNumber}</button></div>
                    <p>{operation.existingLabel}{operation.operation === 'update' ? ` → ${operation.proposedLabel ?? operation.existingLabel}` : ' を削除'}</p>
                    {operation.operation === 'update' && operation.proposedNote !== operation.existingNote && <p>{operation.existingNote} → {operation.proposedNote}</p>}
                    <div className="candidate-reason"><strong>理由</strong> {operation.reason}</div>
                    {canDecide && <div className="candidate-actions"><button type="button" className="candidate-add" disabled={working} onClick={() => decideAnnotationOperation(operation, true)}><Check size={14} /> 承認して続行</button><button type="button" className="candidate-reject" disabled={working} onClick={() => decideAnnotationOperation(operation, false)}>却下</button></div>}
                  </article>;
                })}
              </section>}

              <div className="candidate-section" ref={candidateSectionRef}>
                <div className="section-heading"><div><h3>人の確認が必要</h3><span>{candidates.length} 件</span></div></div>
                {agentContinuation && <div className="continuation-note"><ShieldAlert size={14} /><span>ページ {agentContinuation.blockedPage} の判断を待っています。確認すると、同じAgent Runの作業を再開します。</span></div>}
                {aiMode === 'demo' && <div className="demo-note">デモ候補です。実モデルの解析結果ではありません。</div>}
                {candidates.length ? (
                  <div className="candidate-list">
                    {candidates.map((candidate) => (
                      <article className="candidate-card" key={candidate.id} style={{ '--annotation-color': candidate.color } as CSSProperties}>
                        <div className="candidate-top"><span className="candidate-color" /><span className="candidate-label">{candidate.label}</span><span className="review-priority-badge">確認優先度 {reviewPriorityLabel(candidate.reviewPriority, true)}</span><button type="button" className="candidate-page" onClick={() => goToPage(candidate.pageNumber)}>P.{candidate.pageNumber}</button></div>
                        <p>{candidate.note}</p>
                        {candidate.reason && <div className="candidate-reason"><strong>理由</strong> {candidate.reason}</div>}
                        {candidate.excerpt && <blockquote className="candidate-excerpt">「{candidate.excerpt}」</blockquote>}
                        <details className="candidate-correction-editor">
                          <summary>変更して確定</summary>
                          <label>修正ラベル<input value={candidateCorrections[candidate.id]?.label ?? candidate.label} onChange={(event) => setCandidateCorrections((items) => ({ ...items, [candidate.id]: { label: event.target.value, note: items[candidate.id]?.note ?? candidate.note } }))} maxLength={60} /></label>
                          <label>修正メモ<textarea value={candidateCorrections[candidate.id]?.note ?? candidate.note} onChange={(event) => setCandidateCorrections((items) => ({ ...items, [candidate.id]: { label: items[candidate.id]?.label ?? candidate.label, note: event.target.value } }))} maxLength={500} /></label>
                          <label>修正の適用範囲<select value={candidateCorrectionScopes[candidate.id] ?? 'item'} onChange={(event) => setCandidateCorrectionScopes((items) => ({ ...items, [candidate.id]: event.target.value as HumanDecisionScope }))}><option value="item">この候補だけ（初期設定）</option><option value="remaining_pages" disabled={!agentContinuation?.remainingPages.length}>残りのページにも適用するルール</option></select></label>
                          <small>{agentContinuation?.remainingPages.length ? 'この候補だけの修正は別ページへ適用しません。ルールにすると、適用開始ページと版番号を履歴に保存します。' : '残りのページはありません。修正はこの候補だけに適用します。'}</small>
                          <button type="button" className="candidate-add" disabled={working} onClick={() => correctCandidate(candidate)}><Check size={14} /> 変更を反映して続行</button>
                        </details>
                        <div className="candidate-actions"><button type="button" className="candidate-add" onClick={() => addCandidate(candidate)}><Check size={14} /> 確認して追加</button><button type="button" className="candidate-reject" onClick={() => rejectCandidate(candidate)}>却下</button></div>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="candidate-empty"><div className="candidate-empty-icon"><ScanLine size={16} /></div><p>{documentData?.fileType.toLowerCase() === 'xlsx' && agentContinuation?.approvalId ? '領域注釈の候補はありません。Excelセル変更は上のWorkbook欄で確認できます。' : '全ページの解析後、判断が曖昧な候補だけここに表示します。'}</p></div>
                )}
              </div>
            </div>
          ) : activeTab === 'workspace' ? (
            <div className="panel-content workspace-project-content">
              {workspaceProject ? (
                <>
                  <div className="workspace-project-heading">
                    <div className="intro-icon"><FolderTree size={16} /></div>
                    <div><h2>{workspaceProject.name}</h2><p>{workspaceProject.documents.length}件の対応文書 · {workspaceProject.connected ? '接続中' : '再接続が必要'}</p></div>
                  </div>
                  <p className="workspace-project-path">{workspaceProject.rootPath ?? 'ブラウザーで選択したフォルダー'}</p>
                  <button className="button button-secondary workspace-connect-button" type="button" onClick={() => void connectWorkspaceFolder()} disabled={uploading || workspaceBatchActiveRef.current}>
                    <FolderOpen size={14} /> {workspaceProject.connected ? '別のフォルダーを開く' : 'プロジェクトフォルダーに再接続'}
                  </button>
                  <p className="workspace-project-note">対応するPDF / Word / PowerPoint / Excelと画像を読み込みます。元ファイルは変更せず、選択した文書の内容を設定先のAgent APIへ送ります。</p>
                  <div className="workspace-selection-actions">
                    <strong>対象文書 <span>{workspaceProject.documents.filter((item) => item.selected).length} / {workspaceProject.documents.length}</span></strong>
                    <button type="button" onClick={() => persistWorkspaceProject({ ...workspaceProject, documents: workspaceProject.documents.map((item) => ({ ...item, selected: true })) })}>すべて選択</button>
                    <button type="button" onClick={() => persistWorkspaceProject({ ...workspaceProject, documents: workspaceProject.documents.map((item) => ({ ...item, selected: false })) })}>解除</button>
                  </div>
                  <div className="workspace-document-list">
                    {workspaceProject.documents.map((entry) => (
                      <article className="workspace-document-item" key={entry.id}>
                        <label className="workspace-document-select" title="一括実行の対象にする">
                          <input type="checkbox" checked={entry.selected} onChange={(event) => updateWorkspaceDocument(entry.id, { selected: event.target.checked })} />
                        </label>
                        <div className="workspace-document-actions">
                          <button className="workspace-document-open" type="button" onClick={() => void openWorkspaceDocument(entry)} disabled={!workspaceProject.connected || uploading || batchProgress?.status === 'running'}>
                            <FileText size={15} />
                            <span><strong>{entry.relativePath}</strong><small>{entry.status === 'running' ? '実行中' : entry.status === 'complete' ? '完了' : entry.status === 'review' ? '確認待ち' : entry.status === 'error' ? 'エラー' : '未実行'}</small></span>
                          </button>
                          {workspaceExportActions(entry)}
                        </div>
                        {entry.error && <p className="workspace-document-error">{entry.error}</p>}
                      </article>
                    ))}
                    {!workspaceProject.documents.length && <div className="workspace-empty">選択フォルダーに対応文書がありません。</div>}
                  </div>
                  <button className="button button-primary workspace-run-button" type="button" onClick={() => void runWorkspaceBatch()} disabled={!workspaceProject.connected || !workspaceProject.documents.some((item) => item.selected) || working || uploading || batchProgress?.status === 'running'}>
                    {batchProgress?.status === 'running' ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
                    {batchProgress?.status === 'running' ? `${batchProgress.current} / ${batchProgress.total}件を処理中` : `選択した${workspaceProject.documents.filter((item) => item.selected).length}文書をAgentで実行`}
                  </button>
                  <p className="workspace-project-note">Agentは文書を順番に開き、全ページに現在の指示を実行します。曖昧な箇所は文書ごとの確認キューに残し、次の文書へ進みます。</p>
                </>
              ) : (
                <div className="workspace-empty-state">
                  <div className="empty-icon"><FolderOpen size={25} /></div>
                  <h2>プロジェクトを開く</h2>
                  <p>{desktop ? 'ローカルフォルダーをプロジェクトとして選び、その中の文書をまとめて処理できます。' : 'フォルダー内の文書を選び、まとめてAgentに処理させます。'}</p>
                  <button className="button button-primary" type="button" onClick={() => void connectWorkspaceFolder()}><FolderOpen size={15} /> フォルダーを選択</button>
                </div>
              )}
            </div>
          ) : (
            <div className="panel-content annotations-content">
              {selectedAnnotation ? (
                <div className="annotation-editor">
                  <div className="editor-header"><div><span className="eyebrow">選択中の注釈 · ページ {selectedAnnotation.pageNumber}</span><h2>内容を編集</h2></div><button className="icon-button" type="button" aria-label="選択解除" onClick={() => setSelectedId(null)}><X size={16} /></button></div>
                  <label className="field-label" htmlFor="annotation-label">ラベル</label>
                  <input id="annotation-label" className="text-input" value={selectedAnnotation.label} onChange={(event) => updateSelected({ label: event.target.value })} maxLength={60} placeholder="例：安全上の注意" />
                  <label className="field-label" htmlFor="annotation-note">テキスト注釈</label>
                  <textarea id="annotation-note" className="note-input" value={selectedAnnotation.note} onChange={(event) => updateSelected({ note: event.target.value })} maxLength={500} placeholder="この範囲についてのメモや判断理由を記入" />
                  {(selectedAnnotation.reason || selectedAnnotation.excerpt || selectedAnnotation.reviewPriority) && <div className="annotation-evidence">{selectedAnnotation.source === 'ai' && <strong>レビュー優先度 {reviewPriorityLabel(selectedAnnotation.reviewPriority, selectedAnnotation.requiresReview)}</strong>}{selectedAnnotation.reason && <span>判断理由：{selectedAnnotation.reason}</span>}{selectedAnnotation.excerpt && <span>原文：「{selectedAnnotation.excerpt}」</span>}</div>}
                  <span className="field-label color-label">ラベルの色</span>
                  <div className="color-picker">{LABEL_COLORS.map((color) => <button key={color.value} type="button" className={`color-swatch${selectedAnnotation.color === color.value ? ' is-selected' : ''}`} style={{ '--swatch-color': color.value } as CSSProperties} aria-label={`${color.name}を選択`} aria-pressed={selectedAnnotation.color === color.value} onClick={() => updateSelected({ color: color.value })} />)}</div>
                  <div className="editor-actions"><button className="button button-primary" type="button" onClick={saveAnnotations}><Check size={15} /> 保存</button><button className="button button-secondary" type="button" onClick={exportSelection}><Download size={15} /> 範囲を抽出</button></div>
                  <button className="delete-button" type="button" onClick={deleteSelected}><Trash2 size={14} /> この注釈を削除</button>
                </div>
              ) : (
                <div className="annotation-list-wrap">
                  <div className="list-header"><div><h2>ページの注釈</h2><p>注釈を選ぶと範囲と内容を編集できます。</p></div><span className="list-count">{currentAnnotations.length}</span></div>
                  {currentAnnotations.length ? (
                    <div className="annotation-list">
                      {currentAnnotations.map((annotation, index) => (
                        <button key={annotation.id} type="button" className="annotation-list-item" style={{ '--annotation-color': annotation.color } as CSSProperties} onClick={() => setSelectedId(annotation.id)}>
                          <span className="list-number">{String(index + 1).padStart(2, '0')}</span>
                          <span className="list-item-copy"><strong>{annotation.label || 'ラベルなし'}</strong><span>{annotation.note || 'テキスト注釈はありません'}</span></span>
                          <ArrowRight size={15} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="list-empty"><Highlighter size={19} /><p>このページに注釈はありません。<br />AI候補を作るか、範囲ツールで追加できます。</p></div>
                  )}
                  <div className="all-pages-section"><h3>文書全体</h3><div className="page-summary">{documentData?.pageCount ?? 0} ページ <span>·</span> {annotations.length} 件の注釈</div></div>
                  <div className="page-jump-list">{documentData?.pages.map((page) => {
                    const count = annotations.filter((item) => item.pageNumber === page.pageNumber).length;
                    return <button type="button" key={page.pageNumber} className={pageNumber === page.pageNumber ? 'is-current' : ''} onClick={() => goToPage(page.pageNumber)}><span>ページ {String(page.pageNumber).padStart(2, '0')}</span><span>{count} 件</span></button>;
                  })}</div>
                </div>
              )}
            </div>
          )}
          <div className="panel-footer"><span className={"footer-status" + (aiConfiguredForSession ? " is-connected" : "")} /> <span>{settings.provider === 'codex-app-server' ? 'Codex App Server · ローカル認証' : aiConfiguredForSession ? 'キーはリクエスト単位で送信' : 'サンプル文書 · ブラウザーに保存'}</span><button type="button" onClick={() => { setGuideTab('workflow'); setShowGuide(true); }}>ヘルプ</button></div>
        </aside>
      </div>

      {message && <div className="toast" role="status"><Check size={15} /><span>{message}</span><button type="button" aria-label="閉じる" onClick={() => setMessage('')}><X size={14} /></button></div>}

      {showGuide && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowGuide(false); }}>
          <section className="guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">
            <div className="guide-header"><div><span className="eyebrow">ANNOTATION STUDIO</span><h2 id="guide-title">文書の必要な箇所だけを残す</h2></div><button className="icon-button" type="button" aria-label="ガイドを閉じる" onClick={() => setShowGuide(false)}><X size={18} /></button></div>
            <div className="guide-tabs"><button type="button" className={guideTab === 'workflow' ? 'is-active' : ''} onClick={() => setGuideTab('workflow')}>使い方</button><button type="button" className={guideTab === 'concept' ? 'is-active' : ''} onClick={() => setGuideTab('concept')}>画面イメージ</button></div>
            <img className="guide-image" src={guideTab === 'workflow' ? '/examples/annotation-workflow-guide-v2.png' : '/examples/annotation-workspace-concept.png'} alt={guideTab === 'workflow' ? '文書読み込み、AIへの指示、候補確認、必要部分抽出の4ステップ' : 'Annotation Studioのデスクトップ画面コンセプト'} />
            <div className="guide-caption">{guideTab === 'workflow' ? '候補を確認・修正してから保存できます。AIの提案はいつでも人が編集できます。' : 'デザイン検討用のコンセプト画像です。現在の操作画面はこのプレビュー内で動作します。'}</div>
          </section>
        </div>
      )}
      <SettingsDialog
        open={settingsOpen}
        desktop={desktop}
        settings={settings}
        apiKey={apiKey}
        usage={usage}
        codexModels={codexModels}
        codexModelsLoading={codexModelsLoading}
        connectionTest={connectionTest}
        onChange={changeSettings}
        onApiKeyChange={changeApiKey}
        onSave={saveConnectionSettings}
        onClose={() => setSettingsOpen(false)}
        onTestConnection={() => void testConnection()}
        onRefreshCodexModels={() => void refreshCodexModels()}
        onResetUsage={resetUsage}
      />
    </div>
  );
}

export default App;
