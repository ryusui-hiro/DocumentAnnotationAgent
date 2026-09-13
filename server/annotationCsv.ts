import type { DocumentAnnotationRecord } from '../src/types';

const headers = [
  'id', 'documentId', 'targetType', 'page', 'slide', 'sheet', 'cellRange', 'x', 'y', 'width', 'height',
  'label', 'evidence', 'explanation', 'reviewPriority', 'status', 'confidence', 'operation', 'values',
];

function cell(value: unknown) {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'string' ? value : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/** Serialize canonical records as RFC-4180-style UTF-8 CSV with a spreadsheet-friendly BOM. */
export function documentAnnotationsToCsv(records: DocumentAnnotationRecord[]) {
  const rows = records.map((record) => {
    const target = record.target;
    const box = target.kind === 'page' || target.kind === 'slide' ? target.boundingBox : undefined;
    return [
      record.id, record.documentId, target.kind,
      target.kind === 'page' ? target.page : '',
      target.kind === 'slide' ? target.slide : '',
      target.kind === 'sheet' ? target.sheet : '',
      target.kind === 'sheet' ? target.cellRange : '',
      box?.x, box?.y, box?.width, box?.height,
      record.label, record.evidence, record.explanation, record.reviewPriority, record.status,
      record.confidence, record.operation, record.values,
    ];
  });
  return Buffer.from(`\uFEFF${[headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}`);
}
