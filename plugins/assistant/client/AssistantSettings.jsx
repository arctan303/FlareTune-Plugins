import React from 'react';
import { t, SettingsSection, SettingsEditDialog, SettingsSkeleton, SettingsActions, SettingsButton,
  SettingsToggle, SettingsInput, SettingsTextarea, ServiceModelSettings, useSettingsResource, useSettingsReadOnly } from "@flaretune/plugin-sdk";

const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const fields = [['name', '助手名称', 80], ['avatar_icon', '图标标识', 80], ['welcome_message', '欢迎语', 1000], ['description', '描述', 500]];

export default function AssistantSettings({ host }) {
  const readOnly = useSettingsReadOnly();
  const active = React.useRef(true);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, [host]);
  const isCurrent = () => active.current && host.isCurrent();
  const load = React.useCallback(() => host.request('settings', { admin: true }), [host]);
  const { data, setData, loading, error: loadError, refresh } = useSettingsResource(load);
  const [editing, setEditing] = React.useState(false);
  const [tab, setTab] = React.useState('basic');
  const [draft, setDraft] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const revision = React.useRef(null);
  const open = () => {
    if (!isCurrent() || readOnly) return;
    revision.current = data.assistant.revision;
    setDraft({ ...data.assistant }); setTab('basic'); setError(''); setEditing(true);
  };
  const save = async event => {
    event.preventDefault();
    if (!isCurrent() || busy || readOnly) return;
    setBusy(true); setError('');
    const { revision: _revision, ...patch } = draft;
    patch.temperature = Number(patch.temperature);
    try {
      const assistant = await host.request('config', { admin: true, method: 'PUT', body: { patch, expectedRevision: revision.current } });
      if (!isCurrent()) return;
      setData(current => ({ ...current, assistant })); setEditing(false);
      host.notify(t('助手配置已成功保存。'));
    } catch { if (isCurrent()) setError(t('操作未完成，请重试。')); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const saveImages = async value => {
    if (!isCurrent() || busy || readOnly) return;
    setBusy(true); setError('');
    try {
      const result = await host.request('settings/images', { admin: true, method: 'PUT', body: {
        value, expectedRevision: data.settings['assistant.images_enabled'].revision } });
      if (!isCurrent()) return;
      setData(current => ({ ...current, settings: { ...current.settings, 'assistant.images_enabled': result } }));
      host.notify(t('设置已成功保存。'));
    } catch { if (isCurrent()) setError(t('操作未完成，请重试。')); }
    finally { if (isCurrent()) setBusy(false); }
  };
  const patchField = key => event => setDraft(current => ({ ...current, [key]: event.target.value }));
  if (!data) return <div className="space-y-4">
    {loadError && <div role="alert"><p>{t('操作未完成，请重试。')}</p><SettingsButton onClick={() => void refresh().catch(() => {})}>{t('重试')}</SettingsButton></div>}
    {loading && <SettingsSkeleton cards={2} rows={2} />}
  </div>;
  return <div className="space-y-5">
    <ServiceModelSettings host={host} />
    {error && !editing && <p role="alert">{error}</p>}
    <SettingsSection title={t('助手')} action={<SettingsButton onClick={open} disabled={readOnly || busy}>{t('编辑')}</SettingsButton>}>
      <strong className="text-sm">{data.assistant.name}</strong>
      <p className="mt-2 text-sm text-[var(--muted)]">{data.assistant.description}</p>
    </SettingsSection>
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-raised)] p-4 sm:p-5">
      <SettingsToggle label={t('允许助手图片输入')} checked={data.settings['assistant.images_enabled'].value === true}
        disabled={readOnly || busy} onChange={event => void saveImages(event.target.checked)} />
    </div>
    {editing && <SettingsEditDialog title={t('助手')} busy={busy} message={error} onClose={() => setEditing(false)}>
      <form onSubmit={save} className="space-y-5">
        <div className="flex gap-2" role="tablist" aria-label={t('助手')}>
          {['basic', 'persona'].map(id => <SettingsButton key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{t(id === 'basic' ? '常规' : '人设')}</SettingsButton>)}
        </div>
        {tab === 'basic' ? <div className="space-y-4">
          {fields.map(([key, label, max]) => <label key={key} className="block space-y-1.5 text-sm">{t(label)}
            {max <= 80 ? <SettingsInput className={inputClass} maxLength={max} value={draft[key] || ''} onChange={patchField(key)} required />
              : <SettingsTextarea className={`${inputClass} min-h-20`} maxLength={max} value={draft[key] || ''} onChange={patchField(key)} required />}
          </label>)}
        </div> : <div className="space-y-4">
          {[['persona', '人设', 12000], ['system_rules', '系统准则', 24000]].map(([key, label, max]) => <div key={key} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3"><label htmlFor={`assistant-${key}`}>{t(label)}</label>
              <SettingsButton onClick={() => setDraft(current => ({ ...current, [key]: data.defaults.assistant[key] }))}>{t('重置为系统默认')}</SettingsButton></div>
            <SettingsTextarea id={`assistant-${key}`} className={`${inputClass} min-h-44`} maxLength={max} value={draft[key]} onChange={patchField(key)} required />
          </div>)}
        </div>}
        <SettingsActions><SettingsButton onClick={() => setEditing(false)} disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" disabled={busy || readOnly}>{t('保存')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
  </div>;
}
