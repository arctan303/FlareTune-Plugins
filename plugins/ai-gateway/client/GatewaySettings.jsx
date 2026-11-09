import { SettingsInput, SettingsWriteButton, SettingsEditDialog, SettingsSkeleton, InfoTip, SettingsActions, SettingsButton, SettingsToggle, SelectControl, t, useSettingsResource } from "@flaretune/plugin-sdk";
import { AI_PROTOCOLS, AI_SOURCES } from '../shared/aiProtocols.js';
import React from 'react';




import { Plus, Edit3, Trash2, Sliders, RefreshCw } from 'lucide-react';


import { getAiProviders, createAiProvider, updateAiProvider, deleteAiProvider, getAiProviderModels, saveAiFeatureModel } from "./api.js";

import { providerDraft, changeProviderSource, providerNeedsKey, providerLabel, featureDraft, changeFeatureProvider, changeFeatureModel, modelListError } from "./providerDraft.js";

const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const cardClass = 'wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4';
const sectionClass = 'wallpaper-content-surface space-y-3.5 rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 sm:p-5 shadow-2xs';

function FeatureModelCard({ feature, label, data, host, refresh, onSaved }) {
  const assignment = data.features[feature];
  const [draft, setDraft] = React.useState(() => featureDraft(assignment));
  const [models, setModels] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [editorOpen, setEditorOpen] = React.useState(false);
  const requestRef = React.useRef(0);
  const editingRevision = React.useRef(assignment.revision);
  const modelFieldRef = React.useRef(null);
  const provider = data.providers.find(item => item.id === draft.providerId);

  React.useEffect(() => { if (!editorOpen) setDraft(featureDraft(assignment)); }, [assignment.revision, editorOpen]);
  React.useEffect(() => {
    requestRef.current += 1; setModels([]); setLoading(false);
    return () => { requestRef.current += 1; };
  }, [draft.providerId, provider?.revision]);

  const disabled = !data.ready || saving;
  const resetModelRequest = () => {
    requestRef.current += 1;
    setModels([]);
    setLoading(false);
  };
  const openEditor = () => {
    editingRevision.current = assignment.revision;
    resetModelRequest();
    setDraft(featureDraft(assignment));
    setMessage('');
    setEditorOpen(true);
  };
  const closeEditor = () => {
    resetModelRequest();
    setDraft(featureDraft(assignment));
    setEditorOpen(false);
    setMessage('');
  };

  async function readModels() {
    const requestId = ++requestRef.current;
    setLoading(true); setMessage('');
    try {
      const result = await getAiProviderModels(provider.id, provider.revision, host);
      if (requestId !== requestRef.current) return;
      setModels(result.models);
      if (!result.models.length || result.hasMore) setMessage('列表为空或未列出全部模型，仍可手动填写模型 ID。');
    } catch (error) { if (requestId === requestRef.current) setMessage(modelListError(error)); }
    finally { if (requestId === requestRef.current) setLoading(false); }
  }

  async function save(event) {
    event.preventDefault(); setSaving(true); setMessage('');
    try {
      const result = await saveAiFeatureModel({ feature, ...draft, providerId: draft.providerId || null, expectedRevision: editingRevision.current, providerRevision: provider?.revision || 0 }, host);
      onSaved(feature, { ...result, providerRevision: provider?.revision || 0 });
      resetModelRequest();
      setEditorOpen(false);
      setMessage('功能使用方案已保存。');
      try { await refresh(); }
      catch { setMessage('功能使用方案已保存，但概览刷新失败。请重新载入。'); }
    } catch (error) { setMessage(error?.status === 409 ? '配置已更新，请刷新后确认再保存。' : '功能使用方案保存失败，请检查填写内容。'); }
    finally { setSaving(false); }
  }

  return (
    <>
      <div className={`${cardClass} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-bold text-[var(--ink)]">{t(label)}</h3>
          <SettingsButton
            disabled={!data.ready}
            onClick={openEditor}
            className="ml-auto max-w-full inline-flex items-center gap-1.5"
          >
            <Sliders size={12} className="shrink-0" />
            <span>{t('配置方案')}</span>
          </SettingsButton>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-[var(--muted)]">{t('供应商')}</dt>
            <dd className="font-semibold text-[var(--ink)] mt-0.5 truncate">
              {provider ? providerLabel(provider) : t('原有部署配置')}
            </dd>
          </div>
          <div>
            <dt className="text-[var(--muted)]">{t('模型')}</dt>
            <dd className="font-mono font-semibold text-[var(--ink)] mt-0.5 truncate">
              {draft.model || t('未设置')}
            </dd>
          </div>
          {(
            <div className="col-span-2 pt-2 border-t border-[var(--line)] flex items-center justify-between text-xs">
              <dt className="text-[var(--muted)]">{t('视觉支持')}</dt>
              <dd>
                {draft.supportsImages ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                    {t('支持视觉')}
                  </span>
                ) : (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-[var(--line)] text-[var(--muted)]">
                    {t('仅文本')}
                  </span>
                )}
              </dd>
            </div>
          )}
        </dl>

        {message && !editorOpen && <p role="status" className="text-xs text-[var(--muted)]">{t(message)}</p>}
      </div>

      {editorOpen && (
        <SettingsEditDialog title={t('配置{p0}方案', { p0: t(label) })} onClose={closeEditor} busy={saving} size="medium">
          <form onSubmit={save} className="space-y-4">

            <label className="block space-y-1 text-xs font-semibold">
              {t('供应商')}
              <SelectControl
                aria-label={`${t(label)} ${t('供应商')}`}
                className={inputClass}
                disabled={disabled}
                value={draft.providerId}
                onChange={(event) => {
                  requestRef.current += 1;
                  setDraft(changeFeatureProvider(draft, event.target.value));
                  setMessage('');
                }}
              >
                <option value="">{t('原有部署配置')}</option>
                {data.providers.map((item) => (
                  <option value={item.id} key={item.id}>
                    {providerLabel(item)} · {item.source === 'custom' ? t('自定义供应商') : AI_SOURCES[item.source].name}
                    {!item.hasKey ? ` · ${t('密钥需重新录入')}` : ''}
                  </option>
                ))}
              </SelectControl>
            </label>

            {draft.providerId && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold">{t('模型')}</span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--line)] bg-[var(--surface)] hover:bg-[var(--surface-raised)] text-xs font-semibold text-[var(--accent)] disabled:opacity-50 cursor-pointer transition-colors shadow-2xs"
                    disabled={disabled || loading || !provider?.hasKey}
                    onClick={() => void readModels()}
                  >
                    <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                    <span>{loading ? t('正在获取模型…') : t('获取模型')}</span>
                  </button>
                </div>

                <div ref={modelFieldRef} className="model-input">
                  <SettingsInput
                    aria-label={`${t(label)} ${t('模型 ID')}`}
                    className={`${inputClass}${models.length ? ' pr-12' : ''}`}
                    required
                    maxLength={160}
                    disabled={disabled}
                    value={draft.model}
                    onChange={(event) => setDraft(changeFeatureModel(draft, event.target.value))}
                    placeholder={t('获取模型后选择，或手动填写模型 ID')}
                  />
                  {models.length > 0 && (
                    <SelectControl
                      aria-label={`${t(label)} ${t('选择模型')}`}
                      className="model-input__choices"
                      menuAnchorRef={modelFieldRef}
                      disabled={disabled}
                      value={models.includes(draft.model) ? draft.model : ''}
                      onChange={(event) => setDraft(changeFeatureModel(draft, event.target.value))}
                    >
                      <option value="" disabled>{t('选择模型')}</option>
                      {models.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </SelectControl>
                  )}
                </div>

                <div className="p-3 rounded-xl border border-[var(--line)] bg-[var(--surface)]">
                  <SettingsToggle label={t('此模型支持视觉')} disabled={disabled || !draft.model.trim()}
                    checked={draft.supportsImages} onChange={(event) => setDraft({ ...draft, supportsImages: event.target.checked })} />
                </div>
              </>
            )}

            <SettingsActions className="pt-3 border-t border-[var(--line)]">
              <SettingsButton closeDialog variant="quiet" disabled={saving}>{t('取消')}</SettingsButton>
              <SettingsButton type="submit" variant="primary"
                disabled={disabled || Boolean(draft.providerId && (!provider || !draft.model.trim()))}
              >
                {saving ? t('保存中…') : t('保存配置')}
              </SettingsButton>
            </SettingsActions>
            {message && <p role="status" className="text-xs text-[var(--muted)]">{t(message)}</p>}
          </form>
        </SettingsEditDialog>
      )}
    </>
  );
}

export default function GatewaySettings({ host }) {
  const load = React.useCallback(() => getAiProviders(host), [host]);
  const { data, setData, refresh, loading: refreshing, error: loadError } = useSettingsResource(load);
  const [editing, setEditing] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const existing = editing?.provider || null;
  const needsKey = draft && providerNeedsKey(draft, existing);
  function startEdit(source, provider = null) { setMessage(''); setDraft(providerDraft(source, provider)); setEditing({ source, provider }); }
  const closeEditor = () => { setEditing(null); setDraft(null); };
  async function saveProvider(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      const result = existing ? await updateAiProvider(existing.id, draft, existing.revision, host)
        : await createAiProvider(draft, host);
      setData(current => ({ ...current, providers: [...current.providers.filter(item => item.id !== result.id), result] }));
      closeEditor(); setMessage('供应商已保存。');
      try { await refresh(); }
      catch { setMessage('供应商已保存，但列表刷新失败。请重新载入。'); }
    } catch (error) { setMessage(error?.code === 'ai_provider_migration_required' ? '请先在实例设置中升级数据库。'
      : error?.code === 'setup_secret_unavailable' ? '请先配置实例的初始化密钥（SETUP_SECRET）。'
        : error?.code === 'ai_profile_key_required' ? '连接发生变化或密钥已失效，请重新输入 API Key。'
          : error?.status === 409 ? '供应商已更新，请刷新后重试。' : '供应商保存失败，请检查填写内容。'); }
    finally { setBusy(false); }
  }
  async function remove(provider) {
    if (!window.confirm(t('删除供应商“{name}”？', { name: provider.name }))) return;
    setBusy(true); setMessage('');
    try {
      await deleteAiProvider(provider.id, provider.revision, host);
      setData(current => ({ ...current, providers: current.providers.filter(item => item.id !== provider.id) }));
      setMessage('供应商已删除。');
      try { await refresh(); }
      catch { setMessage('供应商已删除，但列表刷新失败。请重新载入。'); }
    }
    catch (error) { setMessage(error?.status === 409 ? '供应商正在使用或已更新，请先切换对应功能或刷新。' : '删除失败，请刷新后重试。'); }
    finally { setBusy(false); }
  }
  const onFeatureSaved = (feature, result) => setData(current => ({ ...current, features: { ...current.features, [feature]: result } }));
  return <div className="space-y-6">
    {(loadError || (refreshing && data)) && <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
      <p role={loadError ? 'alert' : 'status'} className="text-[var(--muted)]">{t(loadError ? '配置暂时无法读取，请重新载入。' : '正在刷新…')}</p>
      {loadError && <SettingsButton disabled={refreshing} onClick={() => void refresh().catch(() => {})}>{t('重新载入')}</SettingsButton>}
    </div>}
    {!data && refreshing ? <SettingsSkeleton cards={2} rows={2} /> : !data ? null : <div className="settings-content-enter space-y-6">
    <section className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold text-[var(--ink)]">{t('供应商配置')}</h2>
        <SettingsButton
          variant="primary"
          disabled={busy || !data?.ready}
          onClick={() => startEdit('deepseek')}
          className="inline-flex items-center gap-1.5"
        >
          <Plus size={13} className="shrink-0" />
          <span>{t('添加供应商')}</span>
        </SettingsButton>
      </div>
      {data && !data.credentialReady && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{t('请先配置实例的初始化密钥（SETUP_SECRET）。')}</p>}
      {data?.ready === false && <p role="status" className="text-xs text-amber-700 dark:text-amber-300">{t('请先在实例设置中升级数据库。旧配置仍可继续使用。')}</p>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {data?.providers.map(provider => <div key={provider.id} className={`${cardClass} space-y-3`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <strong className="min-w-0 break-words text-sm font-bold text-[var(--ink)]">{providerLabel(provider)}</strong>
            <SettingsActions>
              <SettingsButton
                disabled={busy || !data?.ready}
                onClick={() => startEdit(provider.source, provider)}
                className="inline-flex items-center gap-1"
              >
                <Edit3 size={11} className="shrink-0" />
                <span>{t('编辑')}</span>
              </SettingsButton>
              <SettingsButton
                variant="danger"
                disabled={busy || !data?.ready}
                onClick={() => void remove(provider)}
                className="inline-flex items-center gap-1"
              >
                <Trash2 size={11} className="shrink-0" />
                <span>{t('删除')}</span>
              </SettingsButton>
            </SettingsActions>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="text-[var(--muted)]">{provider.source === 'custom' ? t('自定义供应商') : AI_SOURCES[provider.source].name}</span>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold ${
              provider.hasKey
                ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${provider.hasKey ? 'bg-emerald-500' : 'bg-amber-500'}`} />
              {provider.hasKey ? t('密钥已配置') : t('密钥需重新录入')}
            </span>
          </div>
        </div>)}
      </div>
      {data && !data.providers.length && <p className="text-xs text-[var(--muted)]">{t('尚未添加供应商，点击“添加供应商”开始配置。')}</p>}
    </section>
    <section className={sectionClass}>
      <h2 className="text-sm font-bold text-[var(--ink)]">{t('功能使用方案')}</h2>
      <div className="grid gap-4 lg:grid-cols-2">{data && [['assistant', '音乐助手'], ['lyrics', '歌词 AI']].map(([feature, label]) => <FeatureModelCard key={feature} feature={feature} label={label} data={data} host={host} refresh={refresh} onSaved={onFeatureSaved} />)}</div>
    </section>
    </div>}
    {message && !editing && <p role="status" className="text-sm text-[var(--muted)]">{t(message)}</p>}
    {editing && <SettingsEditDialog title={t('配置供应商')} onClose={closeEditor} busy={busy} size="medium">
      <form onSubmit={saveProvider} className="space-y-4">
        <label className="block space-y-1 text-xs font-semibold">{t('接入方案')}<SelectControl aria-label={t('接入方案')} className={inputClass} disabled={busy || Boolean(existing)} value={draft.source} onChange={event => setDraft(changeProviderSource(draft, event.target.value))}>{Object.entries(AI_SOURCES).map(([source, preset]) => <option key={source} value={source}>{source === 'custom' ? t('自定义供应商') : preset.name}</option>)}</SelectControl></label>
        <label className="block space-y-1 text-xs font-semibold">{t('显示名称')}<SettingsInput className={inputClass} disabled={busy} maxLength={80} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder={draft.source === 'custom' ? t('自定义供应商') : AI_SOURCES[draft.source].name} /></label>
        {draft.source === 'custom' && <>
          <label className="block space-y-1 text-xs font-semibold">{t('API 协议')}<SelectControl aria-label={t('API 协议')} className={inputClass} value={draft.protocol} onChange={event => setDraft({ ...draft, protocol: event.target.value, apiKey: '' })}>{Object.entries(AI_PROTOCOLS).map(([protocol, label]) => <option key={protocol} value={protocol}>{t(label)}</option>)}</SelectControl></label>
          <label className="block space-y-1 text-xs font-semibold"><span className="inline-flex items-center gap-1.5"><span>{t('API 基础地址')}</span><InfoTip text={t('填写 HTTPS 基础地址，包含版本前缀，不包含具体请求路径。')} /></span><SettingsInput className={inputClass} type="url" required maxLength={2048} value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} placeholder="https://example.com/v1" /></label>
        </>}
        <label className="block space-y-1 text-xs font-semibold">API Key<SettingsInput className={inputClass} type="password" autoComplete="new-password" required={needsKey} maxLength={4096} value={draft.apiKey} onChange={event => setDraft({ ...draft, apiKey: event.target.value })} placeholder={needsKey ? t('请输入 API Key') : t('留空保留已保存的密钥')} /></label>
        <SettingsActions className="pt-2 border-t border-[var(--line)]">
          <SettingsButton closeDialog variant="quiet" disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '保存中…' : '保存配置')}</SettingsButton>
        </SettingsActions>
        {message && <p role="alert" className="text-sm text-rose-600">{t(message)}</p>}
      </form>
    </SettingsEditDialog>}
  </div>;
}
