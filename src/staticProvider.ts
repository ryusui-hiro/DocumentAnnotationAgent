import OpenAI, { type ClientOptions } from 'openai';
import { runIntentAnnotationWithOpenAI, type IntentAnnotationInput } from './intentAnnotation';
import type { PaperBlock, PaperPageResult } from './paperOcrTypes';
import type { AppSettings, ProviderId } from './types';

/** Supplied by the user for this session; this module never persists credentials. */
export type StaticProviderSettings = AppSettings & { apiKey: string };
export type StaticProviderTransport = { fetch?: typeof globalThis.fetch };
export type StaticIntentInput = Omit<IntentAnnotationInput, 'onBlock'> & {
  settings: StaticProviderSettings;
  onBlock?: (block: PaperBlock) => void;
};

export function normalizeStaticEndpoint(endpoint: string, provider: ProviderId): string {
  let url: URL;
  try { url = new URL(endpoint.trim()); } catch { throw new Error('Enter a valid HTTPS API endpoint in Settings.'); }
  if (url.protocol !== 'https:') throw new Error('Browser API endpoints must use HTTPS.');
  if (url.username || url.password || url.search || url.hash) throw new Error('The API endpoint must not contain credentials, query parameters, or a fragment.');
  let pathname = url.pathname.replace(/\/+$/, '');
  if (provider === 'azure-openai' && !pathname.endsWith('/openai/v1')) {
    pathname = pathname.endsWith('/openai') ? `${pathname}/v1` : `${pathname}/openai/v1`;
  }
  if (provider === 'openai-api' && !pathname.endsWith('/v1')) pathname += '/v1';
  url.pathname = `${pathname}/`;
  return url.toString();
}

/** Explicit values prevent the SDK from falling back to environment credentials. */
export function staticClientOptions(settings: StaticProviderSettings, transport: StaticProviderTransport = {}): ClientOptions {
  if (settings.provider === 'codex-app-server') throw new Error('Codex requires an external document API server. Set its URL in Settings, or choose an API provider to run directly in this browser.');
  if (!['openai-api', 'azure-openai', 'openai-compatible'].includes(settings.provider)) throw new Error('Choose a supported API provider in Settings.');
  const apiKey = settings.apiKey?.trim();
  if (!apiKey) throw new Error('Enter your API key in Settings for this browser session.');
  if (settings.provider === 'azure-openai' && !settings.azureDeployment.trim()) throw new Error('Enter your Azure model deployment name in Settings.');
  return {
    apiKey,
    baseURL: normalizeStaticEndpoint(settings.endpoint, settings.provider),
    dangerouslyAllowBrowser: true,
    organization: null,
    project: null,
    adminAPIKey: null,
    webhookSecret: null,
    maxRetries: 0,
    timeout: 240_000,
    // A provider redirect must never forward the user's key to another origin.
    fetch: transport.fetch ?? globalThis.fetch.bind(globalThis),
    fetchOptions: { credentials: 'omit', redirect: 'error' },
  };
}

function publicProviderError(error: unknown, apiKey: string): Error {
  if (error instanceof OpenAI.APIConnectionError || (error instanceof TypeError && /fetch|network|load/i.test(error.message))) {
    return new Error('The browser could not reach the API endpoint. Check the endpoint and network connection, and confirm the provider allows this site through CORS. You can also configure an external document API server in Settings.');
  }
  if (error instanceof OpenAI.APIError) {
    if (error.status === 401 || error.status === 403) return new Error('The provider rejected the API key or this model is not permitted. Check your key and access in Settings.');
    if (error.status === 429) return new Error('The provider rate limit or quota was reached. Check your account quota, then retry.');
    if (error.status === 404 || error.status === 405) return new Error('The endpoint or model was not found. This app requires a Responses API endpoint; for Azure, check the deployment name.');
    return new Error(`The provider rejected the request${error.status ? ` (HTTP ${error.status})` : ''}. Check that the model supports image input, Responses streaming, and structured JSON output.`);
  }
  const message = error instanceof Error ? error.message : 'The annotation request failed. Retry this page.';
  return new Error(apiKey.trim() ? message.replaceAll(apiKey.trim(), '[redacted]') : message);
}

/** Uses the same prompt, tokenizer, label constraints, and final validation as the server. */
export async function runStaticIntent(args: StaticIntentInput, transport: StaticProviderTransport = {}): Promise<PaperPageResult> {
  args.signal?.throwIfAborted();
  const settings = { ...args.settings };
  const labelRules = args.labelRules?.map(rule => ({ ...rule }));
  const client = new OpenAI(staticClientOptions(settings, transport));
  try {
    const result = await runIntentAnnotationWithOpenAI({
      ...args,
      labelRules,
      client,
      model: args.model || settings.model,
      reasoningEffort: args.reasoningEffort || settings.reasoningEffort,
      provider: settings.provider as 'openai-api' | 'azure-openai' | 'openai-compatible',
      deployment: settings.provider === 'azure-openai' ? settings.azureDeployment.trim() : undefined,
      onBlock: block => args.onBlock?.({ ...block, source: 'ai', provisional: true }),
    });
    return { ...result, status: 'complete', blocks: result.blocks.map(block => ({ ...block, source: 'ai', provisional: false })) };
  } catch (error) {
    args.signal?.throwIfAborted();
    throw publicProviderError(error, settings.apiKey);
  }
}

/** Read-only connection check. No generation request or token charge is initiated. */
export async function staticTestConnection(settings: StaticProviderSettings, model = settings.model as string, signal?: AbortSignal, transport: StaticProviderTransport = {}) {
  signal?.throwIfAborted();
  const snapshot = { ...settings };
  const client = new OpenAI(staticClientOptions(snapshot, transport));
  try {
    await client.models.list({ signal, timeout: 20_000 });
    signal?.throwIfAborted();
    return {
      ok: true as const,
      provider: snapshot.provider,
      model: snapshot.provider === 'azure-openai' ? snapshot.azureDeployment.trim() : model,
      message: 'Connected to the provider. API access was verified; image annotation and the selected model are checked when you run a page.',
    };
  } catch (error) {
    signal?.throwIfAborted();
    throw publicProviderError(error, snapshot.apiKey);
  }
}
