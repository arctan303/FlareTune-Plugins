import React from 'react';
import { Loader2, Search } from 'lucide-react';
import { t, SelectControl } from "@flaretune/plugin-sdk";
import { filterLyricsCandidates, sortLyricsCandidates, projectProviderWarnings, projectCandidateInspectionError, lyricRetryAt } from "./candidates.js";

const SOURCES = { custom_krc: '自定义逐字源', custom_lrc: '自定义逐行源', lrclib: 'LRCLIB' };
const MODES = { word: '逐字', line: '逐行', none: '无时间轴' };
const keyOf = (value) => `${value?.source || ''}:${value?.providerLyricId || ''}`;
const BATCH_SIZE = 4;

export default function LyricsCandidatePanel({ song, authenticated, isAdmin, saving, api: lyricsWorkspaceApi,
  onImport, Preview, currentTime, followsPlayback, active = true }) {
  const [title, setTitle] = React.useState(song.title || '');
  const [artist, setArtist] = React.useState(song.artist || '');
  const [source, setSource] = React.useState('all');
  const [sources, setSources] = React.useState([]);
  const [sourceNames, setSourceNames] = React.useState({});
  const sourceName = id => sourceNames[id] && sourceNames[id] !== SOURCES[id]
    ? sourceNames[id] : t(SOURCES[id] || '某歌词源');
  const [mode, setMode] = React.useState('all');
  const [translation, setTranslation] = React.useState('all');
  const [snapshot, setSnapshot] = React.useState(null);
  const [candidates, setCandidates] = React.useState([]);
  const [inspections, setInspections] = React.useState({});
  const [selectedKey, setSelectedKey] = React.useState('');
  const [searching, setSearching] = React.useState(false);
  const [inspecting, setInspecting] = React.useState([]);
  const [error, setError] = React.useState('');
  const [warnings, setWarnings] = React.useState([]);
  const [clock, setClock] = React.useState(Date.now);
  const requests = React.useRef({ generation: 0, inspectionVersion: 0, disposed: false });
  const current = React.useRef({});
  current.current = { snapshot, candidates, inspections };
  const filtered = mode !== 'all' || translation !== 'all';
  const sorted = React.useMemo(() => sortLyricsCandidates(candidates, inspections), [candidates, inspections]);
  const visible = React.useMemo(() => filterLyricsCandidates(sorted, inspections, mode, translation), [sorted, inspections, mode, translation]);
  const selected = visible.find(item => keyOf(item) === selectedKey) || visible[0] || null;
  const selectedIndex = visible.indexOf(selected);
  const inspection = selected && inspections[keyOf(selected)];
  const inspectionError = projectCandidateInspectionError(inspection?.error);
  const unknown = candidates.filter(item => !inspections[keyOf(item)]);
  const failed = candidates.filter(item => inspections[keyOf(item)]?.state === 'error');
  const retryable = failed.filter(item => !(inspections[keyOf(item)]?.error?.retryAt > clock));
  const readyCount = candidates.filter(item => inspections[keyOf(item)]?.state === 'ready').length;
  const cooling = warnings.some(item => item.retryAt > clock)
    || Object.values(inspections).some(item => item.error?.retryAt > clock);
  React.useEffect(() => {
    if (!active || !cooling) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active, cooling]);
  const retryLabel = retryAt => retryAt > clock
    ? t('{seconds} 秒后可重试', { seconds: Math.ceil((retryAt - clock) / 1000) }) : t('稍后重试');

  React.useEffect(() => {
    requests.current.disposed = false;
    let active = true;
    lyricsWorkspaceApi.getSources().then(response => {
      if (active) {
        setSources(response.data.sources || []);
        setSourceNames(Object.fromEntries((response.data.details || []).map(item => [item.id, item.name])));
      }
    }).catch(() => { if (active) setError('歌词源加载失败，请重试。'); });
    return () => {
      active = false;
      requests.current.disposed = true;
      requests.current.generation += 1;
      requests.current.search?.abort();
      requests.current.inspection?.abort();
    };
  }, []);
  React.useEffect(() => {
    if (!snapshot) { setTitle(song.title || ''); setArtist(song.artist || ''); }
  }, [song.title, song.artist]);

  const inspect = async (items) => {
    const query = current.current.snapshot;
    if (!query || !items.length) return;
    const requested = items.filter(item => !(current.current.inspections[keyOf(item)]?.error?.retryAt > Date.now())).slice(0, BATCH_SIZE);
    if (!requested.length) return;
    const state = requests.current;
    state.inspection?.abort();
    const controller = new AbortController();
    state.inspection = controller;
    const version = ++state.inspectionVersion;
    const generation = state.generation;
    const isCurrent = () => !state.disposed && !controller.signal.aborted
      && version === state.inspectionVersion && generation === state.generation;
    setInspecting(requested.map(keyOf));
    try {
      const response = await lyricsWorkspaceApi.inspectLyricsCandidates(song.id,
        requested.map(({ source: provider, providerLyricId }) => ({ source: provider, providerLyricId })),
        { ...query, signal: controller.signal });
      if (!isCurrent()) return;
      const results = new Map((response.data?.results || []).map(item => {
        const retryAt = lyricRetryAt(item.error, Date.now());
        return [keyOf(item), retryAt ? { ...item, error: { ...item.error, retryAt } } : item];
      }));
      setClock(Date.now());
      setInspections(previous => ({ ...previous, ...Object.fromEntries(requested.map(item => [keyOf(item),
        results.get(keyOf(item)) || { ...item, state: 'error', error: { code: 'missing_result' } }])) }));
    } catch {
      if (isCurrent()) setInspections(previous => ({ ...previous,
        ...Object.fromEntries(requested.map(item => [keyOf(item), { ...item, state: 'error' }])) }));
    } finally {
      if (isCurrent()) setInspecting([]);
    }
  };

  const search = async (query = { title: title.trim(), artist: artist.trim(), source }, { retry = false } = {}) => {
    if (!authenticated || !song.id || !query.title) return;
    const state = requests.current;
    const generation = retry ? state.generation : ++state.generation;
    state.search?.abort();
    if (!retry) { state.inspection?.abort(); state.inspectionVersion += 1; }
    const controller = new AbortController(); state.search = controller;
    const isCurrent = () => !state.disposed && !controller.signal.aborted && generation === state.generation;
    setSearching(true); setError('');
    if (!retry) setInspecting([]);
    if (!retry) setWarnings([]);
    if (!retry) { setCandidates([]); setInspections({}); setSelectedKey(''); setSnapshot(query); }
    try {
      const response = await lyricsWorkspaceApi.getLyricsCandidates(song.id, { ...query, signal: controller.signal });
      if (!isCurrent()) return;
      const found = sortLyricsCandidates(response.data?.candidates);
      const nextWarnings = projectProviderWarnings(response.data?.warnings, Date.now());
      setClock(Date.now());
      if (retry) {
        setCandidates(previous => sortLyricsCandidates([...previous.filter(item => item.source !== query.source), ...found]));
        setInspections(previous => Object.fromEntries(Object.entries(previous).filter(([, item]) => item.source !== query.source)));
        setWarnings(previous => [...previous.filter(item => item.source !== query.source), ...nextWarnings]);
      } else {
        setCandidates(found); setWarnings(nextWarnings);
        setSelectedKey(found.length ? keyOf(found[0]) : '');
      }
    } catch (failure) {
      if (isCurrent()) setError(failure?.message || '查找歌词失败');
    } finally { if (isCurrent()) setSearching(false); }
  };
  const retrySource = item => {
    if (!snapshot || searching || item.retryAt > Date.now()) return;
    void search({ ...snapshot, source: item.source }, { retry: true });
  };

  // Only navigation, a submitted search or changed filters schedule one batch.
  // Results do not recursively trigger more downloads: continuing is explicit.
  React.useEffect(() => {
    requests.current.inspection?.abort();
    requests.current.inspectionVersion += 1;
    setInspecting([]);
    if (!active || !snapshot || !candidates.length) return;
    const start = Math.max(0, candidates.findIndex(item => keyOf(item) === selectedKey));
    const nearby = filtered ? candidates : candidates.slice(start, start + BATCH_SIZE);
    const missing = nearby.filter(item => !current.current.inspections[keyOf(item)]);
    if (missing.length) void inspect(missing);
  }, [active, snapshot, candidates, selectedKey, mode, translation]);

  const changeSource = (nextSource) => {
    setSource(nextSource);
    if (snapshot) void search({ ...snapshot, source: nextSource });
  };
  const metadataWarnings = (candidate, result) => <>
    {(candidate.versionMismatch || candidate.warnings?.includes('version_mismatch')
      || result?.warnings?.includes('version_mismatch')) && <span className="lyric-studio__match-warning">{t('版本不符')}</span>}
    {candidate.durationDelta !== null && candidate.durationDelta !== undefined && candidate.durationDelta > 3
      && <span className={candidate.durationDelta > 15 ? 'lyric-studio__match-warning' : ''}>{t('时长差 {seconds} 秒', { seconds: Math.round(candidate.durationDelta * 10) / 10 })}</span>}
  </>;
  return <div className="lyric-studio__candidate-content" hidden={!active}>
    <form className="lyric-studio__search" onSubmit={event => { event.preventDefault(); void search(); }}>
      <label>{t('歌名')}<input value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>{t('歌手')}<input value={artist} onChange={event => setArtist(event.target.value)} /></label>
      <button type="submit" disabled={!authenticated || searching || !title.trim()}>
        {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}{t('查找候选')}</button>
    </form>
    <div className="lyric-studio__candidate-filters">
      <label>{t('歌词来源')}<SelectControl aria-label={t('歌词来源')} value={source} onChange={event => changeSource(event.target.value)}>
        <option value="all">{t('全部来源')}</option>{sources.map(id => <option key={id} value={id}>{sourceName(id)}</option>)}
      </SelectControl></label>
      <label>{t('同步类型')}<SelectControl aria-label={t('同步类型')} value={mode} onChange={event => setMode(event.target.value)}>
        <option value="all">{t('全部类型')}</option><option value="word">{t('逐字')}</option>
        <option value="line">{t('逐行')}</option><option value="none">{t('无时间轴')}</option>
      </SelectControl></label>
      <label>{t('译文')}<SelectControl aria-label={t('译文')} value={translation} onChange={event => setTranslation(event.target.value)}>
        <option value="all">{t('不限译文')}</option><option value="yes">{t('有翻译')}</option><option value="no">{t('无翻译')}</option>
      </SelectControl></label>
    </div>
    {warnings.length > 0 && <div className="lyric-studio__warning" role="status">{warnings.map(item =>
      <div className="lyric-studio__source-warning" key={item.source + item.key}>
        <span>{t('{source}：{reason}', { source: sourceName(item.source), reason: t(item.reason) })}</span>
        <button type="button" disabled={searching || item.retryAt > clock}
          aria-label={t('重试 {source}', { source: sourceName(item.source) })}
          onClick={() => retrySource(item)}>{searching ? t('读取中') : retryLabel(item.retryAt)}</button>
      </div>)}</div>}
    {error && <p className="lyric-studio__error" role="alert">{t(error)}</p>}
    {candidates.length > 0 && <div className="lyric-studio__inspection-status" role="status">
      <span>{t('已检查 {checked}/{total} 份，符合 {matched} 份', { checked: readyCount, total: candidates.length, matched: visible.length })}</span>
      {unknown.length > 0 && <span>{t('还有 {count} 份候选未检查', { count: unknown.length })}</span>}
      {failed.length > 0 && <span>{t('{count} 份检查失败', { count: failed.length })}</span>}
      {inspecting.length > 0 ? <span>{t('正在检查候选…')}</span> : <>
        {filtered && unknown.length > 0 && <button type="button" onClick={() => void inspect(unknown)}>{t('继续检查')}</button>}
        {failed.length > 0 && <button type="button" disabled={!retryable.length} onClick={() => void inspect(retryable)}>{t('重试失败项')}</button>}
      </>}
    </div>}
    <div className="lyric-studio__candidate-list" aria-label={t('切换候选歌词')}>
      {visible.map(candidate => {
        const result = inspections[keyOf(candidate)];
        return <button type="button" key={keyOf(candidate)}
          className={'lyric-studio__candidate' + (keyOf(candidate) === keyOf(selected) ? ' is-selected' : '')}
          onClick={() => setSelectedKey(keyOf(candidate))}>
          <strong>{candidate.matchedTitle || song.title}</strong>
          <small>{candidate.matchedArtist || song.artist || t('未知歌手')} · {sourceName(candidate.source)}</small>
          {candidate.matchedAlbum && <small>{candidate.matchedAlbum}</small>}
          <span>{result?.state === 'ready' ? `${t(MODES[result.syncMode] || '无时间轴')} · ${result.translationAvailable ? t('有翻译') : t('无翻译')}`
            : inspecting.includes(keyOf(candidate)) ? t('正在检查候选…') : result?.state === 'error' ? t('检测失败') : t('选中后检测')}</span>
          {metadataWarnings(candidate, result)}
        </button>;
      })}
      {!searching && !visible.length && <p className="lyric-studio__empty is-small">{!snapshot ? t('输入歌名后查找可用歌词。')
        : unknown.length || failed.length ? t('尚无已确认的匹配，继续检查或重试候选。')
          : t('没有符合条件的候选歌词。')}</p>}
    </div>
    {selected && <div className="lyric-studio__candidate-preview">
      <div className="lyric-studio__candidate-preview-heading">
        <div className="lyric-studio__candidate-navigation">
          <button type="button" disabled={selectedIndex <= 0} onClick={() => setSelectedKey(keyOf(visible[selectedIndex - 1]))} aria-label={t('上一份候选')}>‹</button>
          <strong>{selectedIndex + 1} / {visible.length} · {sourceName(selected.source)} · {t(MODES[inspection?.syncMode] || (inspection?.state === 'error' ? '检测失败' : '读取中'))}</strong>
          <button type="button" disabled={selectedIndex >= visible.length - 1} onClick={() => setSelectedKey(keyOf(visible[selectedIndex + 1]))} aria-label={t('下一份候选')}>›</button>
        </div>
        {inspection?.state === 'error' && <button type="button" disabled={inspecting.length > 0 || inspection.error?.retryAt > clock}
          onClick={() => void inspect([selected])}>{inspection.error?.retryAt > clock ? retryLabel(inspection.error.retryAt) : t('重试预览')}</button>}
        {isAdmin && <button type="button" className="is-primary" disabled={inspection?.state !== 'ready' || saving}
          onClick={() => onImport(inspection)}>{t('导入当前歌词草稿')}</button>}
      </div>
      {inspection?.state === 'ready' ? <Preview key={keyOf(selected)} value={inspection} currentTime={currentTime} followsPlayback={followsPlayback} />
        : <p className="lyric-studio__empty is-small">{inspection?.state === 'error' ? <>
          {t('候选预览失败。')}{inspectionError && ` ${t('{source}：{reason}', {
            source: t(inspectionError.stage), reason: t(inspectionError.reason),
          })}`}
        </> : t('正在读取候选歌词…')}</p>}
    </div>}
  </div>;
}
