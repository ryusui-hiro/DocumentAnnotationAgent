import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, ExternalLink, Eye, FileText, GitFork, Globe2, Layers3, LoaderCircle, Maximize2, MessageSquareText, MousePointer2, ScanLine, Settings2, Sparkles, Square, StopCircle, Trash2, Upload, X, ZoomIn, ZoomOut } from 'lucide-react';
import { createSvgPreviewUrl, revokeSvgPreviewUrl } from 'document-svg/preview-ui';
import { apiFetch } from '../api';
import { readResponseJson } from '../responseJson';
import { runDocumentPagePool, type PagePoolProgress } from '../documentPagePool';
import { humanLabelRuleLimits, prepareHumanLabelRules, type HumanLabelRule } from '../documentLabelRules';
import { modelCatalog } from '../settings';
import { assetUrl, usesBrowserRuntime } from '../runtime';
import { REPOSITORY_URL } from '../product';
import { languages, useI18n } from '../i18n';
import type { AppSettings, ConvertedDocument, DocumentAnnotationRecord, NormalizedTextBox, ProviderId, TokenUsage } from '../types';
import { cropAnnotationImage, loadExtractionImage, safeExtractionName } from '../extraction';
import { escapeCsvCell } from '../csv';
import { paperBlockColors, paperOcrMarkdown, type PaperBlock, type PaperBlockType, type PaperOcrDemo, type PaperPageResult } from '../paperOcrTypes';
import { consumeIntentStream, type IntentActivity } from '../intentStream';
import { confirmedWorkspaceBlock, markIntentPageIncomplete, reconcileIntentPage, scopeIntentResult } from '../documentWorkspaceState';
import FormulaPreview from './FormulaPreview';
import './paper-ocr.css';

const kinds: PaperBlockType[] = ['region', 'title', 'heading', 'text', 'figure', 'table', 'equation', 'caption'];
const kindNames = {
  region: { ja: '領域', en: 'Region', 'zh-CN': '区域' }, title: { ja: 'タイトル', en: 'Title', 'zh-CN': '标题' },
  heading: { ja: '見出し', en: 'Heading', 'zh-CN': '小标题' }, text: { ja: '本文', en: 'Text', 'zh-CN': '正文' },
  figure: { ja: '図', en: 'Figure', 'zh-CN': '插图' }, table: { ja: '表', en: 'Table', 'zh-CN': '表格' },
  equation: { ja: '数式', en: 'Equation', 'zh-CN': '公式' }, caption: { ja: 'キャプション', en: 'Caption', 'zh-CN': '图注' },
};
const supportedFiles = /\.(pdf|docx|pptx|xlsx|png|jpe?g|webp|tiff?)$/iu;
const acceptFiles = '.pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp,.tif,.tiff';
type ManualTool = 'select' | 'rectangle' | 'note';
type WorkspaceProps = {
  settings: AppSettings; apiKey: string; onBack?: () => void; onOpenSettings?: () => void;
  onUsage?: (provider: ProviderId, model: string, usage: TokenUsage) => void;
};
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const clamp = (value: number) => Math.min(1, Math.max(0, value));
const sourceNumber = (session: PaperOcrDemo, page: number) => session.paper.sourcePages[page - 1] ?? page;
const freshPage = (session: PaperOcrDemo, pageNumber: number): PaperPageResult => ({ pageNumber, sourcePageNumber: sourceNumber(session, pageNumber), blocks: [], warnings: [], model: '', provider: '', generatedAt: '', status: 'unprocessed' });
const replacePage = (session: PaperOcrDemo, page: PaperPageResult): PaperOcrDemo => ({ ...session, pages: [...session.pages.filter((item) => item.pageNumber !== page.pageNumber), page].sort((a, b) => a.pageNumber - b.pageNumber) });
const blockLabel = (block: PaperBlock) => block.label?.trim() || block.type;

/** The same document surface is used for uploads, manual annotation, intent runs, and the optional paper demo. */
export default function PaperOcrWorkspace({ onBack, onOpenSettings, settings, apiKey, onUsage }: WorkspaceProps) {
  const { language, setLanguage, tr } = useI18n();
  const modelLabel = modelCatalog.find((item) => item.id === settings.model)?.label ?? settings.model;
  const [sessions, setSessions] = useState<PaperOcrDemo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PaperBlockType | 'all'>('all');
  const [previewUrls, setPreviewUrls] = useState<Record<number, string>>({});
  const [previewErrors, setPreviewErrors] = useState<Record<number, string>>({});
  const [zoom, setZoom] = useState(1);
  const [showBoxes, setShowBoxes] = useState(true);
  const [activeTool, setActiveTool] = useState<ManualTool>('select');
  const [draft, setDraft] = useState<NormalizedTextBox | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<'ai' | 'export'>('ai');
  const [loading, setLoading] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const [runProgress, setRunProgress] = useState<PagePoolProgress | null>(null);
  const [labelRuleDrafts, setLabelRuleDrafts] = useState<Array<HumanLabelRule & { id: string }>>([]);
  const [activities, setActivities] = useState<IntentActivity[]>([]);
  const [instruction, setInstruction] = useState('Find the important information, annotate the relevant passages, and add concise labels and notes. Keep quoted text in its original language.');
  const fileRef = useRef<HTMLInputElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const resultListRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const dragDepth = useRef(0);
  const drawingRef = useRef<{ x: number; y: number; pointerId: number } | null>(null);
  const session = sessions.find((item) => item.document.documentId === activeId) ?? null;
  const activePage = session?.document.pages.find((page) => page.pageNumber === pageNumber);
  const pageResult = session?.pages.find((page) => page.pageNumber === pageNumber);
  const selected = pageResult?.blocks.find((block) => block.id === selectedId);
  const visibleBlocks = pageResult?.blocks.filter((block) => filter === 'all' || block.type === filter) ?? [];
  const allBlocks = useMemo(() => session?.pages.flatMap((page) => page.blocks) ?? [], [session?.pages]);
  const confirmedCount = allBlocks.filter(confirmedWorkspaceBlock).length;
  const sourcePage = session ? sourceNumber(session, pageNumber) : pageNumber;
  const sourceFormat = session?.document.fileType.toLowerCase() ?? '';
  const locked = busy || loading;
  const navigationLocked = loading || (busy && operation === 'export');
  const preparedLabelRules = prepareHumanLabelRules(labelRuleDrafts);
  const discoveredLabels = [...new Set(allBlocks.filter((block) => block.source === 'ai' && !block.editedByHuman).map((block) => block.label).filter((label): label is string => Boolean(label)))];
  const labelRuleIssueMessages = {
    missing_name: { ja: '定義を入力したラベルには名前を付けてください。', en: 'Give each label definition a name.', 'zh-CN': '请为每个标签定义填写名称。' },
    duplicate_name: { ja: 'ラベル名は重複しないようにしてください。', en: 'Each label needs a unique name.', 'zh-CN': '每个标签名称必须唯一。' },
    too_many: { ja: 'ラベルは24個まで追加できます。', en: 'Add up to 24 labels.', 'zh-CN': '最多可添加 24 个标签。' },
    name_too_long: { ja: 'ラベル名は120文字以内にしてください。', en: 'Keep label names within 120 characters.', 'zh-CN': '标签名称不能超过 120 个字符。' },
    description_too_long: { ja: '定義は1000文字以内にしてください。', en: 'Keep definitions within 1,000 characters.', 'zh-CN': '定义不能超过 1000 个字符。' },
  };
  const latestActivity = activities.at(-1);
  const conversionWarnings = [...new Set([...(session?.document.warnings ?? []), ...(activePage?.warnings ?? [])])];
  if (session?.document.needsReview && !conversionWarnings.length) conversionWarnings.push(tr({ ja: '変換したプレビューを原文と照合してください。', en: 'The document converter marked this preview for review against the source.', 'zh-CN': '文档转换器提示需要将此预览与原文核对。' }));

  useEffect(() => { document.documentElement.lang = language; }, [language]);
  useEffect(() => {
    if (!busy) return;
    const started = Date.now(); setElapsedSeconds(0);
    const timer = setInterval(() => setElapsedSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(timer); }, [notice]);

  const updateSession = (id: string, update: (value: PaperOcrDemo) => PaperOcrDemo) => setSessions((previous) => previous.map((item) => item.document.documentId === id ? update(item) : item));
  const openSession = (value: PaperOcrDemo) => {
    setSessions((previous) => [...previous.filter((item) => item.document.documentId !== value.document.documentId), value]);
    setActiveId(value.document.documentId); setPageNumber(1); setSelectedId(null); setFilter('all'); setZoom(1); setDraft(null); setActiveTool('select'); setActivities([]); setRunProgress(null); setNotice('');
  };
  const loadDemo = async () => {
    if (locked) return;
    const abort = new AbortController(); abortRef.current = abort; setLoading(true); setError('');
    try {
      const response = await apiFetch('/api/demo/paper-ocr', { signal: abort.signal }, settings.apiServerUrl);
      const payload = await readResponseJson<PaperOcrDemo & { error?: string }>(response);
      if (!response.ok) throw new Error(payload.error || 'Could not load the paper demo.');
      openSession({ ...payload, pages: payload.pages.map((page) => ({ ...page, status: 'complete', blocks: page.blocks.map((block) => ({ ...block, source: 'ai', provisional: false })) })) });
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (abortRef.current === abort) setLoading(false); }
  };
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get('view') === 'paper-ocr' && query.get('blank') !== '1') void loadDemo();
  }, []);
  useEffect(() => {
    setPreviewUrls({}); setPreviewErrors({});
    if (!session) return;
    const abort = new AbortController();
    const urls: string[] = [];
    const pages = [...session.document.pages];
    const documentId = session.document.documentId;
    const load = async () => {
      while (pages.length && !abort.signal.aborted) {
        const page = pages.shift()!;
        try {
          const response = await apiFetch(`/api/documents/${documentId}/pages/${page.pageNumber}.svg`, { signal: abort.signal }, settings.apiServerUrl);
          if (!response.ok) throw new Error(`Page ${page.pageNumber}: HTTP ${response.status}`);
          const svg = await response.text();
          if (abort.signal.aborted) return;
          const url = createSvgPreviewUrl(svg); urls.push(url);
          setPreviewUrls((previous) => ({ ...previous, [page.pageNumber]: url }));
        } catch (cause) { if (!abort.signal.aborted) setPreviewErrors((previous) => ({ ...previous, [page.pageNumber]: String(cause) })); }
      }
    };
    for (let worker = 0; worker < 4; worker++) void load();
    return () => { abort.abort(); urls.forEach(revokeSvgPreviewUrl); };
  }, [session?.document.documentId, settings.apiServerUrl]);

  const movePage = (value: number) => { if (!session) return; setPageNumber(Math.max(1, Math.min(session.document.pageCount, value))); setSelectedId(null); setDraft(null); setZoom(1); };
  const selectBlock = (block: PaperBlock) => {
    setSelectedId(block.id);
    requestAnimationFrame(() => resultListRef.current?.querySelector(`[data-block-id="${CSS.escape(block.id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };
  const updateBlock = (id: string, patch: Partial<PaperBlock>) => {
    if (!session || locked) return;
    updateSession(session.document.documentId, (previous) => {
      const page = previous.pages.find((item) => item.pageNumber === pageNumber);
      return page ? replacePage(previous, { ...page, blocks: page.blocks.map((block) => block.id === id ? { ...block, ...patch, editedByHuman: true } : block) }) : previous;
    });
  };
  const deleteBlock = (id: string) => {
    if (!session || locked) return;
    updateSession(session.document.documentId, (previous) => ({ ...previous, pages: previous.pages.map((page) => page.pageNumber === pageNumber ? { ...page, blocks: page.blocks.filter((block) => block.id !== id) } : page) }));
    if (selectedId === id) setSelectedId(null);
  };
  const pagePoint = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  };
  const beginDraw = (event: PointerEvent<HTMLDivElement>) => {
    if (!session || locked || activeTool === 'select' || event.button !== 0) return;
    event.preventDefault();
    const point = pagePoint(event); drawingRef.current = { ...point, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId); setDraft({ ...point, width: 0, height: 0 }); setSelectedId(null); setShowBoxes(true);
  };
  const drawBounds = (event: PointerEvent<HTMLDivElement>): NormalizedTextBox | null => {
    const start = drawingRef.current; if (!start || start.pointerId !== event.pointerId) return null;
    const point = pagePoint(event);
    return { x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) };
  };
  const finishDraw = (event: PointerEvent<HTMLDivElement>) => {
    const start = drawingRef.current; let bbox = drawBounds(event);
    if (!start || !bbox || !session) return;
    drawingRef.current = null; setDraft(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (activeTool === 'note' && bbox.width < .008 && bbox.height < .008) bbox = { x: Math.min(.76, start.x), y: Math.min(.88, start.y), width: .24, height: .12 };
    if (bbox.width < .008 || bbox.height < .008) return;
    const block: PaperBlock = {
      id: `manual-${crypto.randomUUID()}`, type: 'region', bbox, label: activeTool === 'note' ? tr({ ja: 'メモ', en: 'Note', 'zh-CN': '备注' }) : tr({ ja: '新しい注釈', en: 'New annotation', 'zh-CN': '新注释' }),
      note: '', extractedText: '', latex: null, uncertain: false, uncertaintyReason: '', source: 'manual', editedByHuman: true, provisional: false,
    };
    updateSession(session.document.documentId, (previous) => { const page = previous.pages.find((item) => item.pageNumber === pageNumber) ?? freshPage(previous, pageNumber); return replacePage(previous, { ...page, status: page.status === 'unprocessed' ? 'manual' : page.status, blocks: [...page.blocks, block] }); });
    setFilter('all'); setActiveTool('select'); selectBlock(block);
  };
  const openFiles = async (files: File[]) => {
    if (locked || !files.length) return;
    if (files.some((file) => !supportedFiles.test(file.name))) { setError(tr({ ja: 'PDF、Office文書、または画像を選択してください。', en: 'Choose PDF, Office documents, or images.', 'zh-CN': '请选择 PDF、Office 文档或图像。' })); return; }
    const abort = new AbortController(); abortRef.current = abort; setLoading(true); setError('');
    try {
      for (const file of files) {
        const form = new FormData(); form.append('file', file);
        const response = await apiFetch('/api/convert', { method: 'POST', body: form, signal: abort.signal }, settings.apiServerUrl);
        const doc = await readResponseJson<ConvertedDocument & { error?: string; paperSource?: PaperOcrDemo['paper'] }>(response);
        if (!response.ok) throw new Error(doc.error || 'Could not open document.');
        if (!doc.documentId || !doc.pages?.length) throw new Error('The document contains no readable pages.');
        openSession({ document: doc, paper: doc.paperSource ?? { title: file.name, sourceUrl: '', pdfUrl: '', sourcePages: doc.pages.map((page) => page.pageNumber) }, pages: [], provenance: { kind: 'user-upload', uploadedAt: new Date().toISOString(), sourceFileName: file.name } });
      }
    } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (abortRef.current === abort) setLoading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const dropFiles = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void openFiles(Array.from(event.dataTransfer.files)); };

  const runIntent = async () => {
    if (!session || locked || !instruction.trim() || preparedLabelRules.issue) return;
    if (usesBrowserRuntime(settings.apiServerUrl) && !apiKey.trim()) { onOpenSettings?.(); setError(tr({ ja: '設定にAPIエンドポイントとキーを入力してください。', en: 'Enter your API endpoint and key in Settings to run AI.', 'zh-CN': '请在设置中输入 API 端点和密钥以运行 AI。' })); return; }
    const source = session; const abort = new AbortController(); abortRef.current = abort; stopRef.current = false;
    const runId = crypto.randomUUID();
    const labelRules = structuredClone(preparedLabelRules.rules);
    setBusy(true); setOperation('ai'); setError(''); setNotice(''); setActivities([]); setFilter('all'); setShowBoxes(true); setActiveTool('select');
    updateSession(source.document.documentId, (previous) => ({ ...previous, provenance: { ...previous.provenance, lastInstruction: instruction, labelRules, lastRunStartedAt: new Date().toISOString() } }));
    const failPage = (target: number, detail: string) => updateSession(source.document.documentId, (previous) => {
      const page = previous.pages.find((item) => item.pageNumber === target) ?? freshPage(previous, target);
      return replacePage(previous, markIntentPageIncomplete(page, detail));
    });
    try {
      const outcome = await runDocumentPagePool({
        pages: source.document.pages.map((page) => page.pageNumber), concurrency: 3, signal: abort.signal,
        onProgress: setRunProgress,
        onStart: (target) => updateSession(source.document.documentId, (previous) => {
          const page = previous.pages.find((item) => item.pageNumber === target) ?? freshPage(previous, target);
          return replacePage(previous, { ...page, status: 'running', error: undefined, blocks: page.blocks.filter((block) => !block.provisional) });
        }),
        run: async (target, signal) => {
          const pageRunId = `${runId}:p${target}`;
          const response = await apiFetch('/api/ai/intent-stream', {
            method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify({ documentId: source.document.documentId, pageNumber: target, sourcePageNumber: sourceNumber(source, target), instruction, labelRules, model: settings.model, settings: { ...settings, apiKey } }),
          }, settings.apiServerUrl);
          const result = await consumeIntentStream(response, {
            pageNumber: target, labelRules,
            onStart: (value) => setActivities((items) => [...items, { phase: 'Connected', message: `${String(value.model ?? modelLabel)} · ${String(value.provider ?? settings.provider)}`, pageNumber: target }].slice(-60)),
            onActivity: (value) => setActivities((items) => [...items, value].slice(-60)),
            onBlock: (block) => updateSession(source.document.documentId, (previous) => {
              const page = previous.pages.find((item) => item.pageNumber === target) ?? freshPage(previous, target);
              const provisional = { ...block, id: `${pageRunId}:${block.id}`, provisional: true, source: 'ai' as const };
              return replacePage(previous, { ...page, status: 'running', blocks: [...page.blocks.filter((item) => item.id !== provisional.id), provisional] });
            }),
          });
          if (result.sourcePageNumber !== sourceNumber(source, target)) throw new Error('The result does not match the original page number.');
          return scopeIntentResult(result, pageRunId);
        },
        onComplete: (target, result) => {
          updateSession(source.document.documentId, (previous) => replacePage(previous, reconcileIntentPage(previous.pages.find((page) => page.pageNumber === target), result)));
          if (result.usage) onUsage?.(result.provider as ProviderId, result.model, result.usage);
        },
        onFailure: (target, cause) => failPage(target, cause instanceof Error ? cause.message : String(cause)),
        onCancel: (target) => failPage(target, tr({ ja: '停止しました。このページの途中結果は未確認です。', en: 'Stopped. Partial results on this page still need review.', 'zh-CN': '已停止。此页的部分结果仍待审核。' })),
      });
      if (abort.signal.aborted) setNotice(tr({ ja: 'すべての処理を停止しました。完了したページと手動の注釈は保持しています。', en: 'All workers stopped. Completed pages and manual annotations are retained.', 'zh-CN': '所有任务已停止，已保留完成页面和手动注释。' }));
      else if (outcome.failedPages.length) setError(tr({ ja: '{done}ページ完了、{failed}ページ未完了。失敗したページを開いて詳細を確認できます。', en: '{done} pages completed; {failed} pages are incomplete. Open a failed page to inspect the details.', 'zh-CN': '已完成 {done} 页，{failed} 页未完成。打开失败页面即可查看详情。' }, { done: outcome.completedPages.length, failed: outcome.failedPages.length }));
      else setNotice(tr({ ja: '指示に沿った注釈を反映しました。', en: 'Your annotations are ready.', 'zh-CN': '已应用符合指令的注释。' }));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  const rasterPage = async (number: number) => {
    const url = previewUrls[number]; if (!url) throw new Error('Page image is not ready.');
    const image = await loadExtractionImage(url);
    const scale = Math.min(3, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas is unavailable.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/png');
  };
  const cropBlock = async (block: PaperBlock) => {
    if (locked || !confirmedWorkspaceBlock(block)) return;
    setError('');
    try { const image = await loadExtractionImage(await rasterPage(pageNumber)); download(await cropAnnotationImage(image, block.bbox), `p${sourcePage}-${safeExtractionName(blockLabel(block))}.png`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const exportResult = async (format: 'json' | 'csv' | 'md' | 'zip' | 'pdf' | 'native') => {
    if (!session || locked) return;
    setExportOpen(false); setError('');
    const source = session; const name = safeExtractionName(source.document.fileName.replace(/\.[^.]+$/, ''));
    if (format === 'json') { download(new Blob([JSON.stringify(source, null, 2)], { type: 'application/json' }), `${name}-annotations.json`); return; }
    if (format === 'md') { download(new Blob([paperOcrMarkdown(source)], { type: 'text/markdown;charset=utf-8' }), `${name}-notes.md`); return; }
    if (format === 'csv') {
      const rows = [['page', 'source_page', 'category', 'label', 'note', 'text', 'latex', 'needs_review', 'provisional', 'source', 'x', 'y', 'width', 'height'], ...source.pages.flatMap((page) => page.blocks.map((block) => [page.pageNumber, page.sourcePageNumber, block.type, blockLabel(block), block.note ?? '', block.extractedText, block.latex ?? '', block.uncertain, Boolean(block.provisional), block.source ?? 'ai', block.bbox.x, block.bbox.y, block.bbox.width, block.bbox.height]))];
      download(new Blob(['\uFEFF' + rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }), `${name}-annotations.csv`); return;
    }
    const confirmed = source.pages.flatMap((page) => page.blocks.filter(confirmedWorkspaceBlock).map((block) => ({ block, pageNumber: page.pageNumber, sourcePageNumber: page.sourcePageNumber })));
    if (!confirmed.length) { setError(tr({ ja: '先に注釈を追加するか、候補を確認してください。', en: 'Add an annotation or confirm a suggestion first.', 'zh-CN': '请先添加注释或确认候选项。' })); return; }
    setOperation('export'); setBusy(true);
    try {
      if (format === 'zip') {
        const { default: JSZip } = await import('jszip'); const archive = new JSZip(); const manifest = [];
        let currentPage = 0; let image: HTMLImageElement | undefined;
        for (const [index, item] of confirmed.entries()) {
          if (currentPage !== item.pageNumber) { image = await loadExtractionImage(await rasterPage(item.pageNumber)); currentPage = item.pageNumber; }
          const path = `regions/${String(index + 1).padStart(3, '0')}-p${item.sourcePageNumber}-${safeExtractionName(blockLabel(item.block))}.png`;
          const crop = await cropAnnotationImage(image!, item.block.bbox); archive.file(path, await crop.arrayBuffer());
          manifest.push({ ...item.block, pageNumber: item.pageNumber, sourcePageNumber: item.sourcePageNumber, image: path });
        }
        archive.file('manifest.json', JSON.stringify({ document: source.document, annotations: manifest }, null, 2));
        archive.file('notes.md', paperOcrMarkdown({ ...source, pages: source.pages.map((page) => ({ ...page, blocks: page.blocks.filter(confirmedWorkspaceBlock) })) }));
        download(await archive.generateAsync({ type: 'blob', compression: 'DEFLATE' }), `${name}-regions.zip`);
      } else if (format === 'native' || sourceFormat === 'pdf') {
        const records: DocumentAnnotationRecord[] = confirmed.map(({ block, pageNumber: page }) => ({
          id: block.id, documentId: source.document.documentId, sourceHash: source.document.sourceHash,
          target: sourceFormat === 'pptx' ? { kind: 'slide', slide: page, boundingBox: block.bbox } : { kind: 'page', page, boundingBox: block.bbox },
          label: blockLabel(block).slice(0, 120), evidence: block.extractedText.slice(0, 2000), explanation: [block.note, block.latex].filter(Boolean).join('\n').slice(0, 2000),
          note: (block.note ?? '').slice(0, 500), reviewPriority: 'low', status: block.editedByHuman ? 'corrected' : 'auto', color: paperBlockColors[block.type], source: block.source ?? 'ai',
        }));
        const response = await apiFetch(`/api/documents/${source.document.documentId}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'native-annotated', documentAnnotations: records }) }, settings.apiServerUrl);
        if (!response.ok) throw new Error((await readResponseJson(response)).error || 'Export failed.');
        download(await response.blob(), `${name}-annotated.${format === 'native' ? sourceFormat : 'pdf'}`);
        const skipped = Number(response.headers.get('X-Document-Export-Skipped') ?? 0);
        if (skipped) setNotice(tr({ ja: '{count}件は原文内の位置を特定できず、元形式のコピーには含まれていません。', en: '{count} annotations could not be located in the original and were omitted from the native copy.', 'zh-CN': '{count} 条注释无法定位到原文，未包含在原格式副本中。' }, { count: skipped }));
      } else {
        const [{ PDFDocument, rgb }, { appendPdfTextComment }] = await Promise.all([import('pdf-lib'), import('../pdfAnnotation')]);
        const pdf = await PDFDocument.create(); pdf.setTitle(`${source.document.fileName} — Annotated`); pdf.setAuthor('Astra Annotator');
        for (const docPage of source.document.pages) {
          const page = pdf.addPage([Math.max(1, docPage.width), Math.max(1, docPage.height)]);
          const image = await pdf.embedPng(await rasterPage(docPage.pageNumber)); page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
          for (const { block } of confirmed.filter((item) => item.pageNumber === docPage.pageNumber)) {
            const color = paperBlockColors[block.type]; const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
            const rect = { x: block.bbox.x * page.getWidth(), y: (1 - block.bbox.y - block.bbox.height) * page.getHeight(), width: block.bbox.width * page.getWidth(), height: block.bbox.height * page.getHeight() };
            page.drawRectangle({ ...rect, borderColor: rgb(channels[0], channels[1], channels[2]), borderWidth: 1.4 });
            appendPdfTextComment(page, { id: block.id, label: blockLabel(block), note: block.note, evidence: block.extractedText, explanation: block.latex ?? undefined, status: block.editedByHuman ? 'corrected' : 'auto', rect, color: { red: channels[0], green: channels[1], blue: channels[2] } });
          }
        }
        const bytes = Uint8Array.from(await pdf.save()); download(new Blob([bytes.buffer], { type: 'application/pdf' }), `${name}-annotated.pdf`);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const copyText = async (block: PaperBlock) => { try { await navigator.clipboard.writeText(block.latex || block.extractedText || block.note || ''); setNotice(tr({ ja: 'コピーしました。', en: 'Copied.', 'zh-CN': '已复制。' })); } catch { setNotice(tr({ ja: 'テキストを選択してコピーしてください。', en: 'Select the text to copy it.', 'zh-CN': '请选中文字后复制。' })); } };
  const statusName = (page?: PaperPageResult, number?: number) => busy && operation === 'ai' && number !== undefined && runProgress?.queuedPages.includes(number) ? tr({ ja: '待機中', en: 'Queued', 'zh-CN': '排队中' }) : page?.status === 'running' ? tr({ ja: '解析中', en: 'Running', 'zh-CN': '分析中' }) : page?.status === 'incomplete' ? tr({ ja: '未完了', en: 'Incomplete', 'zh-CN': '未完成' }) : page?.status === 'manual' ? tr({ ja: '手動注釈', en: 'Manual', 'zh-CN': '手动注释' }) : page?.generatedAt ? tr({ ja: '解析済み', en: 'Analyzed', 'zh-CN': '已分析' }) : tr({ ja: '未解析', en: 'Not analyzed', 'zh-CN': '未分析' });

  return <div className={`ocr-shell ocr-doc-dropzone${dragging ? ' is-dragging' : ''}`} data-testid="paper-ocr-workspace"
    onDragEnter={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={dropFiles}>
    <header className="ocr-topbar">
      <div className="ocr-brand">{onBack && <button className="ocr-icon-button" onClick={onBack} disabled={locked} aria-label={tr({ ja: '戻る', en: 'Back', 'zh-CN': '返回' })}><ArrowLeft size={18} /></button>}<span className="brand-mark"><ScanLine size={18} /></span><strong>Astra Annotator</strong><span className="ocr-brand-divider" /><span>{tr({ ja: '文書を、使える情報に。', en: 'Make your documents useful.', 'zh-CN': '让文档信息触手可及。' })}</span></div>
      <div className="ocr-header-actions"><a className="ocr-github-link" href={REPOSITORY_URL} target="_blank" rel="noreferrer" aria-label={tr({ ja: 'GitHubでソースコードを見る', en: 'View source on GitHub', 'zh-CN': '在GitHub查看源代码' })}><GitFork size={15} /><span>GitHub</span></a><span className="ocr-model"><Sparkles size={13} /> {modelLabel}</span><label className="ocr-language"><Globe2 size={15} /><select aria-label="Language" value={language} onChange={(event) => setLanguage(event.target.value as typeof language)}>{languages.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label>{onOpenSettings && <button className="ocr-icon-button" onClick={onOpenSettings} disabled={locked} aria-label={tr({ ja: '接続設定', en: 'Connection settings', 'zh-CN': '连接设置' })}><Settings2 size={17} /></button>}
      <div className="ocr-export-wrap" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExportOpen(false); }} onKeyDown={(event) => { if (event.key === 'Escape') setExportOpen(false); }}><button className="ocr-button ocr-dark" disabled={!allBlocks.length || locked} onClick={() => setExportOpen(!exportOpen)} aria-haspopup="menu" aria-expanded={exportOpen}><Download size={15} />{tr({ ja: '書き出す', en: 'Export', 'zh-CN': '导出' })}<ChevronDown size={13} /></button>{exportOpen && <div className="ocr-export-menu" role="menu">
        <button role="menuitem" disabled={!confirmedCount} onClick={() => void exportResult('pdf')}>{tr({ ja: '注釈付きPDF', en: 'Annotated PDF', 'zh-CN': '带注释的 PDF' })}</button>
        {!usesBrowserRuntime(settings.apiServerUrl) && (sourceFormat === 'docx' || sourceFormat === 'pptx') && <button role="menuitem" disabled={!confirmedCount} onClick={() => void exportResult('native')}>{sourceFormat === 'docx' ? tr({ ja: 'コメント付きWord', en: 'Word with comments', 'zh-CN': '带批注的 Word' }) : tr({ ja: '注釈付きPowerPoint', en: 'Annotated PowerPoint', 'zh-CN': '带注释的 PowerPoint' })}</button>}
        <button role="menuitem" disabled={!confirmedCount} onClick={() => void exportResult('zip')}>{tr({ ja: '確定領域PNG + ノート（ZIP）', en: 'Confirmed PNG regions + notes (ZIP)', 'zh-CN': '确认区域 PNG + 笔记（ZIP）' })}</button>
        <button role="menuitem" onClick={() => void exportResult('md')}>{tr({ ja: '抜粋とノート（Markdown）', en: 'Excerpts and notes (Markdown)', 'zh-CN': '摘录与笔记（Markdown）' })}</button>
        <button role="menuitem" onClick={() => void exportResult('json')}>JSON</button><button role="menuitem" onClick={() => void exportResult('csv')}>CSV</button>
      </div>}</div></div>
    </header>
    <input ref={fileRef} className="visually-hidden" data-testid="document-file-input" type="file" multiple accept={acceptFiles} onChange={(event) => void openFiles(Array.from(event.target.files ?? []))} />
    <div className="ocr-workspace">
      <aside className="ocr-documents"><div className="ocr-section-label"><BookOpen size={15} />{tr({ ja: 'ドキュメント', en: 'DOCUMENTS', 'zh-CN': '文档' })}</div><button className="ocr-button ocr-open-file" onClick={() => fileRef.current?.click()} disabled={locked}><Upload size={14} />{tr({ ja: '文書を開く', en: 'Open document', 'zh-CN': '打开文档' })}</button>
        {sessions.length > 0 && <div className="ocr-file-list">{sessions.map((item) => <button key={item.document.documentId} className={item.document.documentId === activeId ? 'is-selected' : ''} aria-current={item.document.documentId === activeId ? 'true' : undefined} disabled={locked} onClick={() => { setActiveId(item.document.documentId); setPageNumber(1); setSelectedId(null); setFilter('all'); setZoom(1); setActivities([]); setError(''); setRunProgress(null); }}><FileText size={14} /><span title={item.document.fileName}>{item.document.fileName}</span></button>)}</div>}
        {session ? <><h1>{session.document.fileName}</h1><p className="ocr-file-meta">{session.document.fileType.toUpperCase()} · {session.document.pageCount} {tr({ ja: 'ページ', en: session.document.pageCount === 1 ? 'page' : 'pages', 'zh-CN': '页' })}</p>{session.paper.sourceUrl && <a className="ocr-source" href={session.paper.sourceUrl} target="_blank" rel="noreferrer">{tr({ ja: '原文を見る', en: 'View source', 'zh-CN': '查看原文' })}<ExternalLink size={12} /></a>}</> : <div className="ocr-empty-pages"><FilesPlaceholder /><span>{tr({ ja: '読み込んだ文書とページがここに並びます。', en: 'Your documents and pages will appear here.', 'zh-CN': '已打开的文档和页面将显示在这里。' })}</span></div>}
        <div className="ocr-page-list">{session?.document.pages.map((page) => { const result = session.pages.find((item) => item.pageNumber === page.pageNumber); return <button className={`ocr-thumbnail${page.pageNumber === pageNumber ? ' is-selected' : ''}`} key={page.pageNumber} disabled={navigationLocked} onClick={() => movePage(page.pageNumber)} aria-label={`${tr({ ja: 'ページ', en: 'Page', 'zh-CN': '页面' })} ${sourceNumber(session, page.pageNumber)}`} aria-current={page.pageNumber === pageNumber ? 'page' : undefined}><span className="ocr-thumbnail-image">{previewUrls[page.pageNumber] ? <img src={previewUrls[page.pageNumber]} alt="" /> : <FileText size={28} />}</span><span><b>{String(sourceNumber(session, page.pageNumber)).padStart(2, '0')}</b><span className={`ocr-page-status is-${result?.status ?? 'unprocessed'}`}>{result?.blocks.length ? `${result.blocks.length} · ${statusName(result, page.pageNumber)}` : statusName(result, page.pageNumber)}</span>{result?.status === 'complete' && <Check size={12} />}</span></button>; })}</div>
        <div className="ocr-source-note"><button onClick={() => void loadDemo()} disabled={locked} data-testid="load-paper-demo">{tr({ ja: '論文の実行結果を試す', en: 'Explore the paper demo', 'zh-CN': '体验论文演示' })}</button>{session?.paper.license && <small>{session.paper.license}</small>}<small>PDF · Word · PowerPoint · Excel · Images</small></div>
      </aside>
      <main className="ocr-viewer"><div className="ocr-viewer-toolbar"><span>{session ? <>{tr({ ja: 'ページ', en: 'Page', 'zh-CN': '页面' })} <strong>{sourcePage}</strong><small>{session.document.fileType.toUpperCase()}</small></> : tr({ ja: 'ドキュメントワークスペース', en: 'Document workspace', 'zh-CN': '文档工作区' })}</span><div><button disabled={!session} className={showBoxes ? 'is-active' : ''} onClick={() => setShowBoxes(!showBoxes)} aria-pressed={showBoxes} aria-label={tr({ ja: '注釈を表示', en: 'Show annotations', 'zh-CN': '显示注释' })}><Eye size={15} /></button><i /><button disabled={!session} onClick={() => setZoom(Math.max(.6, zoom - .2))} aria-label={tr({ ja: '縮小', en: 'Zoom out', 'zh-CN': '缩小' })}><ZoomOut size={15} /></button><span>{Math.round(zoom * 100)}%</span><button disabled={!session} onClick={() => setZoom(Math.min(3, zoom + .2))} aria-label={tr({ ja: '拡大', en: 'Zoom in', 'zh-CN': '放大' })}><ZoomIn size={15} /></button><button disabled={!session} onClick={() => setZoom(1)} aria-label={tr({ ja: 'ページ全体', en: 'Fit page', 'zh-CN': '适合页面' })}><Maximize2 size={15} /></button></div></div>
        <div className="ocr-manual-toolbar" role="toolbar" aria-label={tr({ ja: '手動注釈ツール', en: 'Manual annotation tools', 'zh-CN': '手动注释工具' })}>{([{ tool: 'select', icon: <MousePointer2 size={14} />, text: tr({ ja: '選択', en: 'Select', 'zh-CN': '选择' }) }, { tool: 'rectangle', icon: <Square size={14} />, text: tr({ ja: '範囲', en: 'Rectangle', 'zh-CN': '矩形' }) }, { tool: 'note', icon: <MessageSquareText size={14} />, text: tr({ ja: 'テキスト注釈', en: 'Note', 'zh-CN': '备注' }) }] as const).map(({ tool, icon, text }) => <button key={tool} disabled={!activePage || locked} className={activeTool === tool ? 'is-active' : ''} aria-pressed={activeTool === tool} onClick={() => { setActiveTool(tool); setDraft(null); drawingRef.current = null; }}>{icon}{text}</button>)}{selected && <button disabled={locked || !confirmedWorkspaceBlock(selected)} onClick={() => void cropBlock(selected)}><Download size={14} />PNG</button>}</div>
        <div className="ocr-page-viewport">{loading ? <div className="ocr-loading"><LoaderCircle className="spin" size={25} />{tr({ ja: '文書を開いています', en: 'Opening document', 'zh-CN': '正在打开文档' })}</div> : !session ? <div className="ocr-welcome"><img src={assetUrl('/images/document-sculpture.png')} alt="" /><span className="ocr-section-label">YOUR DOCUMENT, YOUR INTENT</span><h1>{tr({ ja: '必要な情報を、ひとことから。', en: 'Your documents. Your direction.', 'zh-CN': '你的文档，由你定义。' })}</h1><p>{tr({ ja: '文書を開いて、必要なことを伝えるだけ。手動で範囲を囲み、ラベルやメモを付けることもできます。', en: 'Open a document and say what you need. Or mark a region yourself, add a label, and leave a note.', 'zh-CN': '打开文档，说出你的需求。也可以手动框选区域、添加标签和备注。' })}</p><div><button className="ocr-button ocr-dark" onClick={() => fileRef.current?.click()}><Upload size={15} />{tr({ ja: '文書を開く', en: 'Open document', 'zh-CN': '打开文档' })}</button><button className="ocr-button" onClick={() => void loadDemo()}>{tr({ ja: '論文デモを見る', en: 'Explore a paper', 'zh-CN': '查看论文演示' })}</button></div><small>PDF, Word, PowerPoint, Excel, PNG, JPEG, WebP, TIFF</small><a className="ocr-welcome-source" href={REPOSITORY_URL} target="_blank" rel="noreferrer"><GitFork size={13} /><span>github.com/ryusui-hiro/DocumentAnnotationAgent</span><ExternalLink size={11} /></a></div> : activePage && previewUrls[pageNumber] ? <div ref={pageRef} className={`ocr-page${activeTool !== 'select' ? ' is-drawing' : ''}`} style={{ '--ratio': activePage.width / activePage.height, '--ocr-zoom': zoom } as CSSProperties} onPointerDown={beginDraw} onPointerMove={(event) => { const next = drawBounds(event); if (next) setDraft(next); }} onPointerUp={finishDraw} onPointerCancel={() => { drawingRef.current = null; setDraft(null); }}>
          <img src={previewUrls[pageNumber]} draggable={false} alt={`${session.document.fileName} — ${tr({ ja: 'ページ', en: 'Page', 'zh-CN': '页面' })} ${sourcePage}`} />
          {showBoxes && visibleBlocks.map((block, index) => <button key={block.id} className={`ocr-region${block.id === selectedId ? ' is-selected' : ''}${block.uncertain || block.provisional ? ' is-uncertain' : ''}`} aria-label={`${block.label || tr(kindNames[block.type])} ${index + 1}`} style={{ left: `${block.bbox.x * 100}%`, top: `${block.bbox.y * 100}%`, width: `${block.bbox.width * 100}%`, height: `${block.bbox.height * 100}%`, '--block-color': paperBlockColors[block.type] } as CSSProperties} onClick={() => selectBlock(block)}><span>{block.label || tr(kindNames[block.type])}</span></button>)}
          {draft && <div className="ocr-draft-region" style={{ left: `${draft.x * 100}%`, top: `${draft.y * 100}%`, width: `${draft.width * 100}%`, height: `${draft.height * 100}%` }} />}
        </div> : <div className="ocr-loading">{previewErrors[pageNumber] ? <><FileText size={25} /><span>{previewErrors[pageNumber]}</span></> : <><LoaderCircle className="spin" size={25} /><span>{tr({ ja: 'ページを準備しています', en: 'Preparing page', 'zh-CN': '正在准备页面' })}</span></>}</div>}</div>
        <footer className="ocr-viewer-footer"><span>{activeTool === 'select' ? tr({ ja: '注釈を選んで編集できます', en: 'Select an annotation to edit it', 'zh-CN': '选择注释即可编辑' }) : tr({ ja: 'ページ上をドラッグして注釈を追加', en: 'Drag on the page to add an annotation', 'zh-CN': '在页面上拖动以添加注释' })}</span><div><button disabled={!session || pageNumber <= 1 || navigationLocked} onClick={() => movePage(pageNumber - 1)} aria-label={tr({ ja: '前のページ', en: 'Previous page', 'zh-CN': '上一页' })}><ChevronLeft size={15} /></button><span>{session ? pageNumber : 0} / {session?.document.pageCount ?? 0}</span><button disabled={!session || pageNumber >= session.document.pageCount || navigationLocked} onClick={() => movePage(pageNumber + 1)} aria-label={tr({ ja: '次のページ', en: 'Next page', 'zh-CN': '下一页' })}><ChevronRight size={15} /></button></div></footer>
      </main>
      <aside className="ocr-inspector"><div className="ocr-inspector-heading"><div><span className="ocr-section-label">DOCUMENT INTELLIGENCE</span><h2>{tr({ ja: '何を見つけますか？', en: 'What do you need?', 'zh-CN': '你想找到什么？' })}</h2></div><Sparkles size={19} /></div>
        <div className="ocr-instruction"><label htmlFor="ocr-instruction">{tr({ ja: '自然な言葉で指示', en: 'Give an instruction', 'zh-CN': '用自然语言说明需求' })}</label><textarea id="ocr-instruction" value={instruction} maxLength={4000} disabled={locked} onChange={(event) => setInstruction(event.target.value)} placeholder={tr({ ja: '例：期限と金額を囲み、確認事項をメモして', en: 'For example: mark deadlines and amounts, and note anything to check.', 'zh-CN': '例如：标出截止日期和金额，并注明需要检查的事项。' })} />
          <details className="ocr-label-rules">
            <summary><span>{tr({ ja: 'ラベル · 任意', en: 'Labels · optional', 'zh-CN': '标签 · 可选' })}</span>{preparedLabelRules.rules.length > 0 && <small>{preparedLabelRules.rules.length}</small>}</summary>
            <p>{tr({ ja: '空欄ならAIが内容に合うラベルを作ります。指定すると、AIはこの名前と定義に従います。', en: 'Leave this empty for AI-created labels. Define labels here to require these exact names and meanings.', 'zh-CN': '留空时由 AI 根据内容创建标签。在此定义后，AI 将严格使用这些名称和含义。' })}</p>
            {labelRuleDrafts.map((rule, index) => <div className="ocr-label-rule" key={rule.id}>
              <label>{tr({ ja: '名前', en: 'Name', 'zh-CN': '名称' })}<input className="ocr-label-rule-name" data-testid="label-rule-name" aria-label={tr({ ja: 'ラベル名 {index}', en: 'Label name {index}', 'zh-CN': '标签名称 {index}' }, { index: index + 1 })} value={rule.name} maxLength={humanLabelRuleLimits.name} disabled={locked} onChange={(event) => setLabelRuleDrafts((items) => items.map((item) => item.id === rule.id ? { ...item, name: event.target.value } : item))} /></label>
              <label>{tr({ ja: '定義', en: 'Definition', 'zh-CN': '定义' })}<textarea className="ocr-label-rule-definition" data-testid="label-rule-definition" aria-label={tr({ ja: 'ラベル定義 {index}', en: 'Label definition {index}', 'zh-CN': '标签定义 {index}' }, { index: index + 1 })} value={rule.description} maxLength={humanLabelRuleLimits.description} disabled={locked} onChange={(event) => setLabelRuleDrafts((items) => items.map((item) => item.id === rule.id ? { ...item, description: event.target.value } : item))} /></label>
              <button className="ocr-remove-label" disabled={locked} aria-label={tr({ ja: 'ラベル {index} を削除', en: 'Remove label {index}', 'zh-CN': '删除标签 {index}' }, { index: index + 1 })} onClick={() => setLabelRuleDrafts((items) => items.filter((item) => item.id !== rule.id))}><Trash2 size={13} /></button>
            </div>)}
            {preparedLabelRules.issue && <p className="ocr-label-rule-error" role="alert">{tr(labelRuleIssueMessages[preparedLabelRules.issue])}</p>}
            <button className="ocr-add-label" disabled={locked || labelRuleDrafts.length >= humanLabelRuleLimits.count} onClick={() => setLabelRuleDrafts((items) => [...items, { id: crypto.randomUUID(), name: '', description: '' }])}>+ {tr({ ja: 'ラベルを追加', en: 'Add label', 'zh-CN': '添加标签' })}</button>
          </details>
          <div className="ocr-run-row"><span className="ocr-run-scope">{session ? tr({ ja: 'この文書 · {count}ページ', en: session.document.pageCount === 1 ? 'This document · {count} page' : 'This document · {count} pages', 'zh-CN': '此文档 · {count} 页' }, { count: session.document.pageCount }) : tr({ ja: '文書を開くと実行できます', en: 'Open a document to begin', 'zh-CN': '打开文档后即可开始' })}</span><button className="ocr-button ocr-dark" data-testid="run-document" disabled={locked || !session || !instruction.trim() || Boolean(preparedLabelRules.issue)} onClick={() => void runIntent()}>{busy && operation === 'ai' ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{tr({ ja: '実行', en: 'Run', 'zh-CN': '运行' })}</button></div>
          <div className="ocr-run-meta"><span>{settings.provider === 'codex-app-server' ? 'Codex App Server' : settings.provider === 'azure-openai' ? 'Azure OpenAI' : settings.provider === 'openai-compatible' ? 'Compatible API' : 'OpenAI API'}</span>{busy && operation === 'ai' && <button onClick={() => { stopRef.current = true; abortRef.current?.abort(); }}><StopCircle size={12} />{tr({ ja: '停止', en: 'Stop', 'zh-CN': '停止' })}</button>}</div>
        </div>
        {operation === 'ai' && runProgress && <div className="ocr-run-status ocr-parallel-status" role="status">{busy ? <LoaderCircle className="spin" size={16} /> : runProgress.failedPages.length || runProgress.cancelledPages.length ? <StopCircle size={16} /> : <Check size={16} />}<div><strong>{busy ? tr({ ja: '{active}ページを同時処理中', en: runProgress.activePages.length === 1 ? '{active} page processing' : '{active} pages processing', 'zh-CN': '正在并行处理 {active} 页' }, { active: runProgress.activePages.length }) : runProgress.failedPages.length || runProgress.cancelledPages.length ? tr({ ja: '実行は一部未完了です', en: 'Run incomplete', 'zh-CN': '运行尚未全部完成' }) : tr({ ja: '実行完了', en: 'Run complete', 'zh-CN': '运行完成' })}</strong><span>{tr({ ja: '完了 {done}/{total} · 失敗 {failed} · 停止 {cancelled} · {seconds}秒', en: '{done}/{total} complete · {failed} failed · {cancelled} stopped · {seconds}s', 'zh-CN': '已完成 {done}/{total} · 失败 {failed} · 停止 {cancelled} · {seconds} 秒' }, { done: runProgress.completedPages.length, total: runProgress.total, failed: runProgress.failedPages.length, cancelled: runProgress.cancelledPages.length, seconds: elapsedSeconds })}</span><div className="ocr-active-pages">{runProgress.activePages.map((number) => <button key={number} aria-pressed={number === pageNumber} onClick={() => movePage(number)}>{tr({ ja: 'ページ{page}', en: 'Page {page}', 'zh-CN': '第 {page} 页' }, { page: session ? sourceNumber(session, number) : number })}</button>)}{runProgress.failedPages.map((number) => <button className="is-failed" key={number} onClick={() => movePage(number)}>{tr({ ja: '未完了 · ページ{page}', en: 'Incomplete · page {page}', 'zh-CN': '未完成 · 第 {page} 页' }, { page: session ? sourceNumber(session, number) : number })}</button>)}</div></div></div>}
        {latestActivity && <div className="ocr-live-activity" aria-live="polite"><span>P.{latestActivity.pageNumber} · {latestActivity.message}</span></div>}
        {pageResult?.status === 'incomplete' && <div className="ocr-incomplete-note" role="status"><strong>{tr({ ja: 'このページは未完了です', en: 'This page is incomplete', 'zh-CN': '此页尚未完成' })}</strong><p>{pageResult.error}</p></div>}
        <div className="ocr-results-heading"><h3><Layers3 size={15} />{tr({ ja: '注釈', en: 'Annotations', 'zh-CN': '注释' })}<span>{pageResult?.blocks.length ?? 0}</span></h3>{pageResult && <small className={`ocr-page-status is-${pageResult.status ?? 'complete'}`}>{statusName(pageResult)}</small>}</div>
        {!preparedLabelRules.rules.length && discoveredLabels.length > 0 && <div className="ocr-discovered-labels"><strong>{tr({ ja: 'AIが見つけたラベル', en: 'AI-discovered labels', 'zh-CN': 'AI 发现的标签' })}</strong><div>{discoveredLabels.slice(0, 12).map((label) => <span key={label}>{label}</span>)}</div></div>}
        {(pageResult?.blocks.length ?? 0) > 0 && <div className="ocr-filters" aria-label={tr({ ja: '結果を絞り込み', en: 'Filter results', 'zh-CN': '筛选结果' })}><button className={filter === 'all' ? 'is-selected' : ''} onClick={() => { setFilter('all'); setSelectedId(null); }}>{tr({ ja: 'すべて', en: 'All', 'zh-CN': '全部' })}</button>{kinds.filter((kind) => pageResult?.blocks.some((block) => block.type === kind)).map((kind) => <button key={kind} className={filter === kind ? 'is-selected' : ''} onClick={() => { setFilter(kind); setSelectedId(null); }} aria-pressed={filter === kind}><i style={{ background: paperBlockColors[kind] }} />{tr(kindNames[kind])}</button>)}</div>}
        <div className="ocr-results" ref={resultListRef}>{visibleBlocks.length ? visibleBlocks.map((block, index) => <article className={`ocr-result${selectedId === block.id ? ' is-selected' : ''}${block.provisional ? ' is-provisional' : ''}`} key={block.id} data-block-id={block.id} style={{ '--block-color': paperBlockColors[block.type] } as CSSProperties}>
          <button className="ocr-result-title" onClick={() => setSelectedId(selectedId === block.id ? null : block.id)}><span className="ocr-result-number">{String(index + 1).padStart(2, '0')}</span><b>{block.label || tr(kindNames[block.type])}</b>{block.provisional ? <span className="ocr-review-badge">{tr({ ja: '途中結果', en: 'Provisional', 'zh-CN': '临时结果' })}</span> : block.uncertain ? <span className="ocr-review-badge">{tr({ ja: '要確認', en: 'Review', 'zh-CN': '待审核' })}</span> : null}{block.source === 'manual' && <span className="ocr-result-origin">{tr({ ja: '手動', en: 'Manual', 'zh-CN': '手动' })}</span>}<ChevronDown size={13} /></button>
          {selectedId === block.id ? <div className="ocr-result-detail"><label>{tr({ ja: 'ラベル', en: 'Label', 'zh-CN': '标签' })}<input className="ocr-label-input" aria-label={tr({ ja: '注釈ラベル', en: 'Annotation label', 'zh-CN': '注释标签' })} value={block.label ?? tr(kindNames[block.type])} maxLength={120} disabled={locked} onChange={(event) => updateBlock(block.id, { label: event.target.value })} /></label><label>{tr({ ja: 'メモ', en: 'Note', 'zh-CN': '备注' })}<textarea className="ocr-note-input" aria-label={tr({ ja: '注釈メモ', en: 'Annotation note', 'zh-CN': '注释备注' })} value={block.note ?? ''} maxLength={5000} disabled={locked} onChange={(event) => updateBlock(block.id, { note: event.target.value })} /></label><label>{tr({ ja: '原文の抜粋', en: 'Source excerpt', 'zh-CN': '原文摘录' })}<textarea value={block.extractedText} maxLength={18000} disabled={locked} spellCheck={false} onChange={(event) => updateBlock(block.id, { extractedText: event.target.value })} /></label><label>{tr({ ja: '分類', en: 'Category', 'zh-CN': '分类' })}<select value={block.type} disabled={locked} onChange={(event) => updateBlock(block.id, { type: event.target.value as PaperBlockType, ...(event.target.value !== 'equation' ? { latex: null } : {}) })}>{kinds.map((kind) => <option value={kind} key={kind}>{tr(kindNames[kind])}</option>)}</select></label>
            {(block.type === 'equation' || block.latex) && <label>LaTeX{block.latex && <FormulaPreview latex={block.latex} />}<textarea className="ocr-latex" value={block.latex ?? ''} maxLength={5000} disabled={locked} spellCheck={false} onChange={(event) => updateBlock(block.id, { latex: event.target.value })} /></label>}
            {block.uncertaintyReason && <p className="ocr-review-reason">{block.uncertaintyReason}</p>}
            <div className="ocr-result-actions"><button disabled={locked || !confirmedWorkspaceBlock(block)} onClick={() => void cropBlock(block)}><Download size={13} />PNG</button><button onClick={() => void copyText(block)}><Copy size={13} />{tr({ ja: 'コピー', en: 'Copy', 'zh-CN': '复制' })}</button>{(block.uncertain || block.provisional) && <button disabled={locked} onClick={() => updateBlock(block.id, { uncertain: false, provisional: false, uncertaintyReason: '' })}><Check size={13} />{tr({ ja: '確認して確定', en: 'Confirm', 'zh-CN': '确认' })}</button>}<button className="ocr-result-delete" disabled={locked} aria-label={tr({ ja: '注釈を削除', en: 'Delete annotation', 'zh-CN': '删除注释' })} onClick={() => deleteBlock(block.id)}><Trash2 size={13} /></button></div>
          </div> : <button className="ocr-result-preview" onClick={() => selectBlock(block)}>{block.note || block.latex || block.extractedText || tr({ ja: '選択してラベルやメモを追加', en: 'Select to add a label or note', 'zh-CN': '选择后添加标签或备注' })}</button>}
        </article>) : <div className="ocr-no-results"><ScanLine size={24} /><p>{session ? tr({ ja: 'ページ上に手動で注釈を追加するか、必要なことを伝えて実行してください。', en: 'Mark a region yourself, or tell Astra what to find and run your instruction.', 'zh-CN': '手动标记区域，或告诉 Astra 要找什么并运行指令。' }) : tr({ ja: '文書を開くと、ここで注釈を編集できます。', en: 'Open a document to start annotating.', 'zh-CN': '打开文档即可开始添加注释。' })}</p></div>}</div>
        {(activities.length > 0 || conversionWarnings.length > 0 || (pageResult?.warnings.length ?? 0) > 0) && <div className="ocr-quality-note">{conversionWarnings.length > 0 && <details className="ocr-preview-warnings"><summary>{tr({ ja: 'プレビューの警告（{count}件）', en: 'Preview warnings ({count})', 'zh-CN': '预览警告（{count} 条）' }, { count: conversionWarnings.length })}</summary>{conversionWarnings.map((warning, index) => <p key={index}>{warning}</p>)}</details>}{pageResult?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}{activities.length > 0 && <details><summary>{tr({ ja: '実行ログ', en: 'Run activity', 'zh-CN': '运行记录' })}</summary>{activities.map((item, index) => <p key={index}>P.{item.pageNumber} · {item.phase}: {item.message}</p>)}</details>}{pageResult?.generatedAt && <small>{new Date(pageResult.generatedAt).toLocaleString(language)}{pageResult.usage ? ` · ${pageResult.usage.totalTokens.toLocaleString(language)} tokens` : ''}</small>}</div>}
      </aside>
    </div>
    {(error || notice) && <div className={`ocr-notice${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button aria-label={tr({ ja: '閉じる', en: 'Close', 'zh-CN': '关闭' })} onClick={() => { setError(''); setNotice(''); }}><X size={15} /></button></div>}
  </div>;
}
function FilesPlaceholder() { return <FileText size={24} strokeWidth={1.25} />; }
