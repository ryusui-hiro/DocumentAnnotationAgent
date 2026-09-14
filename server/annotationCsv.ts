import type { DocumentAnnotationRecord } from '../src/types';
import { escapeCsvCell } from '../src/csv';

const headers = [
  'id', 'documentId', 'sourceHash', 'targetType', 'page', 'slide', 'sheet', 'cellRange', 'x', 'y', 'width', 'height',
  'fragments', 'textPositionStart', 'textPositionEnd', 'textPositionUnit', 'textQuote', 'textPrefix', 'textSuffix',
  'label', 'evidence', 'explanation', 'reviewPriority', 'status', 'confidence', 'operation', 'values',
];

/** Serialize canonical records as RFC-4180-style UTF-8 CSV with a spreadsheet-friendly BOM. */
export function documentAnnotationsToCsv(records: DocumentAnnotationRecord[]) {
  const rows = records.map((record) => {
    const target = record.target;
    const box = target.kind === 'page' || target.kind === 'slide' ? target.boundingBox : undefined;
    const visualTarget = target.kind === 'page' || target.kind === 'slide' ? target : undefined;
    const textAnchor = visualTarget?.textAnchor;
    return [
      record.id, record.documentId, record.sourceHash, target.kind,
      target.kind === 'page' ? target.page : '',
      target.kind === 'slide' ? target.slide : '',
      target.kind === 'sheet' ? target.sheet : '',
      target.kind === 'sheet' ? target.cellRange : '',
      box?.x, box?.y, box?.width, box?.height,
      visualTarget?.fragments,
      textAnchor?.position.start, textAnchor?.position.end, textAnchor?.position.unit,
      textAnchor?.quote.exact, textAnchor?.quote.prefix, textAnchor?.quote.suffix,
      record.label, record.evidence, record.explanation, record.reviewPriority, record.status,
      record.confidence, record.operation, record.values,
    ];
  });
  return Buffer.from(`\uFEFF${[headers, ...rows].map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')}`);
}
