import { translate as t, tr, useI18n } from '../i18n';
import { useState } from 'react';
import { AlertCircle, Check, CircleHelp, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, Save, X } from 'lucide-react';
import type { AppSettings, CodexModel, ModelId, ProviderId, ReasoningEffort, UsageTotals } from '../types';
import { STATIC_BUILD, usesBrowserRuntime } from '../runtime';
import { formatTokens, modelCatalog } from '../settings';

interface SettingsDialogProps {
  open: boolean;
  desktop: boolean;
  settings: AppSettings;
  apiKey: string;
  usage: UsageTotals;
  codexModels: CodexModel[];
  codexModelsLoading: boolean;
  connectionTest: { status: 'idle' | 'testing' | 'success' | 'error'; message: string };
  onChange: (patch: Partial<AppSettings>) => void;
  onApiKeyChange: (key: string) => void;
  onSave: () => void;
  onClose: () => void;
  onTestConnection: () => void;
  onRefreshCodexModels: () => void;
  onResetUsage: () => void;
}

const effortCatalog: Array<{ id: ReasoningEffort; label: string }> = [
  { id: 'none', label: 'None — 高速' },
  { id: 'low', label: 'Low — 軽量' },
  { id: 'medium', label: 'Medium — 標準' },
  { id: 'high', label: 'High — 深め' },
  { id: 'xhigh', label: 'XHigh — 最大級' },
  { id: 'max', label: 'Max — 上限' },
  { id: 'ultra', label: 'Ultra — Codex追加レベル' },
];

const providerLabels: Record<ProviderId, string> = {
  'openai-api': 'OpenAI API',
  'azure-openai': 'Azure OpenAI',
  'openai-compatible': 'OpenAI互換API',
  'codex-app-server': 'Codex App Server',
};

export default function SettingsDialog({
  open, desktop, settings, apiKey, usage, codexModels, codexModelsLoading,
  connectionTest, onChange, onApiKeyChange, onSave, onClose, onTestConnection,
  onRefreshCodexModels, onResetUsage,
}: SettingsDialogProps) {
  useI18n();
  const [showKey, setShowKey] = useState(false);
  if (!open) return null;

  const browserRuntime = usesBrowserRuntime(settings.apiServerUrl);
  const isCodex = settings.provider === 'codex-app-server';
  const codexMatches = codexModels.filter((model) => modelCatalog.some((known) => known.id === model.id || known.id === model.model));
  const codexModel = codexMatches.find((model) => model.id === settings.model || model.model === settings.model);
  const changeProvider = (provider: ProviderId) => {
    const endpoint = provider === 'openai-api'
      ? 'https://api.openai.com/v1'
      : provider === 'azure-openai'
        ? ''
        : provider === 'openai-compatible'
          ? 'http://localhost:1234/v1'
          : settings.endpoint;
    onChange({ provider, endpoint });
  };
  const supportedEfforts: ReasoningEffort[] = codexModel
    ? codexModel.supportedReasoningEfforts.map((option) => option.reasoningEffort)
    : settings.provider === 'codex-app-server'
      ? (settings.model === 'gpt-6-astra' ? ['low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      : settings.model === 'gpt-6-astra'
        ? ['low', 'medium', 'high', 'xhigh', 'max']
        : ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  const currentEfforts = effortCatalog.filter((effort) => supportedEfforts.includes(effort.id));
  const usageRows = Object.values(usage.byModel).sort((a, b) => b.totalTokens - a.totalTokens);

  return (
    <div className="modal-backdrop settings-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-header">
          <div className="settings-title-group"><div className="settings-title-icon"><KeyRound size={18} /></div><div><span className="eyebrow">{t("ANNOTATION STUDIO")}</span><h2 id="settings-title">{t("接続と使用量")}</h2></div></div>
          <button className="icon-button" type="button" aria-label={t("設定を閉じる")} onClick={onClose}><X size={18} /></button>
        </div>
        <div className="settings-scroll">
          <section className="settings-section">
            {browserRuntime && <div className="settings-info-box"><strong>{tr({ ja: 'ブラウザーで動作中', en: 'Running in your browser', 'zh-CN': '正在浏览器中运行' })}</strong><p>{tr({ ja: '文書はブラウザー内で読み込みます。AI実行時だけ、設定したAPIへページ画像を直接送信します。', en: 'Documents are processed in this browser. Page images go directly to your configured API only when you run AI.', 'zh-CN': '文档在浏览器中处理。只有运行 AI 时，页面图像才会直接发送到所配置的 API。' })}</p></div>}
            <div className="settings-section-heading"><div><h3>{t("AIプロバイダー")}</h3><p>{t("API接続、またはこの端末のCodex App Serverを選びます。")}</p></div></div>
            <label className="field-label" htmlFor="provider-mode">{t("接続方式")}</label>
            <select id="provider-mode" className="settings-select" value={settings.provider} onChange={(event) => changeProvider(event.target.value as ProviderId)}>
              <option value="openai-api">{t("OpenAI API")}</option>
              <option value="azure-openai">{t("Azure OpenAI")}</option>
              <option value="openai-compatible">{t("OpenAI互換API")}</option>
              <option value="codex-app-server" disabled={browserRuntime}>{t("Codex App Server（ローカルCLI）")}</option>
            </select>

            {isCodex ? (
              <div className="settings-info-box codex-info">
                <div><CircleHelp size={17} /><div><strong>{t("Codex App Serverを使います")}</strong><p>{t("Astra Annotator APIと同じ端末にCodex CLIがあり、Codexにログイン済みである必要があります。処理はread-onlyで起動し、文書内の指示はデータとして扱います。")}</p></div></div>
                <button className="button button-secondary settings-test-button" type="button" onClick={onRefreshCodexModels} disabled={codexModelsLoading}>
                  {codexModelsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                  {codexModelsLoading ? t("モデル一覧を確認中…") : t("モデル一覧を確認")}
                </button>
                {codexModels.length > 0 && <div className="codex-model-result">{codexMatches.length ? t("{value1} を検出", { value1: String(codexMatches.map((model) => model.displayName).join(t("・"))) }) : t("GPT-6 Astra / GPT-5.6モデルを検出できませんでした")}</div>}
              </div>
            ) : (
              <>
                <label className="field-label settings-field-label" htmlFor="ai-endpoint">{settings.provider === 'azure-openai' ? 'Azure OpenAI endpoint' : t("APIエンドポイント")}</label>
                <input id="ai-endpoint" className="text-input settings-input" type="url" value={settings.endpoint} onChange={(event) => onChange({ endpoint: event.target.value })} placeholder={settings.provider === 'openai-api' ? 'https://api.openai.com/v1' : 'https://your-resource.openai.azure.com'} />
                <span className="settings-help-text">{settings.provider === 'azure-openai' ? t("Azure v1 endpointを使います。") : settings.provider === 'openai-compatible' ? t("OpenAI互換のbase URL。例：http://localhost:1234/v1") : t("OpenAI Responses APIのbase URL。")}</span>

                {settings.provider === 'azure-openai' && <>
                  <label className="field-label settings-field-label" htmlFor="azure-deployment">{t("Azure deployment名")}</label>
                  <input id="azure-deployment" className="text-input settings-input" value={settings.azureDeployment} onChange={(event) => onChange({ azureDeployment: event.target.value })} placeholder={t("作成済みのモデルdeployment名")} />
                </>}

                <label className="field-label settings-field-label" htmlFor="api-key">{t("APIキー")}</label>
                <div className="api-key-field"><input id="api-key" className="text-input settings-input" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} placeholder={settings.provider === 'azure-openai' ? 'Azure OpenAI key' : 'sk-…'} /><button type="button" className="key-visibility" aria-label={showKey ? t("APIキーを隠す") : t("APIキーを表示")} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
                <p className="secret-note">{browserRuntime ? tr({ ja: 'キーはこのタブのメモリにのみ保持し、指定したAPIエンドポイントにだけ送信します。公開コードやGitHubには保存しません。APIはブラウザーからのCORS接続に対応している必要があります。', en: 'Your key stays in this tab’s memory and is sent only to the configured API endpoint. It is never saved to GitHub or the public code. The API must allow browser access (CORS).', 'zh-CN': '密钥仅保存在此标签页的内存中，仅发送到指定的 API 端点，不会保存到 GitHub 或公开代码。API 必须允许浏览器跨域访问（CORS）。' }) : t("キーは接続テストまたは候補作成時に、上記の文書/APIサーバーへ送って処理します。キーはこのタブのメモリにのみ保持し、再読み込みまたはタブを閉じると消去します。")}</p>
              </>
            )}
          </section>

          <section className="settings-section settings-section-divider">
            <div className="settings-section-heading"><div><h3>{STATIC_BUILD ? tr({ ja: '文書サーバー（任意）', en: 'Document server (optional)', 'zh-CN': '文档服务器（可选）' }) : t("文書/APIサーバー")}</h3><p>{STATIC_BUILD ? tr({ ja: '通常は空欄で使えます。Codex App Serverや元形式のOffice出力には、接続可能な文書APIを指定してください。', en: 'Leave blank for browser-only use. Connect a document API for Codex App Server or native Office exports.', 'zh-CN': '纯浏览器使用时留空。如需 Codex App Server 或原生 Office 导出，请连接文档 API。' }) : t("PDF / Office変換とAIリクエストを受け取るNode APIのURLです。")}</p></div></div>
            <label className="field-label" htmlFor="api-server-url">{t("サーバーURL")}</label>
            <input id="api-server-url" className="text-input settings-input" type="url" value={settings.apiServerUrl} onChange={(event) => onChange({ apiServerUrl: event.target.value })} placeholder={STATIC_BUILD ? "https://your-document-api.example.com" : desktop ? t("空欄なら内蔵APIを使用") : t("空欄なら同一オリジンを使用")} />
            <span className="settings-help-text">{t("Web開発時は空欄で利用できます。Tauri版は空欄なら文書APIを自動起動します。別のローカルまたは社内APIを使う場合はURLを指定してください。")}</span>
          </section>

          <section className="settings-section settings-section-divider">
            <div className="settings-section-heading"><div><h3>{t("モデルと推論")}</h3><p>{t("利用可能な推論レベルは選択中のモデルに合わせて切り替わります。")}</p></div></div>
            <div className="settings-grid">
              <div><label className="field-label" htmlFor="settings-model">{t("モデル")}</label><select id="settings-model" className="settings-select" value={settings.model} onChange={(event) => onChange({ model: event.target.value as ModelId })}>{modelCatalog.map((model) => {
                const available = settings.provider !== 'codex-app-server' || !codexModels.length || codexModels.some((item) => item.id === model.id || item.model === model.id);
                return <option key={model.id} value={model.id}>{model.label}{available ? '' : t("（Codex未検出）")}</option>;
              })}</select></div>
              <div><label className="field-label" htmlFor="reasoning-effort">{t("推論レベル")}</label><select id="reasoning-effort" className="settings-select" value={settings.reasoningEffort} onChange={(event) => onChange({ reasoningEffort: event.target.value as ReasoningEffort })}>{currentEfforts.map((effort) => <option key={effort.id} value={effort.id}>{t(effort.label)}</option>)}</select></div>
            </div>
          </section>

          <section className="settings-section settings-section-divider">
            <div className="settings-section-heading settings-usage-heading"><div><h3>{t("この端末でのトークン使用量")}</h3><p>{t("このアプリが受け取ったAPI/App Server usageだけを記録します。")}</p></div><button type="button" className="text-button usage-reset" onClick={onResetUsage}>{t("リセット")}</button></div>
            <div className="usage-totals"><div><strong>{formatTokens(usage.requests)}</strong><span>{t("リクエスト")}</span></div><div><strong>{formatTokens(usage.totalTokens)}</strong><span>{t("総トークン")}</span></div><div><strong>{formatTokens(usage.reasoningTokens)}</strong><span>{t("推論トークン")}</span></div></div>
            {usageRows.length ? <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>{t("接続 / モデル")}</th><th>{t("入力")}</th><th>{t("出力")}</th><th>{t("推論")}</th><th>{t("cache")}</th><th>{t("合計")}</th></tr></thead><tbody>{usageRows.map((row) => <tr key={`${row.provider}:${row.model}`}><td><strong>{row.model}</strong><span>{t(providerLabels[row.provider as ProviderId] ?? row.provider)} · {t("{count}回", { count: row.requests })}</span></td><td>{formatTokens(row.inputTokens)}</td><td>{formatTokens(row.outputTokens)}</td><td>{formatTokens(row.reasoningTokens)}</td><td>{formatTokens(row.cachedInputTokens)}</td><td>{formatTokens(row.totalTokens)}</td></tr>)}</tbody></table></div> : <div className="usage-empty">{t("APIまたはCodex App Serverの実行後にusageが表示されます。デモ候補はトークンを消費しません。")}</div>}
          </section>

          {connectionTest.status !== 'idle' && <div className={`connection-test-result is-${connectionTest.status}`} role="status">{connectionTest.status === 'testing' ? <LoaderCircle className="spin" size={15} /> : connectionTest.status === 'error' ? <AlertCircle size={15} /> : <Check size={15} />}{connectionTest.message}</div>}
        </div>
        <div className="settings-footer"><div className="settings-footer-left"><button type="button" className="button button-secondary" onClick={onTestConnection} disabled={connectionTest.status === 'testing' || codexModelsLoading}>{connectionTest.status === 'testing' ? t("接続を確認中…") : t("接続テスト")}</button><span>{browserRuntime ? tr({ ja: '接続テストはモデル一覧を読み取ります。', en: 'Connection test reads the model list.', 'zh-CN': '连接测试会读取模型列表。' }) : t("API接続テストは短い応答を行い、使用量に記録します。")}</span></div><div><button type="button" className="button button-secondary" onClick={onClose}>{t("閉じる")}</button><button type="button" className="button button-primary" onClick={onSave}><Save size={15} />  {t("設定を保存")}</button></div></div>
      </section>
    </div>
  );
}
