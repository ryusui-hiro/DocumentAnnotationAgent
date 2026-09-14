import { assetUrl } from './runtime';
import { importStaticDocument } from './staticDocuments';
import { runStaticIntent, staticTestConnection } from './staticProvider';
import { createSvgPreviewUrl, revokeSvgPreviewUrl } from 'document-svg/preview-ui';
import type { ConvertedDocument, DocumentAnnotationRecord } from './types';
import type { PaperOcrDemo } from './paperOcrTypes';

type LocalDocument = { document: ConvertedDocument; sourceBuffer: Uint8Array; svgs: string[]; pdfTransforms?: number[][] };
const documents = new Map<string, LocalDocument>();
const activePages = new Map<string, Set<number>>();
let demoId: string | undefined;
let demoData: Promise<Omit<PaperOcrDemo, 'document'>> | undefined;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const hash = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer))].map((value) => value.toString(16).padStart(2, '0')).join('');
function register(value: LocalDocument) {
  // Do not evict documents: an explicit limit prevents silent loss of another active file.
  if (documents.size >= 20 && !documents.has(value.document.documentId)) throw failure('This tab already has 20 documents. Export your work and reload before opening more.', 413);
  documents.set(value.document.documentId, value);
  return value.document;
}
async function publishedDemo() {
  return demoData ??= fetch(assetUrl('demos/openai-paper-ocr.json')).then(async (response) => {
    if (!response.ok) throw new Error('The paper demo could not be downloaded.');
    return response.json();
  }).catch((error) => { demoData = undefined; throw error; });
}
function localDocument(id: string) {
  const value = documents.get(id);
  if (!value) throw failure('This document is no longer in browser memory. Open the source file again.', 410);
  return value;
}
async function pageImage(svg: string) {
  const url = createSvgPreviewUrl(svg);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Could not render this document page.')); });
    image.src = url; await loaded;
    const scale = Math.min(4, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas rendering is unavailable.');
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally { revokeSvgPreviewUrl(url); }
}
function streamIntent(body: Record<string, any>, signal?: AbortSignal | null) {
  const source = localDocument(String(body.documentId));
  const pageNumber = Number(body.pageNumber);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > source.svgs.length) throw failure('Choose a valid document page.');
  const pages = activePages.get(source.document.documentId) ?? new Set<number>();
  if (pages.has(pageNumber) || pages.size >= 3) throw failure('This page is already running, or three pages are active. Wait for a page to finish.', 409);
  if (!body.settings?.apiKey?.trim()) throw failure('Enter your API endpoint and key in Settings first.');
  if (body.settings.provider === 'codex-app-server') throw failure('Codex App Server requires a connected document API server. GitHub Pages cannot start a local CLI.', 503);
  pages.add(pageNumber); activePages.set(source.document.documentId, pages);
  const abort = new AbortController(); const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) abort.abort();
  let closed = false;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: string, value: unknown) => { if (!closed) controller.enqueue(new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)); };
      void (async () => {
        try {
          const sourcePageNumber = (source.document as ConvertedDocument & { paperSource?: PaperOcrDemo['paper'] }).paperSource?.sourcePages[pageNumber - 1] ?? pageNumber;
          emit('start', { pageNumber, sourcePageNumber, provider: body.settings.provider, model: body.model });
          emit('activity', { phase: 'analyzing', message: 'Rendering the page in your browser.', pageNumber });
          const imageDataUrl = await pageImage(source.svgs[pageNumber - 1]);
          abort.signal.throwIfAborted();
          const result = await runStaticIntent({ imageDataUrl, instruction: body.instruction, labelRules: body.labelRules, pageNumber, sourcePageNumber, model: body.model, settings: body.settings, signal: abort.signal,
            onBlock: (block) => emit('block', { block, pageNumber }), onActivity: (activity) => emit('activity', { ...activity, pageNumber }) });
          emit('complete', result);
        } catch (error) { if (!abort.signal.aborted) emit('error', { pageNumber, error: error instanceof Error ? error.message : 'The API request failed.' }); }
        finally {
          pages.delete(pageNumber); if (!pages.size) activePages.delete(source.document.documentId);
          signal?.removeEventListener('abort', onAbort);
          if (!closed) { closed = true; controller.close(); }
        }
      })();
    },
    cancel() { closed = true; abort.abort(); },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function exportPdf(source: LocalDocument, records: DocumentAnnotationRecord[]) {
  if (source.document.fileType !== 'pdf') throw failure('Native Office export requires a document API server. Use Annotated PDF, PNG or structured exports in browser mode.', 501);
  if (!Array.isArray(records) || records.length > 500) throw failure('The annotation list is invalid or too large.');
  const [{ PDFDocument, rgb }, { appendPdfTextComment }] = await Promise.all([import('pdf-lib'), import('./pdfAnnotation')]);
  const pdf = await PDFDocument.load(source.sourceBuffer);
  for (const record of records) {
    if (record.documentId !== source.document.documentId || record.sourceHash && record.sourceHash !== source.document.sourceHash) throw failure('An annotation belongs to a different source document.', 409);
    if (['needs_review', 'rejected'].includes(record.status)) continue;
    if (record.target.kind !== 'page') throw failure('PDF export requires page annotations.');
    const pageNumber = record.target.page;
    const page = pdf.getPages()[pageNumber - 1]; const meta = source.document.pages[pageNumber - 1];
    if (!page || !meta) throw failure('An annotation is outside this document.');
    const box = record.target.boundingBox;
    if (![box.x,box.y,box.width,box.height].every(Number.isFinite) || box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001) throw failure('An annotation rectangle is invalid.');
    const m = source.pdfTransforms?.[pageNumber - 1] ?? [1, 0, 0, -1, 0, meta.height];
    const determinant = m[0]*m[3]-m[1]*m[2];
    if (!Number.isFinite(determinant) || determinant === 0) throw failure('PDF page transform is invalid.');
    const point = (x:number,y:number) => { const u=x*meta.width-m[4], v=y*meta.height-m[5]; return { x:(m[3]*u-m[2]*v)/determinant, y:(-m[1]*u+m[0]*v)/determinant }; };
    const corners = [point(box.x,box.y),point(box.x+box.width,box.y),point(box.x,box.y+box.height),point(box.x+box.width,box.y+box.height)];
    const x=Math.min(...corners.map(p=>p.x)), y=Math.min(...corners.map(p=>p.y));
    const rect={x,y,width:Math.max(...corners.map(p=>p.x))-x,height:Math.max(...corners.map(p=>p.y))-y};
    const color = /^#[a-f0-9]{6}$/i.test(record.color ?? '') ? record.color! : '#368379';
    const channels=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
    page.drawRectangle({...rect,borderColor:rgb(channels[0],channels[1],channels[2]),borderWidth:1.4});
    appendPdfTextComment(page,{id:record.id,label:record.label,note:record.note,explanation:record.explanation,evidence:record.evidence,status:record.status,rect,color:{red:channels[0],green:channels[1],blue:channels[2]}});
  }
  return new Response(Uint8Array.from(await pdf.save()).buffer,{headers:{'Content-Type':'application/pdf','X-Document-Export-Skipped':'0'}});
}

/** In a Pages build, these routes never make a request to a nonexistent /api backend. */
export async function staticApiFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    const route = new URL(path,'https://browser.local').pathname;
    if (route === '/api/health') return json({ok:true,provider:'browser',aiConfigured:false,codexAppServerConfigured:false,browserMode:true,models:['gpt-6-astra','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna'],maxUploadMb:30,conversion:'browser'});
    if (route === '/api/demo/paper-ocr') {
      const data=await publishedDemo();
      let source=demoId?documents.get(demoId):undefined;
      if (!source) {
        const [previewResponse,pdfResponse]=await Promise.all([fetch(assetUrl('demos/openai-paper-preview.json')),fetch(assetUrl('demos/openai-paper-selected.pdf'))]);
        if(!previewResponse.ok||!pdfResponse.ok)throw new Error('The paper preview could not be downloaded.');
        const preview=await previewResponse.json(); const sourceBuffer=new Uint8Array(await pdfResponse.arrayBuffer());
        const document:ConvertedDocument={documentId:crypto.randomUUID(),fileName:'openai-paper-selected.pdf',fileType:'pdf',sourceHash:await hash(sourceBuffer),pageCount:preview.pages.length,elapsedMs:0,needsReview:false,warnings:[],demo:true,pages:preview.pages.map((p:any)=>({pageNumber:p.number,width:p.widthPoints,height:p.heightPoints,warnings:[],warningCount:0}))};
        Object.assign(document,{paperSource:data.paper}); source={document,sourceBuffer,svgs:preview.pages.map((p:any)=>p.svg)};register(source);demoId=document.documentId;
      }
      return json({...data,document:source.document});
    }
    if (route === '/api/convert') {
      if (!(init?.body instanceof FormData)) throw failure('Choose a file to open.');
      const file=init.body.get('file'); if(!(file instanceof File))throw failure('Choose a file to open.');
      const source=await importStaticDocument(file);
      if(source.document.fileType==='pdf'){
        const demo=await publishedDemo().catch(()=>undefined);
        if(demo && source.document.sourceHash === (demo.paper as PaperOcrDemo['paper'] & {selectedSha256?:string}).selectedSha256) Object.assign(source.document,{paperSource:demo.paper});
      }
      return json(register(source));
    }
    const pageMatch=route.match(/^\/api\/documents\/([^/]+)\/pages\/(\d+)\.svg$/);
    if(pageMatch){const source=localDocument(pageMatch[1]);const svg=source.svgs[Number(pageMatch[2])-1];if(!svg)throw failure('Page not found.',404);return new Response(svg,{headers:{'Content-Type':'image/svg+xml'}});}
    const identity=route.match(/^\/api\/documents\/([^/]+)\/identity$/);
    if(identity){const {document}=localDocument(identity[1]);return json({documentId:document.documentId,sourceHash:document.sourceHash,fileName:document.fileName});}
    const body=typeof init?.body==='string'?JSON.parse(init.body):{};
    if(route==='/api/ai/test')return json(await staticTestConnection(body.settings,body.model,init?.signal??undefined));
    if(route==='/api/ai/intent-stream')return streamIntent(body,init?.signal);
    const exportMatch=route.match(/^\/api\/documents\/([^/]+)\/export$/);
    if(exportMatch)return await exportPdf(localDocument(exportMatch[1]),body.documentAnnotations);
    if(route==='/api/codex/models')throw failure('Codex App Server needs a connected document API server. The static website cannot launch a CLI.',503);
    return json({error:'This advanced operation requires a connected document API server. The browser workspace supports local import, manual annotations and direct API analysis.'},501);
  }catch(error){const status=error&&typeof error==='object'&&'status'in error?Number(error.status):500;return json({error:error instanceof Error?error.message:'The browser operation failed.'},status>=400&&status<=599?status:500);}
}
