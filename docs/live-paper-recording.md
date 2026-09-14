# Real browser recording

The recording opens the localhost application, selects the authenticated **Codex App Server** provider and **GPT-6 Astra**, uploads the actual selected research-paper PDF, enters the user's instruction, and invokes the model. It does not inject annotation fixtures or replay saved answers. Browser response listeners observe requests and responses without modifying them.

The source is the OpenAI DALL·E paper, [Zero-Shot Text-to-Image Generation](https://proceedings.mlr.press/v139/ramesh21a.html), original pages **1, 2, and 5**. These are three selected pages from an eleven-page paper, not a full-paper OCR benchmark. [Source, license and reproduction notes](paper-ocr-demo.md).

## Current English demo: three pages in parallel

The default workspace is English and blank on startup, with the same simple layout for PDF, Office and image uploads. The final English recording uses the stable localhost app at http://127.0.0.1:3001, without development auto-restarts. It uploads the real selected PDF, adds a manual reviewer note, registers seven exact labels and definitions, and runs GPT-6 Astra on three pages simultaneously.

The three requests began within **1 ms**. All finished in **124.138 seconds** as observed by the browser. The model returned **60 annotations**, including **2 uncertain regions**; the human note was preserved separately. Every AI label exactly matched the seven supplied names. There were **70 distinct visual updates**, with provisional regions visible before any final response. Reported usage was **76,039 tokens**. The browser console reported no errors or warnings.

- Final English videos: `output/recordings/parallel-en/astra-demo-en.mp4` and `astra-demo-en-3x.mp4`.
- Live UI export: `output/recordings/parallel-en/live-results.json`.
- Observed transport and visual changes: `output/recordings/parallel-en/network-evidence.json`.
- Automated verification: `output/recordings/parallel-en/verification.json`.
- Annotated PDF: `output/recordings/parallel-en/annotated-paper.pdf`, three source pages with 59 confirmed PDF comments, including the preserved human note.

The final video joins the live processing capture with a short capture of inspecting the same results. All footage is the actual app viewport. The three-times version changes playback speed uniformly. No model results, annotation growth or UI frames are fabricated.

Labels are optional: without human rules Astra generates labels from the instruction. With names and definitions supplied, the schema and both streaming and final validation require exact label names. Up to three distinct pages run concurrently; duplicate-page runs and a fourth simultaneous page are rejected. Failure of one page does not silently confirm it or cancel the other pages.

Empty, truncated and non-JSON API responses now produce actionable localized errors. Uploads and model calls are not silently retried. The separate reported Chrome receiving-end message was not reproduced in the clean recording browser; its actual source was not established.

## First recording: Japanese UI

The first live browser run completed at 2026-09-14 12:48:10 UTC. The three requests returned 15, 28 and 17 regions: **60 regions**, **4 marked uncertain**, and **74,126 reported tokens**. The final output includes the numbered equation's LaTeX and Table 1's rows and columns. All three responses identify `gpt-6-astra` and `codex-app-server` and have new generation timestamps.

- Full recording: `output/recordings/astra-paper-live.mp4` — 1600×1000, 8:07.64, H.264.
- Three-times playback: `output/recordings/astra-paper-live-3x.mp4` — same frames, speed increased uniformly; 2:42.63.
- Raw browser recording: `output/recordings/astra-paper-live.webm`.
- Exact UI export: `output/recordings/live-ocr-results.json`.
- Observed request/response evidence: `output/recordings/live-network-evidence.json`.
- Extracted equation and table: `output/recordings/live-equation.png`, `output/recordings/live-table.png`.

The browser viewport alone is recorded. Terminal windows, unrelated applications and the operating-system desktop are excluded. The recording includes upload, live page processing, visible results, formula rendering, PNG downloads, JSON export and language switching. The faster copy changes playback speed only; no annotations or UI frames are reconstructed.

## Reading accuracy

The original title, the mathematical meaning of equation (1), the table's numerical cells, and the major figure/caption locations were independently checked against source images. This is not a character-accuracy benchmark. The source's slanted greater-than-or-equal glyph `⩾` is rendered as `≥` in recognized LaTeX; the meaning agrees but the typography differs. Small storefront lettering remains ambiguous and is flagged for review. Preserve these limitations when presenting the demo.

## Visual design

The workspace uses neutral surfaces, a charcoal primary action, restrained coral branding, and distinct annotation colors. It is optimized for the whole PC viewport. The welcome illustration was generated with the built-in ImageGen tool and saved to `public/images/document-sculpture.png`; the exact prompt is in [document-sculpture-prompt.md](visual-design/document-sculpture-prompt.md).
