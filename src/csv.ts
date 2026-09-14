/** Quote one CSV value without allowing document text to become a spreadsheet formula. */
export function escapeCsvCell(value: unknown): string {
  const text = value === null || value === undefined
    ? ''
    : typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  // Quoting alone does not prevent Excel/LibreOffice from evaluating a formula.
  // Preserve real numeric values, while treating imported/AI-authored text literally.
  const literal = typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+@-]/u.test(text) || /^[\t\r\n]/u.test(text))
    ? `'${text}`
    : text;
  return `"${literal.replaceAll('"', '""')}"`;
}
