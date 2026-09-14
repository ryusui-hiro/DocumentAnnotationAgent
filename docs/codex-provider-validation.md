# Codex provider validation

The Codex adapter uses the local CLI's documented stdio App Server protocol: initialize, start a read-only thread, start a turn with an output schema, await its completion, and read its final agent message. On macOS it discovers the CLI bundled with ChatGPT or Codex before falling back to `codex` on `PATH`; `CODEX_APP_SERVER_BIN` overrides discovery. It preserves the selected model ID.

Reference: [official OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server).

The Settings connection test checks `account/read` before the model catalog. When OpenAI authentication is required and there is no signed-in account, it returns HTTP 401 with a `codex login` instruction. It preserves providers explicitly reporting that OpenAI authentication is unnecessary. The result excludes account identifiers and starts no model generation; credential validity and quota are ultimately checked during a live run.

Run the synthetic live acceptance check explicitly:

```bash
ANNOTATION_STUDIO_LIVE_SMOKE=1 node --import tsx scripts/live-codex-smoke.mjs
```

This uses the signed-in Codex account and consumes model usage. It does not need an OpenAI API key, open user documents, or run as part of `npm test`. The check reads authentication status and the live model catalog, requests a structured task plan from `gpt-6-astra`, and sends a generated invoice image for visual annotation. It verifies the exact requested label, the visible amount, normalized coordinates, and overlap with the known text row. The generated page and a result report are saved under `output/live-codex-smoke/`; the report excludes account identifiers and credentials.

On 2026-09-14, this check passed with the bundled CLI `0.154.0-alpha.6.2` using ChatGPT authentication. GPT-6 Astra returned one `総額` annotation with the excerpt `TOTAL DUE: JPY 128,000` and a correctly located rectangle. Planning and annotation took 29.7 seconds and used 39,229 reported tokens. This confirms the local App Server path; a direct OpenAI Responses API or Agents SDK live run requires its own configured API credential and is covered by the separate opt-in `scripts/live-provider-smoke.mjs` flow.

Transport regressions cover authentication readiness, private account-detail suppression, stderr backpressure, bidirectional request ID collisions, disconnects while awaiting completion, failed turn startup cleanup, stale-history rejection, and rejection of partial output from failed or interrupted turns. Run them with:

```bash
node --import tsx --test server/codexAppServer.test.ts
node --import tsx --test scripts/codex-workbook-api.test.mjs
```
