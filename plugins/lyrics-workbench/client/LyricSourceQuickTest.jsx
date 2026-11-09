import React from 'react';
import { t, formatNumber, SettingsButton, SettingsInput, useSettingsReadOnly } from "@flaretune/plugin-sdk";
import { useHostPlayer } from "./useHostPlayer.js";

const inputClass = 'w-full rounded-xl border border-[var(--line)] bg-[var(--surface)] px-3.5 py-2.5 text-sm text-[var(--ink)] outline-none focus:border-[var(--accent)]';
const songForTest = song => ({ title: song?.title || '', artist: song?.artist || '',
  ...(Number.isFinite(song?.duration) && song.duration > 0 ? { duration: song.duration } : {}) });
const types = { word: '逐字', line: '逐行', none: '纯文本' };
const stages = { search: '搜索', download: '下载', parse: '解析' };
const errors = {
  timeout: '请求超时，请稍后重试。', network: '无法连接歌词接口，请检查地址或稍后重试。',
  rate_limited: '歌词接口请求过于频繁，请稍后重试。',
  invalid: '接口返回内容不符合歌词协议。', unavailable: '候选没有可用歌词，请换一首歌测试。',
  upstream: '歌词接口暂时不可用，请稍后重试。', circuit_open: '歌词接口暂时不可用，请稍后重试。',
  aborted: '测试已中断，请重试。',
};

export default function LyricSourceQuickTest({ source, host, busy, onTesting }) {
  const currentSong = useHostPlayer(host).currentSong;
  const readOnly = useSettingsReadOnly();
  const [song, setSong] = React.useState(() => songForTest(currentSong));
  const [testing, setTesting] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [error, setError] = React.useState('');
  const inFlight = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  React.useEffect(() => { setResult(null); setError(''); },
    [source.protocol, source.searchUrl, source.downloadUrl, source.translationLanguage, song.title, song.artist, song.duration]);
  const locked = busy || testing;
  async function run() {
    if (readOnly || locked || inFlight.current || !song.title.trim() || !song.artist.trim()) return;
    inFlight.current = true; setTesting(true); onTesting(true); setResult(null); setError('');
    try {
      const next = await host.request('source-test', { admin: true, method: 'POST', body: {
        source: Object.fromEntries(['protocol', 'searchUrl', 'downloadUrl', 'translationLanguage'].map(key => [key, source[key]])),
        song: { ...song, title: song.title.trim(), artist: song.artist.trim() } } });
      if (mounted.current && host.isCurrent()) setResult(next);
    } catch (failure) { if (mounted.current && host.isCurrent()) setError(failure.message || '操作暂时无法完成，请稍后重试。'); }
    finally {
      inFlight.current = false;
      if (mounted.current && host.isCurrent()) { setTesting(false); onTesting(false); }
    }
  }
  return <fieldset className="space-y-3 rounded-xl border border-[var(--line)] p-3.5" disabled={locked}>
    <legend className="px-1 text-sm font-semibold">{t('快速测试')}</legend>
    <div className="grid gap-3 sm:grid-cols-2">
      {['title', 'artist'].map(field => <label key={field} className="block space-y-1.5 text-xs font-semibold">
        <span>{t(field === 'title' ? '歌名' : '歌手')}</span>
        <SettingsInput aria-label={t(field === 'title' ? '测试歌名' : '测试歌手')} className={inputClass} maxLength={300}
          value={song[field]} disabled={locked} onChange={event => setSong(previous => ({ title: previous.title, artist: previous.artist, [field]: event.target.value }))} />
      </label>)}
    </div>
    <div className="flex flex-wrap items-center justify-end gap-2">
      <SettingsButton disabled={locked || !currentSong?.title || !currentSong?.artist} readOnlyAction
        onClick={() => setSong(songForTest(currentSong))}>{t('使用当前歌曲')}</SettingsButton>
      <SettingsButton disabled={locked || !song.title.trim() || !song.artist.trim() || !source.searchUrl || !source.downloadUrl}
        readOnlyAction onClick={() => void run()}>{t(testing ? '测试中…' : '开始测试')}</SettingsButton>
    </div>
    {testing && <p role="status" className="text-xs text-[var(--muted)]">{t('正在搜索、下载并解析歌词…')}</p>}
    {error && <p role="alert" className="text-xs text-rose-600">{t(error)}</p>}
    {result && <div role={result.status === 'failed' ? 'alert' : 'status'} className="space-y-1 text-xs leading-relaxed">
      <p className={result.status === 'failed' ? 'text-rose-600' : 'text-[var(--ink)]'}>
        {result.status === 'ready'
          ? t('测试通过：{count} 个候选，{lines} 行歌词，{type}，{translation}。', {
            count: formatNumber(result.candidateCount), lines: formatNumber(result.lineCount), type: t(types[result.syncMode]),
            translation: t(result.hasTranslation ? '有翻译' : '无翻译'),
          }) : result.status === 'no_matches' ? t('搜索已完成，未找到候选；下载和解析尚未验证，请换一首歌测试。')
            : t('测试失败（{stage}）：{reason}', { stage: t(stages[result.stage]), reason: t(errors[result.kind] || errors.upstream) })}
      </p>
      <p className="text-[var(--muted)]">{t('耗时 {seconds} 秒', { seconds: formatNumber(result.elapsedMs / 1000, { maximumFractionDigits: 1 }) })}</p>
    </div>}
  </fieldset>;
}
