# Astra Annotator: Product Hunt demo kit

This kit separates live model output from scripted examples. The `実AIデモ` menu opens a fictional termination-contract PDF, a synthetic customer-churn workbook, or the retained customer-feedback workbook. All three start without preset annotation answers. Opening a sample makes no provider call; a configured provider is required only when the user starts an Agent run. The separate `契約レビュー例` button remains a scripted UI sample and must not be presented as an LLM result.

## Listing draft

**Name:** Astra Annotator

**Tagline:** An AI agent that reads, labels, and checks your documents.

**Description:** Give an AI agent a document, labeling rules, and a plain-language task. Astra Annotator works through PDFs and spreadsheets, keeps evidence with each result, asks people to resolve ambiguous cases, and exports the reviewed work in a usable format.

**Key points:**

- Turn a plain-language request and rubric into a document-wide annotation task.
- Keep source evidence beside each label, and route uncertain decisions to a human.
- Review and export annotations for PDF, Word, PowerPoint, and Excel.

**Maker comment draft:** We built Astra Annotator to make document annotation feel like reviewing work with a careful teammate. The demo data is fictional and starts unlabeled. Connect your own model provider, give it a rubric, and watch it work through the document. It keeps evidence with proposed labels and leaves ambiguous decisions for a person. We would love feedback on which annotation workflows you need most.

## Live demo runbook

Use a model provider you control. Configure OpenAI, Azure OpenAI, an OpenAI-compatible endpoint, or the local Codex App Server in Settings. Live demos stop at Settings if no provider is configured; they never replace a missing model with canned output. Opening a sample makes no provider call. The app sends document content and task instructions to the selected provider only when the user starts analysis, so use only the included synthetic samples for the public walkthrough.

Start the local app and build all samples with:

```bash
npm run create:demo
npm run create:termination-demo
npm run create:product-hunt-contract-demo
npm run create:product-hunt-demo
npm run create:product-hunt-churn-demo
npm run create:product-hunt-gif
npm run dev
```

### Primary Product Hunt demo: visual contract review

1. Open **実AIデモ → 契約PDFをレビュー**.
2. Confirm **Autopilot** and **GPT-6 Astra**. Ask the Agent to find every termination clause, classify risk, highlight evidence, and ask when uncertain. Autopilot applies clear clauses and pauses on unclear wording.
3. Show the Agent planning, moving through the 11-page agreement (especially pages 1, 4, and 11), and highlighting its fourteen inspected clauses.
4. Review clause 8.5 on page 4, where “reasonable commercial circumstances” and a notice period are undefined. Correct it to HIGH and accept a narrowly worded remaining-page rule; show the Agent resuming with the same run and applying that rule to later clauses.
5. Let the Orchestrator run the read-only Validator on the completed annotation snapshot, then export the reviewed result. Describe it as a workflow demonstration, never as legal advice.

For the separate fixed-sample walkthrough, use **契約レビュー例**. That button intentionally shows preset annotations and one scripted review candidate. Its notice says that no model ran; keep that disclosure visible in any recording.

## 30-second recording outline

| Time | On screen | Narration |
| --- | --- | --- |
| 0–5s | Open the unlabeled eleven-page contract PDF. | “Give the agent a document and tell it what to find.” |
| 5–10s | Show the termination task and generated Annotation Task; confirm Autopilot. | “It plans labels and evidence rules, then applies clear results automatically.” |
| 10–20s | Show live activity navigating pages 1, 4, and 11 while highlights appear. | “The agent reads across the agreement and attaches each result to visible evidence.” |
| 20–25s | Review the unclear clause on page 4 and correct it to HIGH. | “When the termination trigger is undefined, it asks a person instead of guessing.” |
| 25–30s | Accept the remaining-page rule; show resumed activity, Validator review, and export. | “The same run applies the correction to later clauses, checks the final annotation set, and exports the reviewed work.” |

### Secondary Product Hunt demo: customer churn-risk classification

1. Open **実AIデモ → 顧客解約リスクを分類**. The `Customers` sheet has 18 synthetic records with `name`, `plan`, `last_login`, `tickets`, `monthly_usage`, and an empty `Churn Risk` column.
2. Confirm **Autopilot**, the High / Medium / Low classification task, and its visible rubric. The rubric states the snapshot date and measurement windows, uses only recorded evidence, and says not to treat name or plan as a risk signal.
3. Click **Excelを分類**. The Agent reads the workbook and fills the blank output cells while keeping source fields intact. It asks for review instead of guessing when required evidence is missing or conflicting.
4. Inspect the live activity and resulting cell-change list, then review the classifications against the rubric.
5. Export a new annotated workbook. The sample fixture remains unchanged.

The labels demonstrate a rubric-driven workflow against fictional snapshot data; they are not output from a trained prediction model or a validated forecast.

### Retained demo: customer feedback annotation

The separate **実AIデモ → 顧客の声をアノテーション** entry remains available for the original 16-ticket exercise. Its `Feedback` sheet includes six empty output columns for intent, sentiment, urgency, evidence, and human review. Use Assist mode to route uncertain messages to review; the workbook still preserves the original ticket rows.

Keep the provider/model visible in Settings during setup, then close Settings before recording. Do not edit the fixture to add answer labels. Do not call a scripted fallback an AI output. If the model produces an unexpected classification, keep the real output and show the reviewer correction rather than staging a better-looking result.

## Prepared assets

- [Customer feedback demo workbook](../public/demos/customer-feedback-demo.xlsx) — 16 synthetic tickets, with six empty annotation columns.
- [Customer churn-risk demo workbook](../public/demos/customer-churn-risk-demo.xlsx) — 18 synthetic customer rows and one empty `Churn Risk` column. Regenerate it with `npm run create:product-hunt-churn-demo`.
- [Fictional termination-contract PDF](../public/fictional-termination-contract.pdf) — two pages with six clauses and no embedded classifications.
- [Product Hunt live contract PDF](../public/demos/product-hunt-termination-contract.pdf) — eleven pages, fourteen synthetic termination clauses, and no embedded risk labels. Regenerate it with `npm run create:product-hunt-contract-demo`.
- [Termination PDF Agent GIF](assets/termination-pdf-agent-demo.gif) — a real Codex App Server / GPT-5.6 Sol run. It shows the Agent reading the fictional agreement, applying a clear annotation, returning two review findings, and opening a model-suggested highlight for human review.
- [Customer feedback demo GIF](assets/customer-feedback-annotation-demo.gif) — a short, full-screen recording of the unlabeled workbook and rubric; it stops before the model runs.
- [Full-width customer-feedback demo screenshot](assets/customer-feedback-demo-ready-1440x1000.png) — real app state captured by the production browser E2E before any model call; the notice says labels are blank and the model has not run.
- [Full-width customer churn-risk demo screenshot](assets/customer-churn-risk-demo-ready-1440x1000.png) — real app state captured by the production browser E2E with all output cells blank and no model call.

Use the authenticated Codex App Server or set `OPENAI_API_KEY`, then create the live PDF animation with `npm run create:product-hunt-pdf-gif`. It uses the eleven-page fictional agreement and selects GPT-5.6 Sol in Autopilot by default; set `ANNOTATION_STUDIO_LIVE_MODEL` only when intentionally recording another supported model. The recording shows live page analysis, an applied annotation, and model-suggested highlights waiting for human review. It records actual model output and exits without producing a GIF when no live provider is available.

Expected classification values do not live in either public workbook or the demo API response. The browser acceptance flow verifies both blank workbooks, checks the full-width screens, and confirms runs without provider credentials open Settings without calling an AI endpoint or external provider.

## Before publishing

- Configure and test the exact live model/provider that will be used in the recording; the default recording target is GPT-5.6 Sol. Review the clause the model flags as ambiguous and decide whether to approve or correct it before showing an approved result.
- Regenerating the live PDF GIF with `npm run create:product-hunt-pdf-gif` uses the configured model through the authenticated local Codex App Server when available, or OpenAI API when an API key is configured. It consumes the selected account's available usage.
- Record a fresh run and retain its real review queue and model usage; do not use the fixed contract screenshot as evidence of live AI output.
- Replace this prototype’s Japanese workbench labels with the launch language if the listing and recording target an English-speaking audience.
- Check the final exported workbook and confirm that all human-review items are resolved before showing an “approved” export.
- Keep the synthetic-data and contract disclaimer visible where relevant.
