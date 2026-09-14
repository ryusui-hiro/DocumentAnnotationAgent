import { useState } from 'react';
import { AlertCircle, Check, CircleHelp, Eye, EyeOff, KeyRound, LoaderCircle, RefreshCw, Save, X } from 'lucide-react';
import type { AppSettings, CodexModel, ModelId, ProviderId, ReasoningEffort, UsageTotals } from '../types';
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
  const [showKey, setShowKey] = useState(false);
  if (!open) return null;

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
          <div className="settings-title-group"><div className="settings-title-icon"><KeyRound size={18} /></div><div><span className="eyebrow">ANNOTATION STUDIO</span><h2 id="settings-title">接続と使用量</h2></div></div>
          <button className="icon-button" type="button" aria-label="設定を閉じる" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="settings-scroll">
          <section className="settings-section">
            <div className="settings-section-heading"><div><h3>AIプロバイダー</h3><p>API接続、またはこの端末のCodex App Serverを選びます。</p></div></div>
            <label className="field-label" htmlFor="provider-mode">接続方式</label>
            <select id="provider-mode" className="settings-select" value={settings.provider} onChange={(event) => changeProvider(event.target.value as ProviderId)}>
              <option value="openai-api">OpenAI API</option>
              <option value="azure-openai">Azure OpenAI</option>
              <option value="openai-compatible">OpenAI互換API</option>
              <option value="codex-app-server">Codex App Server（ローカルCLI）</option>
            </select>

            {isCodex ? (
              <div className="settings-info-box codex-info">
                <div><CircleHelp size={17} /><div><strong>Codex App Serverを使います</strong><p>Astra Annotator APIと同じ端末にCodex CLIがあり、Codexにログイン済みである必要があります。処理はread-onlyで起動し、文書内の指示はデータとして扱います。</p></div></div>
                <button className="button button-secondary settings-test-button" type="button" onClick={onRefreshCodexModels} disabled={codexModelsLoading}>
                  {codexModelsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                  {codexModelsLoading ? 'モデル一覧を確認中…' : 'モデル一覧を確認'}
                </button>
                {codexModels.length > 0 && <div className="codex-model-result">{codexMatches.length ? `${codexMatches.map((model) => model.displayName).join('・')} を検出` : 'GPT-6 Astra / GPT-5.6モデルを検出できませんでした'}</div>}
              </div>
            ) : (
              <>
                <label className="field-label settings-field-label" htmlFor="ai-endpoint">{settings.provider === 'azure-openai' ? 'Azure OpenAI endpoint' : 'APIエンドポイント'}</label>
                <input id="ai-endpoint" className="text-input settings-input" type="url" value={settings.endpoint} onChange={(event) => onChange({ endpoint: event.target.value })} placeholder={settings.provider === 'openai-api' ? 'https://api.openai.com/v1' : 'https://your-resource.openai.azure.com'} />
                <span className="settings-help-text">{settings.provider === 'azure-openai' ? 'Azure v1 endpointを使います。' : settings.provider === 'openai-compatible' ? 'OpenAI互換のbase URL。例：http://localhost:1234/v1' : 'OpenAI Responses APIのbase URL。'}</span>

                {settings.provider === 'azure-openai' && <>
                  <label className="field-label settings-field-label" htmlFor="azure-deployment">Azure deployment名</label>
                  <input id="azure-deployment" className="text-input settings-input" value={settings.azureDeployment} onChange={(event) => onChange({ azureDeployment: event.target.value })} placeholder="作成済みのモデルdeployment名" />
                </>}

                <label className="field-label settings-field-label" htmlFor="api-key">APIキー</label>
                <div className="api-key-field"><input id="api-key" className="text-input settings-input" type={showKey ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} placeholder={settings.provider === 'azure-openai' ? 'Azure OpenAI key' : 'sk-…'} /><button type="button" className="key-visibility" aria-label={showKey ? 'APIキーを隠す' : 'APIキーを表示'} onClick={() => setShowKey((value) => !value)}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div>
                <p className="secret-note">キーは接続テストまたは候補作成時に、上記の文書/APIサーバーへ送って処理します。キーはこのタブのメモリにのみ保持し、再読み込みまたはタブを閉じると消去します。</p>
              </>
            )}
          </section>

          <section className="settings-section settings-section-divider">
            <div className="settings-section-heading"><div><h3>文書/APIサーバー</h3><p>PDF / Office変換とAIリクエストを受け取るNode APIのURLです。</p></div></div>
            <label className="field-label" htmlFor="api-server-url">サーバーURL</label>
            <input id="api-server-url" className="text-input settings-input" type="url" value={settings.apiServerUrl} onChange={(event) => onChange({ apiServerUrl: event.target.value })} placeholder={desktop ? '空欄なら内蔵APIを使用' : '空欄なら同一オリジンを使用'} />
            <span className="settings-help-text">Web開発時は空欄で利用できます。Tauri版は空欄なら文書APIを自動起動します。別のローカルまたは社内APIを使う場合はURLを指定してください。</span>
          </section>

          <section className="settings-section settings-section-divider">
            <div className="settings-section-heading"><div><h3>モデルと推論</h3><p>利用可能な推論レベルは選択中のモデルに合わせて切り替わります。</p></div></div>
            <div className="settings-grid">
              <div><label className="field-label" htmlFor="settings-model">モデル</label><select id="settings-model" className="settings-select" value={settings.model} onChange={(event) => onChange({ model: event.target.value as ModelId })}>{modelCatalog.map((model) => {
                const available = settings.provider !== 'codex-app-server' || !codexModels.length || codexModels.some((item) => item.id === model.id || item.model === model.id);
                return <option key={model.id} value={model.id}>{model.label}{available ? '' : '（Codex未検出）'}</option>;
              })}</select></div>
              <div><label className="field-label" htmlFor="reasoning-effort">推論レベル</label><select id="reasoning-effort" className="settings-select" value={settings.reasoningEffort} onChange={(event) => onChange({ reasoningEffort: event.target.value as ReasoningEffort })}>{currentEfforts.map((effort) => <option key={effort.id} value={effort.id}>{effort.label}</option>)}</select></div>
            </div>
          </section>

          <section className="settings-section settings-section-divider">
            <div className="settings-section-heading settings-usage-heading"><div><h3>この端末でのトークン使用量</h3><p>このアプリが受け取ったAPI/App Server usageだけを記録します。</p></div><button type="button" className="text-button usage-reset" onClick={onResetUsage}>リセット</button></div>
            <div className="usage-totals"><div><strong>{formatTokens(usage.requests)}</strong><span>リクエスト</span></div><div><strong>{formatTokens(usage.totalTokens)}</strong><span>総トークン</span></div><div><strong>{formatTokens(usage.reasoningTokens)}</strong><span>推論トークン</span></div></div>
            {usageRows.length ? <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>接続 / モデル</th><th>入力</th><th>出力</th><th>推論</th><th>cache</th><th>合計</th></tr></thead><tbody>{usageRows.map((row) => <tr key={`${row.provider}:${row.model}`}><td><strong>{row.model}</strong><span>{providerLabels[row.provider as ProviderId] ?? row.provider} · {row.requests}回</span></td><td>{formatTokens(row.inputTokens)}</td><td>{formatTokens(row.outputTokens)}</td><td>{formatTokens(row.reasoningTokens)}</td><td>{formatTokens(row.cachedInputTokens)}</td><td>{formatTokens(row.totalTokens)}</td></tr>)}</tbody></table></div> : <div className="usage-empty">APIまたはCodex App Serverの実行後にusageが表示されます。デモ候補はトークンを消費しません。</div>}
          </section>

          {connectionTest.status !== 'idle' && <div className={`connection-test-result is-${connectionTest.status}`} role="status">{connectionTest.status === 'testing' ? <LoaderCircle className="spin" size={15} /> : connectionTest.status === 'error' ? <AlertCircle size={15} /> : <Check size={15} />}{connectionTest.message}</div>}
        </div>
        <div className="settings-footer"><div className="settings-footer-left"><button type="button" className="button button-secondary" onClick={onTestConnection} disabled={connectionTest.status === 'testing' || codexModelsLoading}>{connectionTest.status === 'testing' ? '接続を確認中…' : '接続テスト'}</button><span>API接続テストは短い応答を行い、使用量に記録します。</span></div><div><button type="button" className="button button-secondary" onClick={onClose}>閉じる</button><button type="button" className="button button-primary" onClick={onSave}><Save size={15} /> 設定を保存</button></div></div>
      </section>
    </div>
  );
}
