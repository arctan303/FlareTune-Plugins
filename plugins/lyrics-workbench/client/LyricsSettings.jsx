import React from 'react';
import { t, useLocale, SettingsSection, SettingsActions, SettingsButton, SettingsToggle, SelectControl, InfoTip, ServiceModelSettings } from '@flaretune/plugin-sdk';
import LyricSourcesSettings from './LyricSourcesSettings.jsx';
import { TRANSLATION_TARGETS, translationTargetLabel } from '../shared/translation-languages.js';
import { workbenchMessage } from '../shared/messages.js';

const legacyDraft = value => ({ onlineEnabled: true, lyricPreference: 'word', ...value });
const modeOf = value => !value.completionEnabled || value.translateLyrics === false ? 'off' : value.automaticCompletionEnabled ? 'auto' : 'manual';
export default function LyricsSettings({ host }) {
  const locale = useLocale();
  const tr = key => workbenchMessage(key, locale);
  const [resource, setResource] = React.useState(null);
  const [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const saving = React.useRef(false);
  const [sources, setSources] = React.useState(null);
  const load = React.useCallback(async () => {
    setError('');
    try {
      const [result, sourceResult] = await Promise.all([host.request('settings', { admin: true }), host.request('sources-settings', { admin: true })]);
      if (!host.isCurrent()) return;
      setResource(result); setDraft(legacyDraft(result.setting.value)); setSources(sourceResult.setting);
    } catch (failure) { if (host.isCurrent()) setError(failure.message || '请求失败'); }
  }, [host]);
  React.useEffect(() => { void load(); }, [load]);
  const patch = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const save = async event => {
    event.preventDefault();
    if (!host.isCurrent() || saving.current || !draft) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await host.request('settings', { admin: true, method: 'PUT', body: { value: draft, expectedRevision: resource.setting.revision } });
      if (!host.isCurrent()) return;
      setResource(current => ({ ...current, setting: result.setting })); setDraft(legacyDraft(result.setting.value)); host.notify(t('设置已成功保存。'));
    } catch (failure) {
      if (!host.isCurrent()) return;
      setError(failure.message || '请求失败');
      if (failure.status === 409 && failure.code === 'revision_conflict') await load();
    } finally { saving.current = false; if (host.isCurrent()) setBusy(false); }
  };
  if (!draft) return <div role={error ? 'alert' : 'status'}>{error ? t(error) : t('正在加载…')}
    {error && <SettingsButton onClick={() => void load()}>{t('重试')}</SettingsButton>}</div>;
  return <div className="space-y-5"><ServiceModelSettings host={host} /><form className="space-y-5" onSubmit={event => void save(event)}>
    {error && <p role="alert">{t(error)}</p>}
    <SettingsSection title={tr('policy')}>
      <SettingsToggle label={tr('onlineEnabled')} checked={Boolean(draft.onlineEnabled)} disabled={busy}
        onChange={event => patch('onlineEnabled', event.target.checked)} />
      <div className="grid gap-4 sm:grid-cols-2 mt-5">
        <label className="space-y-2"><span>{tr('lyricPreference')}</span>
          <SelectControl aria-label={tr('lyricPreference')} value={draft.lyricPreference} disabled={busy} onChange={event => patch('lyricPreference', event.target.value)}>
            <option value="word">{tr('preferWord')}</option><option value="line">{tr('preferLine')}</option>
          </SelectControl>
        </label>
        <label className="space-y-2"><span>{tr('aiCompletion')}</span>
          <SelectControl aria-label={tr('aiCompletion')} value={modeOf(draft)} disabled={busy} onChange={event => {
            const mode = event.target.value;
            setDraft(current => ({ ...current, completionEnabled: mode !== 'off', automaticCompletionEnabled: mode === 'auto',
              ...(mode !== 'off' ? { translateLyrics: true } : {}) }));
          }}>
            <option value="off">{tr('off')}</option><option value="manual">{tr('manual')}</option><option value="auto">{tr('automatic')}</option>
          </SelectControl>
        </label>
        <label className="space-y-2"><span className="flex items-center gap-2">{t('目标译文语言')}
          <InfoTip text={t('实例内所有用户共用一份译文；修改后旧译文不会自动变成新语言。')} /></span>
          <SelectControl aria-label={t('目标译文语言')} value={draft.targetLanguage} disabled={busy} onChange={event => patch('targetLanguage', event.target.value)}>
            {TRANSLATION_TARGETS.map(code => <option key={code} value={code}>{translationTargetLabel(code, locale)}</option>)}
          </SelectControl>
        </label>
      </div>
    </SettingsSection>
    <SettingsActions><SettingsButton disabled={busy} onClick={() => setDraft(legacyDraft(resource.setting.value))}>{t('取消')}</SettingsButton>
      <SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在保存…' : '保存')}</SettingsButton></SettingsActions>
  </form><LyricSourcesSettings setting={sources} host={host} onSaved={setSources} onlineEnabled={Boolean(resource?.setting.value.onlineEnabled ?? true)} /></div>;
}
