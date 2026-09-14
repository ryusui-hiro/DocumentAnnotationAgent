import { useEffect, useState } from 'react';
import 'katex/dist/katex.min.css';

export default function FormulaPreview({ latex }: { latex: string }) {
  const [html, setHtml] = useState('');
  useEffect(() => {
    let live = true;
    void import('katex').then(({ default: katex }) => {
      const result = katex.renderToString(latex, { displayMode: true, throwOnError: false, trust: false, strict: 'ignore', maxSize: 12, maxExpand: 1000, macros: {} });
      if (live) setHtml(result);
    });
    return () => { live = false; };
  }, [latex]);
  // Only KaTeX-generated markup enters HTML; its trust:false blocks URL/HTML commands.
  return <div className="ocr-formula-preview" aria-label="LaTeX preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
