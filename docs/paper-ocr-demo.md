# Real research-paper OCR demo

The demo uses **Zero-Shot Text-to-Image Generation**, the original OpenAI DALL·E paper by Aditya Ramesh, Mikhail Pavlov, Gabriel Goh, Scott Gray, Chelsea Voss, Alec Radford, Mark Chen, and Ilya Sutskever. It is published in PMLR 139:8821–8831 (2021).

- [OpenAI research context](https://openai.com/index/dall-e/)
- [Original publication and citation](https://proceedings.mlr.press/v139/ramesh21a.html)
- [Published PDF](https://proceedings.mlr.press/v139/ramesh21a/ramesh21a.pdf)
- [PMLR publication agreement: CC BY 4.0](https://proceedings.mlr.press/pmlr-license-agreement.html)

The selected PDF contains original pages **1, 2, and 5**, in that order. Their visible content is unchanged. Page 1 includes the title, abstract, paragraphs, and Figure 1; page 2 includes Figure 2 and the actual numbered ELB equation (1); page 5 includes Table 1 and the distributed-training diagram. Source-page numbers are retained in the OCR JSON and viewer.

Each page is sent once to the actual `gpt-6-astra` model through the existing authenticated Codex App Server. Its image is the sole source evidence: no PDF text extraction or expected OCR answer is included in the prompt. The generated blocks retain their original English text, type, normalized rectangle, formula LaTeX when present, and uncertainty flags. Stored demo results are historical real model outputs, separate from synthetic test fixtures. Opening the demo does not invoke a model; a page rerun uses the current selected provider.

The 2026-09-14 live run returned **60 blocks across three pages**, including all seven block types. It transcribed the actual numbered equation into LaTeX and preserved Table 1's three columns and three data rows. Three blocks were marked uncertain by the model. Reported usage totaled **73,012 tokens**; the per-page usage and timestamps are in the saved JSON.

The source PDF's embedded math fonts expose glyph substitutions in the current vector converter. The demo therefore uses Poppler to render faithful source-page PNGs during preparation and embeds the identical PNG bytes inside its SVG previews. This keeps the model image, viewer image, and bounding-box coordinates aligned. Prepared assets need no Poppler installation at app runtime.

## Reproduce

```bash
# Prepare the selected PDF and faithful previews without model calls.
node --import tsx scripts/create-paper-ocr-demo.mjs

# Generate missing page OCR using the signed-in Codex account.
ANNOTATION_STUDIO_LIVE_SMOKE=1 node --import tsx scripts/create-paper-ocr-demo.mjs
```

Preparation requires `pdftoppm` from Poppler. The live command consumes model usage. Already generated pages with matching source and prompt hashes are retained, so re-running the builder does not silently repeat those calls. Page reruns are available in the app. The builder writes these project assets:

- `public/demos/openai-paper-selected.pdf`: selected original pages.
- `public/demos/openai-paper-preview.json`: faithful raster-backed SVG previews.
- `public/demos/openai-paper-ocr.json`: actual model blocks, source citation and mapping, timestamps, model/provider, image and PDF hashes, and usage.

Intermediate full-paper and rendered-page files remain under ignored `output/paper-ocr/`.

## Verification and limits

Tests exercise the real OpenAI SDK against a local Responses fixture, preserve the requested model when a deployment is used, require strict structured output, disable response storage, reject incomplete responses, and check Codex image cleanup and usage reporting. Demo acceptance checks tie the selected PDF to its source hash, assert the exact viewer-image hashes used for model input, validate all rectangles, and require actual title, figure, table, and numbered-equation results.

This is visual OCR with model uncertainty, not a measured character-accuracy benchmark. Small lettering inside generated images, tiny footnotes, and symbols may need correction. Model uncertainty flags and incomplete-page text warnings are preserved, and a lack of a flag does not establish a verified transcription. The three selected pages do not establish full-paper coverage.
