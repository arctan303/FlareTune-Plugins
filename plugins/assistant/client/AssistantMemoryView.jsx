import { t, useLocale, SettingsSkeleton, SettingsActions, SettingsButton, SettingsToggle, useSettingsResource } from "@flaretune/plugin-sdk";
import React from 'react';

const sourceLabel = { stated: '对话中提到', inferred: '根据收听推测', user_edited: '由你修改' };

function MemoryTime({ value, label, formatter }) {
  const date = typeof value === 'number' && Number.isFinite(value) ? new Date(value) : null;
  return <span className="whitespace-nowrap">{label} {date && !Number.isNaN(date.getTime())
    ? <time dateTime={date.toISOString()}>{formatter.format(date)}</time> : '—'}</span>;
}

export default function AssistantMemoryView({ host }) {
  const locale = useLocale();
  const dateFormatter = React.useMemo(() => new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : locale, {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }), [locale]);
  const session = host.session.get() || {};
  const active = React.useRef(true);
  const isCurrent = () => active.current && host.isCurrent();
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, [host]);
  const showToast = message => { if (isCurrent()) host.notify(message); };
  const instanceRequest = (path, options) => {
    if (!path.startsWith('ai/memory')) throw new TypeError('Invalid memory endpoint');
    return host.request(path.slice(3), options);
  };
  const accountId = session.user?.accountId;
  const load = React.useCallback(async () => { const data = await host.request('memory'); host.assertCurrent(); return data; }, [host, accountId]);
  const { data, setData, loading, error: loadError, refresh } = useSettingsResource(load);
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [editingId, setEditingId] = React.useState(null);
  const [draft, setDraft] = React.useState('');

  React.useEffect(() => { setError(''); setEditingId(null); setDraft(''); }, [accountId]);

  const retryLoad = async () => {
    setError('');
    try {
      await refresh();
    } catch {
      if (host.isCurrent() && host.session.get()?.user?.accountId === accountId) {
        setError(t("记忆暂时无法载入，请重试。"));
      }
    }
  };

  const run = async (operation, success, removedId = null) => {
    if (!isCurrent()) return;
    setBusy(true); setError('');
    let result;
    try {
      result = await operation();
    } catch {
      if (isCurrent() && host.session.get()?.user?.accountId === accountId) {
        setError(t("操作未完成，请重试。"));
      }
      if (isCurrent()) setBusy(false);
      return;
    }
    if (!isCurrent() || host.session.get()?.user?.accountId !== accountId) return;
    setData(current => ({ ...current,
      ...(typeof result.enabled === 'boolean' ? { enabled: result.enabled } : {}),
      memories: removedId ? current.memories.filter(item => item.id !== removedId)
        : result.memory ? current.memories.map(item => item.id === result.memory.id ? result.memory : item) : current.memories,
    }));
    setEditingId(null); setDraft('');
    showToast(success);
    try {
      const next = await instanceRequest('ai/memory');
      if (isCurrent() && host.session.get()?.user?.accountId === accountId) {
        setData(next); setEditingId(null); setDraft('');
      }
    } catch {
      if (isCurrent() && host.session.get()?.user?.accountId === accountId) {
        setError(t("操作已完成，但记忆列表未刷新。请重新载入。"));
      }
    }
    finally { if (isCurrent()) setBusy(false); }
  };

  return <div className="h-full overflow-y-auto px-5 py-8 sm:px-10">
    <div className="mx-auto max-w-2xl space-y-7">
      <div>
        <p className="mt-2 text-sm text-[var(--muted)]">{t("开启后，助手可在对话中逐步记住与你有关的信息，也可能根据收听记录形成推测。每次变更都会提示你。")}</p>
      </div>
      {(error || loadError) && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-600 dark:text-red-400">
        <span>{t(error || '记忆暂时无法载入，请重试。')}</span><SettingsButton disabled={loading || busy} onClick={retryLoad}>{t("重新载入")}</SettingsButton>
      </div>}
      {!data ? loading && <SettingsSkeleton cards={2} rows={2} label="正在载入记忆…" /> : <div className="settings-content-enter space-y-7">
        <SettingsToggle className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4" label={t("允许助手使用记忆")}
          description={t("默认关闭。关闭时助手不能读取或改写，已有内容仍由你管理。")} checked={data.enabled}
            disabled={busy} onChange={(event) => run(() => instanceRequest('ai/memory', {
              method: 'PATCH', body: { enabled: event.target.checked },
            }), event.target.checked ? t("记忆已开启") : t("记忆已关闭"))} />
        <section aria-label={t("已有记忆")} className="space-y-3">
          <div className="flex items-baseline justify-between gap-3"><h2 className="text-lg font-semibold text-[var(--ink)]">{t("已有记忆")}</h2>
            <span className="text-xs text-[var(--muted)]">{data.memories.length} / 30</span></div>
          {data.memories.length === 0 && <p className="rounded-2xl border border-[var(--line)] p-5 text-sm text-[var(--muted)]">{t("暂无记忆")}</p>}
          {data.memories.map((item) => <div key={item.id} className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-4">
            {editingId === item.id ? <form onSubmit={(event) => {
              event.preventDefault();
              void run(() => instanceRequest(`ai/memory/${item.id}`, { method: 'PUT',
                body: { content: draft } }), t("记忆已修改"));
            }} className="space-y-3">
              <label className="block text-sm font-medium text-[var(--ink)]">{t("修改记忆")}<textarea className="mt-2 min-h-24 w-full rounded-xl border border-[var(--line)] bg-[var(--surface-raised)] p-3 text-[var(--ink)]"
                  maxLength={240} value={draft} onChange={(event) => setDraft(event.target.value)} required />
              </label>
              <SettingsActions><SettingsButton variant="quiet" disabled={busy} onClick={() => setEditingId(null)}>{t("取消")}</SettingsButton>
                <SettingsButton type="submit" variant="primary" disabled={busy}>{t(busy ? '正在保存…' : "保存")}</SettingsButton></SettingsActions>
            </form> : <>
              <p className="whitespace-pre-wrap break-words text-sm text-[var(--ink)]">{item.content}</p>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-[var(--muted)]">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{t(sourceLabel[item.source] || '记忆')}</span>
                  <MemoryTime value={item.createdAt} label={t('创建于')} formatter={dateFormatter} />
                  <MemoryTime value={item.updatedAt} label={t('修改于')} formatter={dateFormatter} />
                </div><span className="ml-auto flex shrink-0 gap-4">
                  <SettingsButton disabled={busy} onClick={() => { setEditingId(item.id); setDraft(item.content); }}>{t("修改")}</SettingsButton>
                  <SettingsButton disabled={busy} variant="danger" onClick={() => {
                    if (window.confirm(t("确定删除这条记忆吗？"))) void run(() => instanceRequest(`ai/memory/${item.id}`, {
                      method: 'DELETE', body: {},
                    }), t("记忆已删除"), item.id);
                  }}>{t("删除")}</SettingsButton></span>
              </div>
            </>}
          </div>)}
        </section>
      </div>}
    </div>
  </div>;
}
