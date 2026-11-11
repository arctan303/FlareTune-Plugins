import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, SelectControl, SettingsSection, SettingsActions, SettingsButton, SettingsToggle, SettingsSkeleton } from '@flaretune/plugin-sdk';
import { YOUTUBE_TRANSLATION_LANGUAGES } from '../shared/preferences.js';
import { youtubeMessage } from '../shared/messages.js';

export default function YouTubePreferences({ host }) {
  const locale = useLocale();
  const tr = key => youtubeMessage(key, locale);
  const [setting, setSetting] = useState(null), [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const saving = useRef(false);
  const load = useCallback(async () => {
    try {
      const result = await host.request('settings', { admin: true });
      if (!host.isCurrent()) return;
      setSetting(result.setting); setDraft({ ...result.setting.value }); setError('');
    } catch { if (host.isCurrent()) setError('settingsError'); }
  }, [host]);
  useEffect(() => { void load(); }, [load]);
  const patch = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const save = async event => {
    event.preventDefault();
    if (!host.isCurrent() || saving.current || !draft) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await host.request('settings', { admin: true, method: 'PUT',
        body: { value: draft, expectedRevision: setting.revision } });
      if (!host.isCurrent()) return;
      setSetting(result.setting); setDraft({ ...result.setting.value });
      const currentSong = host.player.getSnapshot().currentSong;
      if (typeof currentSong?.id === 'string' && currentSong.id.startsWith('yt:')) host.lyrics.changed(currentSong.id);
      host.notify(tr('saved'));
    } catch (failure) {
      if (host.isCurrent()) {
        if (failure.status === 409) await load();
        setError('saveError');
      }
    } finally { saving.current = false; if (host.isCurrent()) setBusy(false); }
  };
  const countries = [...new Set(['US', 'JP', 'KR', 'TW', 'HK', 'GB', 'DE', 'FR', 'CA', 'AU', 'SG', 'IN', draft?.region].filter(Boolean))];
  const regionName = code => { try { return new Intl.DisplayNames([locale], { type: 'region' }).of(code); } catch { return code; } };
  const languages = [...new Set([...YOUTUBE_TRANSLATION_LANGUAGES, draft?.metadataLanguage].filter(Boolean))];
  return <form onSubmit={event => void save(event)}>
    <SettingsSection title={tr('preferences')} action={<SettingsActions>
      <SettingsButton type="submit" variant="primary" disabled={busy || !draft || JSON.stringify(draft) === JSON.stringify(setting?.value)}>
        {tr(busy ? 'saving' : 'save')}
      </SettingsButton>
    </SettingsActions>}>
      {error && <p role="alert" className="mb-3 text-red-600 dark:text-red-400">{tr(error)}</p>}
      {!draft ? (error ? <SettingsButton disabled={busy} onClick={() => void load()}>{tr('retry')}</SettingsButton> : <SettingsSkeleton cards={1} rows={3} />) : <div className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-2"><span>{tr('metadataLanguage')}</span>
            <SelectControl aria-label={tr('metadataLanguage')} disabled={busy} value={draft.metadataLanguage} onChange={event => patch('metadataLanguage', event.target.value)}>
              {languages.map(code => <option key={code} value={code}>{YOUTUBE_TRANSLATION_LANGUAGES.includes(code) ? tr(code) : code}</option>)}
            </SelectControl>
          </label>
          <label className="space-y-2"><span>{tr('region')}</span>
            <SelectControl aria-label={tr('region')} disabled={busy} value={draft.region} onChange={event => patch('region', event.target.value)}>
              {countries.map(code => <option key={code} value={code}>{regionName(code)}</option>)}
            </SelectControl>
          </label>
        </div>
        <SettingsToggle label={tr('lyricsEnabled')} checked={draft.lyricsEnabled} disabled={busy} onChange={event => patch('lyricsEnabled', event.target.checked)} />
        <SettingsToggle label={tr('translationEnabled')} checked={draft.translationEnabled} disabled={busy || !draft.lyricsEnabled} onChange={event => patch('translationEnabled', event.target.checked)} />
        <label className="block space-y-2"><span>{tr('translationLanguage')}</span>
          <SelectControl aria-label={tr('translationLanguage')} disabled={busy || !draft.lyricsEnabled || !draft.translationEnabled}
            value={draft.translationLanguage} onChange={event => patch('translationLanguage', event.target.value)}>
            {YOUTUBE_TRANSLATION_LANGUAGES.map(code => <option key={code} value={code}>{tr(code)}</option>)}
          </SelectControl>
        </label>
      </div>}
    </SettingsSection>
  </form>;
}
