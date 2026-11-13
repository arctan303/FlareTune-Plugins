import { t, useLocale, lyricSourceLabel, SettingsInput, SettingsToggle, useSettingsReadOnly, findActiveLyricLineIndex, SyncedLyricText, ProgressBar, PageBackButton } from "@flaretune/plugin-sdk";
import React from 'react';
import { Check, ChevronDown, ChevronUp, Download, FileUp, Languages, Loader2,
  Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useManagedLyricsAsset } from "./useManagedLyricsAsset.js";
import { createLyricsWorkspaceApi } from "./api.js";
import { useHostPlayer } from "./useHostPlayer.js";
import LyricsCandidatePanel from "./LyricsCandidatePanel.jsx";
import { insertLyricRow, parseLyricTime, serializeLyricEditorRows, validateLyricRows } from "./editor.js";
import { centeredLyricScrollTop } from "./previewScroll.js";
import { projectTimelineShift, stepTimelineShift, timelineShiftAtY } from "./timelineShift.js";
import "./workspace.css";
import LyricsSettings from "./LyricsSettings.jsx";
import { workbenchMessage } from '../shared/messages.js';

const MODES = { word: '逐字', line: '逐行', none: '无时间轴' };
const playbackTime = (seconds) => {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return String(Math.floor(value / 60)).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
};
const stamp = (seconds) => {
  if (!Number.isFinite(seconds)) return '';
  const ms = Math.round(seconds * 1000);
  return String(Math.floor(ms / 60000)).padStart(2, '0') + ':'
    + String(Math.floor((ms % 60000) / 1000)).padStart(2, '0') + '.'
    + String(ms % 1000).padStart(3, '0');
};
const linesOf = (value) => {
  const doc = value?.lyrics || value?.document || value?.preview || value;
  const original = doc?.original || doc;
  const lines = original?.lines || [];
  const translations = doc?.translation?.lines || value?.translation?.lines || [];
  return Array.isArray(lines) ? lines.map((line, index) => ({
    ...line, tlyric: line.tlyric || translations[index] || '',
  })) : [];
};
const makeRows = (lyrics) => linesOf(lyrics).map((line, index) => ({
  key: String(index), time: stamp(line.time), originalTime: stamp(line.time), originalTimeValue: line.time,
  text: line.text, originalText: line.text, translation: line.tlyric || '',
  words: line.words, endTime: line.endTime,
}));
function download(name, data, mime = 'text/plain;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Preview({ value, currentTime, followsPlayback, editing = false, rows = [], errors = {}, previewShiftMs = 0,
  activeCell, onActivate, onPatch, onInsert, onDelete, changedWordRows = 0 }) {
  const lines = React.useMemo(() => projectTimelineShift(linesOf(value), previewShiftMs), [value, previewShiftMs]);
  const mode = value?.syncMode || value?.lyrics?.syncMode || value?.document?.syncMode || 'none';
  const active = followsPlayback && !editing ? findActiveLyricLineIndex(lines, currentTime, mode) : -1;
  const previewRef = React.useRef(null);
  const activeRef = React.useRef(null);
  const hasShownFirstLine = React.useRef(false);
  React.useLayoutEffect(() => {
    if (active < 0 || editing) return;
    const container = previewRef.current;
    const line = activeRef.current;
    if (!container || !line) return;
    const containerRect = container.getBoundingClientRect();
    const lineRect = line.getBoundingClientRect();
    const target = centeredLyricScrollTop({
      scrollTop: container.scrollTop,
      containerTop: containerRect.top,
      containerHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      lineTop: lineRect.top,
      lineHeight: lineRect.height,
    });
    container.scrollTo({ top: target, behavior: hasShownFirstLine.current ? 'smooth' : 'auto' });
    hasShownFirstLine.current = true;
  }, [active, editing]);
  if (!editing && !lines.length) return <div className="lyric-studio__empty">{t("没有可预览的歌词正文。")}</div>;
  const addAfter = (key) => {
    const nextKey = 'new-' + crypto.randomUUID();
    onInsert(key, nextKey);
    onActivate({ key: nextKey, field: 'text' });
  };
  const handleLineBreak = (event, key) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    addAfter(key);
  };
  const closeCell = (key, field) => onActivate((current) =>
    current?.key === key && current.field === field ? null : current);
  return <div ref={previewRef} className={'lyric-studio__preview' + (followsPlayback && !editing ? ' is-following' : '')}
    aria-label={t("歌词全文预览")}>
    {editing && <p className="lyric-studio__edit-hint">{t("点击歌词、译文或时间直接修改；在歌词中按 Enter 插入下一行。")}</p>}
    {editing && changedWordRows > 0 && <p className="lyric-studio__warning">{t('已修改 {count} 行逐字内容，保存后这些行会改为逐行同步。', { count: changedWordRows })}</p>}
    {editing ? rows.map((row, index) => <div key={row.key}
      className={'lyric-studio__line lyric-studio__line--editable' + (errors[row.key] ? ' has-error' : '')}>
      <div className="lyric-studio__time-cell">
        {activeCell?.key === row.key && activeCell.field === 'time' ?
          <input autoFocus aria-label={t('第 {line} 行时间', { line: index + 1 })} value={row.time} placeholder="00:00.000"
            onChange={(event) => onPatch(row.key, { time: event.target.value })}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); onActivate({ key: row.key, field: 'text' }); } }}
            onBlur={() => closeCell(row.key, 'time')} /> :
          <button type="button" className="lyric-studio__edit-trigger lyric-studio__edit-trigger--time"
            onClick={() => onActivate({ key: row.key, field: 'time' })} aria-label={t('编辑第 {line} 行时间', { line: index + 1 })}>
            <time>{row.time && previewShiftMs
              ? stamp(Math.max(0, (parseLyricTime(row.time) ?? 0) + previewShiftMs / 1000))
              : row.time || t("设置时间")}</time></button>}
        {errors[row.key]?.time && <small className="lyric-studio__field-error" role="alert">{t(errors[row.key].time.source, errors[row.key].time.values)}</small>}
      </div>
      <div className="lyric-studio__text-cell">
        {activeCell?.key === row.key && activeCell.field === 'text' ?
          <textarea autoFocus rows={1} aria-label={t('第 {line} 行歌词', { line: index + 1 })} value={row.text}
            onChange={(event) => onPatch(row.key, { text: event.target.value })}
            onKeyDown={(event) => handleLineBreak(event, row.key)} onBlur={() => closeCell(row.key, 'text')} /> :
          <button type="button" className="lyric-studio__edit-trigger lyric-studio__edit-trigger--text"
            onClick={() => onActivate({ key: row.key, field: 'text' })} aria-label={t('编辑第 {line} 行歌词', { line: index + 1 })}>
            {row.text || t("点击填写歌词")}</button>}
        {errors[row.key]?.text && <small className="lyric-studio__field-error" role="alert">{t(errors[row.key].text.source, errors[row.key].text.values)}</small>}
        {activeCell?.key === row.key && activeCell.field === 'translation' ?
          <input autoFocus aria-label={t('第 {line} 行译文', { line: index + 1 })} value={row.translation}
            onChange={(event) => onPatch(row.key, { translation: event.target.value })}
            onKeyDown={(event) => handleLineBreak(event, row.key)} onBlur={() => closeCell(row.key, 'translation')} /> :
          <button type="button" className="lyric-studio__edit-trigger lyric-studio__edit-trigger--translation"
            onClick={() => onActivate({ key: row.key, field: 'translation' })} aria-label={t('编辑第 {line} 行译文', { line: index + 1 })}>
            {row.translation || t("+ 译文")}</button>}
      </div>
      <button type="button" className="lyric-studio__delete-line" aria-label={t('删除第 {line} 行', { line: index + 1 })}
        onClick={() => onDelete(row.key)}><Trash2 size={16} /></button>
    </div>) : lines.map((line, index) => <div key={index} ref={index === active ? activeRef : null}
      className={'lyric-studio__line' + (index === active ? ' is-active' : '')}>
      <time>{stamp(line.time) || '—'}</time>
      <div><p><SyncedLyricText line={line} text={line.text} active={index === active}
        visible syncMode={mode} surface="workspace" /></p>
        {line.tlyric && <small>{line.tlyric}</small>}</div>
    </div>)}
    {editing && <button type="button" className="lyric-studio__add-line" onClick={() => addAfter(rows.at(-1)?.key)}>
      <Plus size={16} />{t("新增一行")}</button>}
  </div>;
}
function TimelineShiftRail({ value, onChange, onApply, saving, draft = false }) {
  const readOnly = useSettingsReadOnly();
  const railRef = React.useRef(null);
  const trackRef = React.useRef(null);
  React.useEffect(() => {
    const rail = railRef.current;
    if (!rail) return undefined;
    const onWheel = (event) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      onChange((current) => stepTimelineShift(current, event.deltaY > 0 ? 1 : -1));
    };
    rail.addEventListener('wheel', onWheel, { passive: false });
    return () => rail.removeEventListener('wheel', onWheel);
  }, [onChange]);
  const updateFromPointer = (event) => {
    const bounds = trackRef.current?.getBoundingClientRect();
    if (bounds) onChange(timelineShiftAtY(event.clientY, bounds.top, bounds.height));
  };
  const description = value < 0 ? t("提前 {p0} 秒", { p0: ((Math.abs(value) / 1000).toFixed(2)) })
    : value > 0 ? t("延后 {p0} 秒", { p0: ((value / 1000).toFixed(2)) }) : t('未位移');
  return <div ref={railRef} className="lyric-studio__shift-rail" aria-label={t("整体调整歌词时间轴")}>
    <span className="lyric-studio__shift-label">{t("时间轴位移")}</span>
    <button type="button" aria-label={t("歌词整体提前50毫秒")} onClick={() => onChange((current) => stepTimelineShift(current, -1))}><ChevronUp size={18} /></button>
    <div ref={trackRef} className="lyric-studio__shift-track" role="slider" tabIndex={0}
      aria-label={t("整体位移")} aria-valuemin={-5000} aria-valuemax={5000} aria-valuenow={value} aria-valuetext={description}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); updateFromPointer(event); }}
      onPointerMove={(event) => { if (event.buttons) updateFromPointer(event); }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') onChange((current) => stepTimelineShift(current, -1));
        else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') onChange((current) => stepTimelineShift(current, 1));
        else if (event.key === 'Home') onChange(-5000);
        else if (event.key === 'End') onChange(5000);
        else return;
        event.preventDefault();
      }}>
      <span className="lyric-studio__shift-track-line" />
      <span className="lyric-studio__shift-thumb" style={{ top: `${(value + 5000) / 100}%` }} />
    </div>
    <button type="button" aria-label={t("歌词整体延后50毫秒")} onClick={() => onChange((current) => stepTimelineShift(current, 1))}><ChevronDown size={18} /></button>
    <output className="lyric-studio__shift-value" aria-live="polite">{value === 0 ? '0.00s' : `${value > 0 ? '+' : '−'}${(Math.abs(value) / 1000).toFixed(2)}s`}</output>
    {draft ? <small>{t("保存时生效")}</small> : <button type="button" className="lyric-studio__shift-apply" disabled={readOnly || saving || value === 0} onClick={onApply}>{t("应用")}</button>}
    <button type="button" className="lyric-studio__shift-clear" disabled={saving || value === 0} onClick={() => onChange(0)}>{t("清零")}</button>
  </div>;
}
export default function LyricsPluginPage(props) {
  if (props.pageId === 'configuration') return <LyricsSettings host={props.host} />;
  return <LyricsWorkspaceContent {...props} />;
}
function LyricsWorkspaceContent({ host, pageId, context = {} }) {
  const readOnly = useSettingsReadOnly();
  const locale = useLocale();
  const tr = key => workbenchMessage(key, locale);
  const route = context.route || {};
  const playback = useHostPlayer(host);
  const selectedSong = context.song || playback.currentSong;
  const songId = route.songId || selectedSong?.id;
  const baseSong = String(selectedSong?.id) === String(songId) ? selectedSong
    : songId ? { id: songId, title: t('当前歌曲') } : null;
  const auth = host.session.get();
  const authenticated = Boolean(auth?.authenticated);
  const isAdmin = authenticated && auth?.user?.role === 'admin';
  const playingSong = playback.currentSong;
  const compactPlayerPlacement = context.playerPlacement || 'inherit';
  const currentTime = playback.currentTime || 0;
  const duration = playback.duration || 0;
  const lyricsWorkspaceApi = React.useMemo(() => createLyricsWorkspaceApi(host), [host]);
  const showToast = React.useCallback(message => { if (host.isCurrent()) host.notify(message); }, [host]);
  const managed = useManagedLyricsAsset({ host, api: lyricsWorkspaceApi, songId: baseSong?.id, enabled: Boolean(baseSong?.id) && authenticated });
  const song = managed.song ? { ...baseSong, ...managed.song } : baseSong;
  const section = pageId || route.section || 'current';
  const setSection = next => host.navigate(next, { songId: song.id });
  const [editing, setEditing] = React.useState(false);
  const [activeCell, setActiveCell] = React.useState(null);
  const [rows, setRows] = React.useState([]);
  const [shift, setShift] = React.useState(0);
  const [draftAiBusy, setDraftAiBusy] = React.useState(false);
  const [draftCleanup, setDraftCleanup] = React.useState(false);
  const draftRequestRef = React.useRef(0);
  const draftEditVersionRef = React.useRef(0);
  const draftReceiptRef = React.useRef(null);
  const draftTranslationLanguageRef = React.useRef(null);
  const fileRef = React.useRef(null);
  const backupRef = React.useRef(null);
  const initialRowsRef = React.useRef([]);
  const editingEtagRef = React.useRef(null);
  const closeGuardRef = React.useRef(() => true);
  const hasAsset = managed.asset?.status === 'ready';
  const hasTimeline = hasAsset && ['line', 'word'].includes(managed.asset?.original?.syncMode);
  const draftMode = rows.some((row) => row.words?.length) ? 'word'
    : rows.some((row) => row.time) ? 'line' : 'none';
  const followsPlayback = String(playingSong?.id) === String(song?.id);
  const changedWordRows = rows.filter((row) => row.words?.length
    && (row.time !== row.originalTime || row.text !== row.originalText)).length;
  const rowErrors = React.useMemo(() => validateLyricRows(rows), [rows]);
  const canDiscardEdits = () => {
    const hasRowChanges = editing && JSON.stringify(rows) !== JSON.stringify(initialRowsRef.current);
    return (!hasRowChanges && shift === 0 && !draftCleanup) || window.confirm(t('歌词有未保存的修改或位移草稿，确定放弃吗？'));
  };
  closeGuardRef.current = canDiscardEdits;
  const discardEdits = () => {
    if (!canDiscardEdits()) return false;
    draftRequestRef.current += 1;
    draftReceiptRef.current = null;
    setDraftAiBusy(false);
    setEditing(false);
    setActiveCell(null);
    setShift(0);
    setDraftCleanup(false);
    return true;
  };
  const leaveWorkspace = () => {
    if (!host.beforeLeave.approve()) return;
    host.returnToOrigin('/home');
  };

  React.useEffect(() => {
    setEditing(false); setActiveCell(null); setShift(0);
    draftRequestRef.current += 1; setDraftAiBusy(false);
    draftReceiptRef.current = null;
    setDraftCleanup(false);
  }, [song?.id]);
  React.useEffect(() => {
    return host.beforeLeave.register(() => closeGuardRef.current());
  }, [host]);
  React.useEffect(() => {
    if ((!editing || JSON.stringify(rows) === JSON.stringify(initialRowsRef.current)) && shift === 0 && !draftCleanup) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [editing, rows, shift, draftCleanup]);
  if (!song) return <div className="lyric-studio"><p>{t("请选择歌曲后打开歌词工作台。")}</p></div>;

  const patchRow = (key, patch) => {
    draftEditVersionRef.current += 1;
    if (patch.text !== undefined) draftReceiptRef.current = null;
    setRows((all) => all.map((row) => row.key === key ? { ...row, ...patch } : row));
  };
  const insertRow = (afterKey, newKey) => {
    draftEditVersionRef.current += 1;
    draftReceiptRef.current = null;
    setRows((all) => insertLyricRow(all, afterKey, newKey));
  };
  const deleteRow = (key) => {
    draftEditVersionRef.current += 1;
    draftReceiptRef.current = null;
    setRows((all) => all.filter((row) => row.key !== key));
  };
  const changeShift = (value) => {
    draftEditVersionRef.current += 1;
    setShift(value);
  };
  const collectDraftLines = () => {
    if (!rows.length) return showToast(t("至少保留一行歌词"));
    const errors = validateLyricRows(rows);
    const firstInvalid = rows.find((row) => errors[row.key]);
    if (firstInvalid) {
      setActiveCell({ key: firstInvalid.key, field: errors[firstInvalid.key].time ? 'time' : 'text' });
      showToast(t("请先修正标红的歌词或时间"));
      return null;
    }
    return serializeLyricEditorRows(rows, shift);
  };
  const saveRows = async () => {
    const lines = collectDraftLines();
    if (!lines) return;
    if (changedWordRows && !window.confirm(t('有 {count} 行修改了逐字内容，保存后这些行会改为逐行同步。继续吗？', { count: changedWordRows }))) return;
    const result = await managed.saveDocument(lines, editingEtagRef.current, draftReceiptRef.current,
      draftTranslationLanguageRef.current);
    if (result === true) { setEditing(false); setActiveCell(null); setShift(0); setDraftCleanup(false); }
    else if (result === 'conflict') {
      setEditing(false); setActiveCell(null);
      setRows([]);
      setDraftCleanup(false);
      showToast(t("歌词已由其他人更新，请基于最新版本重新打开编辑。"));
    }
  };
  const completeDraftWithLines = async (lines) => {
    if (draftAiBusy) return;
    if (!lines) return;
    const requestId = ++draftRequestRef.current;
    const editVersion = draftEditVersionRef.current;
    const cleanDirtyLyrics = draftCleanup;
    setDraftAiBusy(true);
    try {
      const response = await lyricsWorkspaceApi.completeDraftLyrics(song.id,
        { lines, etag: editingEtagRef.current, translationLanguage: draftTranslationLanguageRef.current, cleanDirtyLyrics });
      if (!host.isCurrent() || draftRequestRef.current !== requestId) return;
      if (draftEditVersionRef.current !== editVersion) {
        showToast(t("AI 处理期间草稿已修改，保留当前修改；需要时可重新补全"));
        return;
      }
      const completed = response.data;
      draftReceiptRef.current = completed.receipt || null;
      draftTranslationLanguageRef.current = completed.translationLanguage || null;
      setRows(makeRows({ lines: completed.lines }));
      setShift(0);
      setActiveCell(null);
      showToast(tr(cleanDirtyLyrics ? 'draftCleaned' : 'draftCompleted'));
    } catch (error) {
      if (host.isCurrent() && draftRequestRef.current === requestId) showToast(t(error?.message || '草稿 AI 补全失败'));
    } finally {
      if (draftRequestRef.current === requestId) { setDraftAiBusy(false); setDraftCleanup(false); }
    }
  };
  const completeDraft = () => completeDraftWithLines(collectDraftLines());
  const exportFile = (kind) => {
    if (!hasAsset) return;
    const name = String(song.title || song.id).replace(/[\\/:*?"<>|]/g, '_');
    if (kind === 'backup') download(name + '.lyrics.json',
      JSON.stringify(managed.asset, null, 2), 'application/json;charset=utf-8');
    else {
      const text = kind === 'translation' ? managed.lyrics?.tlyric : managed.lyrics?.lrc;
      if (!text) return showToast(t("没有可导出的内容"));
      download(name + (kind === 'translation' ? '.translation.lrc' : '.lrc'), text);
    }
  };
  const importFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!canDiscardEdits()) return;
    if (file.size > 1_900_000) return showToast(t("LRC 文件不能超过 1.9 MB"));
    if (hasAsset && !window.confirm(t('导入会替换当前共享歌词。继续吗？'))) return;
    if (await managed.importLrc(await file.text())) { setEditing(false); setShift(0); setSection('current'); }
  };
  const restoreFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!canDiscardEdits()) return;
    if (file.size > 3_900_000) return showToast(t("备份文件不能超过 3.9 MB"));
    let asset;
    try { asset = JSON.parse(await file.text()); }
    catch { return showToast(t("备份不是有效的 JSON 文件")); }
    if (!window.confirm(t('恢复备份会替换这首歌当前使用的共享歌词。继续吗？'))) return;
    if (await managed.restoreBackup(asset)) { setEditing(false); setShift(0); setSection('current'); }
  };
  return <div className="lyric-studio" data-section={section} data-player-placement={compactPlayerPlacement}
    aria-labelledby={section === 'candidates' ? undefined : 'lyric-studio-title'}
    aria-label={section === 'candidates' ? t("候选歌词") : undefined}>
    <header className="lyric-studio__header">
      {section !== 'candidates' && <div className="lyric-studio__heading"><h2 id="lyric-studio-title">{song.title}</h2>
        <div className="lyric-studio__heading-meta"><p>{song.artist || t("未知歌手")}</p>
          {section === 'current' && <div className="lyric-studio__formats" aria-label={t("当前歌词来源与同步方式")}>
            <span>{editing ? t("未保存草稿") : managed.asset?.original?.source ? t(lyricSourceLabel(managed.asset.original.source)) : t("未建立")}</span>
            <span>{t(MODES[editing ? draftMode : managed.asset?.original?.syncMode] || '无时间轴')}</span>
          </div>}
        </div>
      </div>}
      {section === 'current' && <div className="lyric-studio__actions">
        <button type="button" disabled={managed.loading || managed.refreshing || managed.saving} onClick={() => void managed.load()}><RefreshCw size={15} />{t("刷新")}</button>
        {authenticated && managed.aiCompletionEnabled && (!editing || isAdmin) && <button type="button"
          disabled={editing ? draftAiBusy || managed.saving
            : !hasAsset || managed.saving || managed.isAiCompleting}
          onClick={() => void (editing ? completeDraft() : managed.completeTranslation())}>
          {draftAiBusy || managed.isAiCompleting ? t("AI 补全中…") : t("AI 补全")}</button>}
        {isAdmin && hasAsset && !editing && <button type="button" disabled={shift !== 0} title={shift ? t("请先应用或清零时间轴位移") : undefined} onClick={() => {
          const nextRows = makeRows({ ...managed.lyrics, translation: managed.asset?.translation });
          initialRowsRef.current = nextRows;
          editingEtagRef.current = managed.etag;
          draftReceiptRef.current = null;
          draftTranslationLanguageRef.current = managed.asset?.translation?.language || null;
          setRows(nextRows);
          setActiveCell(null);
          setDraftCleanup(false);
          setEditing(true);
        }}>{t("编辑歌词")}</button>}
        {editing && <><button type="button" disabled={draftAiBusy} onClick={discardEdits}>{t("取消")}</button>
          <button type="button" className="is-primary" disabled={readOnly || managed.saving || draftAiBusy} onClick={() => void saveRows()}><Check size={15} />{t("保存")}</button></>}
      </div>}
      <PageBackButton className="lyric-studio__back" onClick={leaveWorkspace} />
    </header>
    {playingSong?.id && !followsPlayback && <div className="lyric-studio__notice">{t('播放器已切换；仍在查看《{title}》。', { title: song.title })}
      <button type="button" onClick={() => {
        if (discardEdits()) host.navigate('current', { songId: playingSong.id });
      }}>{t("切到当前歌曲")}</button></div>}
    <div className="lyric-studio__layout">
      {section === 'current' && <section className="lyric-studio__main" aria-label={t("当前歌词")}>
        {editing && isAdmin && managed.aiCompletionEnabled && <div className="mb-3">
          <SettingsToggle label={tr('cleanupWithDraft')} checked={draftCleanup}
            disabled={readOnly || draftAiBusy || managed.saving}
            onChange={event => { draftEditVersionRef.current += 1; setDraftCleanup(event.target.checked); }} />
        </div>}
        {managed.loading && <div className="lyric-studio__empty"><Loader2 className="animate-spin" />{t("正在读取歌词…")}</div>}
        {managed.refreshing && <p role="status">{t('正在更新歌词…')}</p>}
        {!managed.loading && !managed.error && !hasAsset && !editing && <div className="lyric-studio__empty"><Languages size={28} />
          <strong>{t("这首歌还没有歌词")}</strong>
          <button type="button" onClick={() => setSection('candidates')}>{t("查找歌词")}</button></div>}
        {(hasAsset || editing) && <div className={'lyric-studio__preview-frame' + (isAdmin && (hasTimeline || editing && rows.some((row) => row.time)) ? ' has-shift-rail' : '')}>
          <Preview key={song.id} value={managed.lyrics} previewShiftMs={shift}
          currentTime={currentTime} followsPlayback={followsPlayback} editing={editing} rows={rows}
          errors={rowErrors} activeCell={activeCell} onActivate={setActiveCell}
          onPatch={patchRow} onInsert={insertRow} onDelete={deleteRow} changedWordRows={changedWordRows} />
          {isAdmin && (hasTimeline || editing && rows.some((row) => row.time)) && <TimelineShiftRail
            value={shift} onChange={editing ? changeShift : setShift} saving={managed.saving} draft={editing} onApply={async () => {
              if (await managed.shiftTimeline(shift)) setShift(0);
            }} />}</div>}
        {managed.error && <div className="lyric-studio__error" role="alert"><p>{t(managed.error)}</p>
          <button type="button" disabled={managed.loading || managed.refreshing || managed.saving} onClick={() => void managed.load()}>{t('重试')}</button></div>}
        {followsPlayback && <div className="lyric-studio__timeline" aria-label={t("当前歌曲播放进度")}>
          <time>{playbackTime(currentTime)}</time>
          <ProgressBar />
          <time>{playbackTime(duration)}</time>
        </div>}
      </section>}
      <div className="lyric-studio__candidates">
        {section === 'tools' && <div className="lyric-studio__management">
          <section className="lyric-studio__card"><div><strong>{t("文件")}</strong>
            <p>{t("LRC 可用于其他播放器；JSON 备份保留逐字时间。")}</p></div>
            <div className="lyric-studio__file-actions">
              {isAdmin && <><SettingsInput ref={fileRef} type="file" accept=".lrc,.txt,text/plain"
                className="lyric-studio__file-input" aria-label={t("导入 LRC 文件")} onChange={(event) => void importFile(event)} />
                <button type="button" disabled={readOnly} onClick={() => fileRef.current?.click()}><FileUp size={16} />{t("导入 LRC")}</button></>}
              {isAdmin && <><SettingsInput ref={backupRef} type="file" accept=".json,application/json"
                className="lyric-studio__file-input" aria-label={t("导入歌词备份")} onChange={(event) => void restoreFile(event)} />
                <button type="button" disabled={readOnly} onClick={() => backupRef.current?.click()}><FileUp size={16} />{t("导入备份")}</button></>}
              <button type="button" disabled={!hasAsset} onClick={() => exportFile('original')}><Download size={16} />{t("导出 LRC")}</button>
              <button type="button" disabled={!managed.asset?.translation} onClick={() => exportFile('translation')}><Download size={16} />{t("导出译文")}</button>
              <button type="button" disabled={!hasAsset} onClick={() => exportFile('backup')}><Download size={16} />{t("完整备份")}</button>
            </div></section>
          {isAdmin && <section className="lyric-studio__card"><div><strong>{t("歌词管理")}</strong>
            </div>
            <div className="lyric-studio__file-actions">
              <button type="button" disabled={readOnly || !managed.asset?.translation || managed.saving}
                onClick={() => void managed.clearTranslation()}><Trash2 size={16} />{t("清除译文")}</button>
              <button type="button" disabled={readOnly || managed.saving} onClick={async () => {
                if (!canDiscardEdits()) return;
                if (window.confirm(t("确定重置这首歌的共享歌词？")) && await managed.reset()) setShift(0);
              }}><Trash2 size={16} />{t("重置歌词")}</button>
            </div></section>}
        </div>}
        <LyricsCandidatePanel key={song.id} api={lyricsWorkspaceApi} song={song} active={section === 'candidates'}
          authenticated={authenticated} isAdmin={isAdmin} saving={managed.saving}
          Preview={Preview} currentTime={currentTime} followsPlayback={followsPlayback}
          onImport={(inspection) => {
            if (!canDiscardEdits()) return;
            const nextRows = makeRows(inspection);
            if (!nextRows.length) return showToast(t("这份候选没有可导入的歌词"));
            draftRequestRef.current += 1;
            draftEditVersionRef.current += 1;
            setDraftAiBusy(false);
            setDraftCleanup(false);
            initialRowsRef.current = makeRows(managed.lyrics);
            editingEtagRef.current = managed.etag;
            draftReceiptRef.current = null;
            draftTranslationLanguageRef.current = inspection.translation?.language || null;
            setRows(nextRows);
            setActiveCell(null);
            setShift(0);
            setEditing(true);
            setSection('current');
            showToast(t("已导入当前歌词草稿，编辑并保存后才会共享"));
          }} />
      </div>
    </div>
  </div>;
}
