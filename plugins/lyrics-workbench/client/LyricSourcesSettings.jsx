import React from 'react';
import { Plus, Edit3, Trash2 } from 'lucide-react';
import { t, DEFAULT_LYRIC_CHANNELS, MAX_LYRIC_SOURCES, normalizeLyricChannels,
  SettingsSection as Section, SettingsEditDialog, InfoTip, SettingsButton, SettingsActions, SettingsToggle,
  SettingsInput, SettingsTextarea, useSettingsReadOnly, SelectControl, ALL_LANGUAGES, getLanguageLabel } from "@flaretune/plugin-sdk";
import LyricSourceQuickTest from "./LyricSourceQuickTest.jsx";

const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const cardClass = 'wallpaper-content-surface rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4 space-y-3';

export default function LyricSourcesSettings({ setting, host, onSaved }) {
  const current = setting || { value: DEFAULT_LYRIC_CHANNELS, revision: 0 };
  const value = React.useMemo(() => normalizeLyricChannels(current.value, { migrateLegacy: true }), [current.value]);
  const readOnly = useSettingsReadOnly();
  const [editor, setEditor] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [testing, setTesting] = React.useState(false);
  const locked = busy || testing;
  const [message, setMessage] = React.useState('');
  function open(source = null) {
    setMessage('');
    setEditor({ isNew: !source, revision: current.revision, snapshot: structuredClone(value),
      value: source ? { ...source } : { id: 'lyric_' + crypto.randomUUID().replaceAll('-', ''), name: '', note: '',
        protocol: 'custom_krc', enabled: true, searchUrl: '', downloadUrl: '', translationLanguage: 'zh' } });
  }
  const close = () => { if (!locked) { setEditor(null); setMessage(''); } };
  const change = (key, next) => setEditor(previous => ({ ...previous, value: { ...previous.value, [key]: next } }));
  async function persist(next, revision, closeEditor = false) {
    if (readOnly || locked) return;
    setBusy(true); setMessage('');
    try {
      const result = await host.request('sources-settings', { admin: true, method: 'PUT', body: { value: next, expectedRevision: revision } });
      if (!host.isCurrent()) return;
      onSaved(result.setting);
      if (closeEditor) setEditor(null);
    } catch (error) { host.isCurrent() && setMessage(error.message || '操作暂时无法完成，请稍后重试。'); }
    finally { if (host.isCurrent()) setBusy(false); }
  }
  function save(event) {
    event.preventDefault();
    const sources = editor.isNew ? [...editor.snapshot.sources, editor.value]
      : editor.snapshot.sources.map(source => source.id === editor.value.id ? editor.value : source);
    return persist({ version: 2, sources }, editor.revision, true);
  }
  function remove(source) {
    if (readOnly || locked || !window.confirm(t('移除“{p0}”歌词源？已保存的歌词不会删除。', { p0: source.name }))) return;
    return persist({ version: 2, sources: value.sources.filter(item => item.id !== source.id) }, current.revision);
  }
  return <>
    <Section
      title={t('歌词源')}
      action={
        <SettingsButton
          variant="primary"
          disabled={locked || value.sources.length >= MAX_LYRIC_SOURCES}
          onClick={() => open()}
          className="inline-flex items-center gap-1.5"
        >
          <Plus size={13} className="shrink-0" />
          <span>{t('添加源')}</span>
        </SettingsButton>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className={cardClass}>
          <div className="flex items-center justify-between gap-2">
            <strong className="block text-sm font-bold text-[var(--ink)]">LRCLIB</strong>
            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              {t('内置')}
            </span>
          </div>
        </div>
        {value.sources.map(source => <div key={source.id} className={cardClass}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <strong className="min-w-0 break-words text-sm font-bold text-[var(--ink)]">{source.name}</strong>
            <SettingsActions>
              <SettingsButton
                aria-label={t('编辑') + ' ' + source.name}
                disabled={locked}
                onClick={() => open(source)}
                className="inline-flex items-center gap-1"
              >
                <Edit3 size={11} className="shrink-0" />
                <span>{t('编辑')}</span>
              </SettingsButton>
              <SettingsButton
                variant="danger"
                aria-label={t('删除') + ' ' + source.name}
                disabled={locked}
                onClick={() => void remove(source)}
                className="inline-flex items-center gap-1"
              >
                <Trash2 size={11} className="shrink-0" />
                <span>{t('删除')}</span>
              </SettingsButton>
            </SettingsActions>
          </div>
          {source.note && <p className="text-xs text-[var(--muted)] break-words">{source.note}</p>}
          <div className="pt-2 border-t border-[var(--line)]">
            <SettingsToggle
              aria-label={source.name}
              label={t(source.enabled ? '已启用' : '未启用')}
              checked={source.enabled}
              disabled={locked}
              onChange={event => void persist({ version: 2, sources: value.sources.map(item => item.id === source.id ? { ...source, enabled: event.target.checked } : item) }, current.revision)}
            />
          </div>
        </div>)}
      </div>
      {value.sources.length >= MAX_LYRIC_SOURCES && <p className="mt-3 text-xs text-[var(--muted)]">{t('最多添加 {count} 个歌词源。', { count: MAX_LYRIC_SOURCES })}</p>}
      {!editor && message && <p role="alert" className="mt-3 text-sm text-rose-600">{t(message)}</p>}
      {!editor && busy && <p role="status" className="mt-3 text-xs text-[var(--muted)]">{t('正在保存…')}</p>}
    </Section>
    {editor && <SettingsEditDialog title={editor.isNew ? t('添加源') : t('配置{p0}', { p0: editor.value.name })} busy={locked} message={message} onClose={close} size="medium">
      <form onSubmit={save} className="space-y-4">
        <label className="block space-y-1.5 text-xs font-semibold"><span>{t('名称')}</span>
          <SettingsInput className={inputClass} required maxLength={80} disabled={locked} value={editor.value.name} onChange={event => change('name', event.target.value)} />
        </label>
        <label className="block space-y-1.5 text-xs font-semibold"><span>{t('备注')}</span>
          <SettingsTextarea className={inputClass} rows={2} maxLength={500} disabled={locked} value={editor.value.note} onChange={event => change('note', event.target.value)} />
        </label>
        {['searchUrl', 'downloadUrl'].map(field => <label key={field} className="block space-y-1.5 text-xs text-[var(--ink)]">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <span>{t(field === 'searchUrl' ? '搜索接口地址' : '下载接口地址')}</span>
            {field === 'searchUrl' && <InfoTip text={t('自定义接口须符合歌词源协议，仅支持 HTTPS 地址。')} />}
          </span>
          <SettingsInput className={inputClass} type="url" maxLength={2048} required={editor.isNew || editor.value.enabled} disabled={locked} value={editor.value[field]}
            placeholder={'https://lyrics.example.com/' + (field === 'searchUrl' ? 'search' : 'download')} onChange={event => change(field, event.target.value)} />
        </label>)}
        <label className="block space-y-1.5 text-xs text-[var(--ink)]"><span className="font-semibold">{t('来源译文语言')}</span>
          <SelectControl aria-label={t('来源译文语言')} className={inputClass} value={editor.value.translationLanguage} disabled={locked} onChange={event => change('translationLanguage', event.target.value)}>
            {ALL_LANGUAGES.filter(language => !['instrumental', 'other'].includes(language.code)).map(language => <option key={language.code} value={language.code}>{getLanguageLabel(language.code)}</option>)}
          </SelectControl>
        </label>
        <LyricSourceQuickTest source={editor.value} host={host} busy={busy} onTesting={setTesting} />
        <SettingsActions className="pt-2 border-t border-[var(--line)]"><SettingsButton closeDialog disabled={locked}>{t('取消')}</SettingsButton><SettingsButton type="submit" variant="primary" disabled={locked}>{t(busy ? '正在保存…' : '保存')}</SettingsButton></SettingsActions>
      </form>
    </SettingsEditDialog>}
  </>;
}
