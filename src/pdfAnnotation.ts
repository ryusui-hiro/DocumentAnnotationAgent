import { PDFHexString, PDFName, PDFString, type PDFPage } from 'pdf-lib';

export interface PdfTextCommentInput {
  id: string;
  label: string;
  note?: string;
  explanation?: string;
  evidence?: string;
  status: string;
  reviewPriority?: string;
  /** The comment target in the page's PDF coordinate system, after crop/rotation mapping. */
  rect: { x: number; y: number; width: number; height: number };
  color?: { red: number; green: number; blue: number };
}

/** Add a reader-editable Unicode note while retaining every existing page annotation. */
export function appendPdfTextComment(page: PDFPage, input: PdfTextCommentInput): void {
  const { rect } = input;
  const contents = [
    `Label: ${input.label}`,
    `Review status: ${input.status}`,
    input.reviewPriority ? `Review priority: ${input.reviewPriority}` : '',
    input.note?.trim() ? `\nNote:\n${input.note}` : '',
    input.explanation?.trim() ? `\nExplanation:\n${input.explanation}` : '',
    input.evidence?.trim() ? `\nEvidence:\n${input.evidence}` : '',
  ].filter(Boolean).join('\n');
  const color = input.color ?? { red: 0.09, green: 0.5, blue: 0.47 };
  const comment = page.doc.context.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of('Text'),
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    P: page.ref,
    NM: PDFHexString.fromText(`annotation-studio:${input.id}`),
    T: PDFHexString.fromText('Annotation Studio'),
    Subj: PDFHexString.fromText(input.label),
    Contents: PDFHexString.fromText(contents),
    Name: PDFName.of('Comment'),
    Open: false,
    // Print, NoZoom and NoRotate keep the note icon readable in rotated source PDFs.
    F: 28,
    C: [color.red, color.green, color.blue],
    M: PDFString.fromDate(new Date()),
  });
  page.node.addAnnot(page.doc.context.register(comment));
}
