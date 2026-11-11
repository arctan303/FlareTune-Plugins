import React from 'react';
import { t, SettingsSection, SettingsEditDialog, SettingsActions, SettingsButton, SettingsToggle,
  SettingsTextarea, SelectControl, InfoTip, ALL_LANGUAGES, ServiceModelSettings } from "@flaretune/plugin-sdk";
import LyricSourcesSettings from "./LyricSourcesSettings.jsx";

const FLAGS = [
  ['completionEnabled', '歌词 AI'],
  ['automaticCompletionEnabled', '播放时自动补全缺少目标语言译文的歌词'],
  ['cleanDirtyLyrics', '清理非演唱歌词整行'], ['translateLyrics', '生成目标语言译文'],
  ['detectLanguage', '识别并更新歌曲语言'], ['referenceExistingTranslation', '将同语言旧译文作为翻译参考'],
];
export default function LyricsSettings({ host }) {
  const [resource, setResource] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const saving = React.useRef(false);
  const editorRevision = React.useRef(null);
  const [sources, setSources] = React.useState(null);
  const load = React.useCallback(async ({ clearError = true } = {}) => {
    if (clearError) setError('');
    try {
      const [result, sourceResult] = await Promise.all([host.request('settings', { admin: true }),
        host.request('sources-settings', { admin: true })]);
      if (!host.isCurrent()) return;
      setResource(result); setSources(sourceResult.setting);
    } catch (failure) { if (host.isCurrent()) setError(failure.message || '请求失败'); }
  }, [host]);
  React.useEffect(() => { void load(); }, [load]);
  const open = () => {
    if (!host.isCurrent() || busy || !resource) return;
    editorRevision.current = resource.setting.revision;
    setError(''); setDraft({ ...resource.setting.value });
  };
  const close = () => { if (!saving.current) { setDraft(null); setError(''); } };
  const patch = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const save = async event => {
    event.preventDefault();
    if (!host.isCurrent() || saving.current || !draft) return;
    saving.current = true;
    setBusy(true); setError('');
    try {
      const result = await host.request('settings', { admin: true, method: 'PUT',
        body: { value: draft, expectedRevision: editorRevision.current } });
      if (!host.isCurrent()) return;
      setResource(current => ({ ...current, setting: result.setting })); setDraft(null);
      host.notify(t('设置已成功保存。'));
    } catch (failure) {
      if (!host.isCurrent()) return;
      setError(failure.message || '请求失败');
      if (failure.status === 409 && failure.code === 'revision_conflict') await load({ clearError: false });
    } finally { saving.current = false; if (host.isCurrent()) setBusy(false); }
  };
  if (!resource) return <div role={error ? 'alert' : 'status'}>{error ? t(error) : t('正在加载…')}
    {error && <SettingsButton onClick={() => void load()}>{t('重试')}</SettingsButton>}</div>;
  const language = ALL_LANGUAGES.find(item => item.code === resource.setting.value.targetLanguage);
  return <div className="space-y-5">
    <ServiceModelSettings host={host} />
    {error && !draft && <p role="alert">{t(error)}</p>}
    <SettingsSection title={t('歌词 AI')} action={<SettingsButton disabled={busy} onClick={open}>{t('编辑')}</SettingsButton>}>
      <p className="text-sm font-medium text-[var(--ink)]">{t(resource.setting.value.completionEnabled ? '歌词 AI 已开启' : '歌词 AI 已关闭')}</p>
      <p className="mt-2 text-sm text-[var(--muted)]">{t('目标译文语言')} · {language ? t(language.label) : resource.setting.value.targetLanguage}</p>
    </SettingsSection>
    {draft && <SettingsEditDialog title={t('歌词 AI')} onClose={close} busy={busy} message={error}>
      <form className="space-y-5" onSubmit={event => void save(event)}>
        <label className="block space-y-2"><span className="flex items-center gap-2">{t('目标译文语言')}
          <InfoTip text={t('实例内所有用户共用一份译文；修改后旧译文不会自动变成新语言。')} /></span>
          <SelectControl aria-label={t('目标译文语言')} value={draft.targetLanguage} disabled={busy}
            onChange={event => patch('targetLanguage', event.target.value)}>
            {ALL_LANGUAGES.filter(({ code }) => !['instrumental', 'other'].includes(code)).map(({ code, label }) =>
              <option key={code} value={code}>{t(label)}</option>)}
          </SelectControl>
        </label>
        <div className="space-y-3">{FLAGS.map(([key, label]) => <SettingsToggle key={key} label={t(label)}
          checked={Boolean(draft[key])} disabled={busy} onChange={event => patch(key, event.target.checked)} />)}</div>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3"><label htmlFor="plugin-lyrics-rules">{t('歌词处理准则')}</label>
            <SettingsButton disabled={busy} onClick={() => patch('styleRules', resource.defaults?.styleRules || '')}>{t('重置为系统默认准则')}</SettingsButton>
          </div>
          <SettingsTextarea id="plugin-lyrics-rules" maxLength={8000} className="w-full min-h-64" value={draft.styleRules}
            disabled={busy} onChange={event => patch('styleRules', event.target.value)} />
        </div>
        <SettingsActions><SettingsButton closeDialog disabled={busy}>{t('取消')}</SettingsButton>
          <SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在保存…' : '保存歌词 AI 设置')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
    <LyricSourcesSettings setting={sources} host={host} onSaved={setSources} />
  </div>;
}
