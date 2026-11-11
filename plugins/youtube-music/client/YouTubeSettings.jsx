import React, { useEffect, useRef, useState } from 'react';
import { t, InfoTip, SettingsSection, SettingsActions, SettingsButton, SettingsSkeleton } from "@flaretune/plugin-sdk";

import YouTubePreferences from './YouTubePreferences.jsx';

export default function YouTubeSettings({ host }) {
  const [status, setStatus] = useState(null), [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const latest = useRef(null);
  const accept = value => {
    if (!host.isCurrent()) return;
    const previous = latest.current;
    latest.current = value; setStatus(value); setPending(value.pending || null);
    if (previous && (previous.connected !== value.connected || previous.connectedAt !== value.connectedAt)) host.musicSources.changed();
  };
  useEffect(() => {
    host.request('status', { admin: true }).then(accept).catch(() => {
      if (host.isCurrent()) setError('无法读取 YouTube Music 连接状态，请重试。');
    });
  }, [host]);
  useEffect(() => {
    if (!pending) return undefined;
    let stopped = false, timer;
    const poll = async () => {
      if (stopped || !host.isCurrent()) return;
      try {
        const value = await host.request('connection/poll', { admin: true, method: 'POST',
          body: { revision: latest.current.revision, pendingId: pending.pendingId } });
        if (stopped) return;
        accept(value);
        if (value.pending) timer = setTimeout(poll, value.pending.interval * 1000 + 250);
      } catch {
        if (stopped || !host.isCurrent()) return;
        setPending(null); setError('YouTube 授权未完成或已过期，请重新连接。');
        host.request('status', { admin: true }).then(accept).catch(() => {});
      }
    };
    timer = setTimeout(poll, pending.interval * 1000 + 250);
    return () => { stopped = true; clearTimeout(timer); };
  }, [host, pending?.pendingId]);
  const change = async action => {
    setBusy(true); setError(''); setPending(null);
    try {
      accept(await host.request(`connection/${action}`, { admin: true, method: 'POST',
        body: { revision: latest.current.revision } }));
    } catch {
      if (host.isCurrent()) {
        setError('YouTube Music 连接操作失败，请重试。');
        host.request('status', { admin: true }).then(accept).catch(() => {});
      }
    } finally { if (host.isCurrent()) setBusy(false); }
  };
  if (!status && !error) return <SettingsSkeleton cards={1} rows={2} />;
  return <div className="space-y-5"><SettingsSection title="YouTube Music" action={<SettingsActions>
    <SettingsButton variant={status?.connected ? 'secondary' : 'primary'} disabled={busy || !status} onClick={() => change('start')}>{t(status?.connected ? '重新连接 YouTube' : '连接 YouTube')}</SettingsButton>
    {(status?.connected || pending) && <SettingsButton variant="danger" disabled={busy} onClick={() => change('disconnect')}>{t('断开本网站的 YouTube 连接')}</SettingsButton>}
  </SettingsActions>}>
    <div className="space-y-3 text-sm leading-relaxed">
      <p role="status" className="inline-flex items-center gap-1.5 font-medium text-[var(--ink)]">
        <span>{t(status?.connected ? 'YouTube Music 已连接' : 'YouTube Music 未连接')}</span>
        <InfoTip text={t('本插件提供音乐源，不同步此账号的私人收藏和歌单。')} />
      </p>
      {status?.needsReconnect && <p role="alert" className="text-[var(--muted)]">{t('连接凭据无法读取，请重新连接。')}</p>}
      {status && !status.cacheAvailable && <p role="alert" className="text-[var(--muted)]">{t('音乐源缓存尚未配置，请联系部署管理员。')}</p>}
      {pending && <div className="space-y-2 rounded-xl border border-[var(--line)] bg-[var(--surface)] p-4">
        <p className="text-[var(--muted)]">{t('打开 YouTube 设备授权页面，输入以下代码并确认关联。')}</p>
        <p className="select-all text-xl font-semibold tracking-widest text-[var(--ink)]">{pending.userCode}</p>
        <a href={pending.verificationUrl} target="_blank" rel="noreferrer noopener" className="inline-block font-medium text-[var(--accent)] hover:underline">{t('打开授权页面')}</a>
      </div>}
      {error && <p role="alert" className="text-red-600 dark:text-red-400">{t(error)}</p>}
    </div>
  </SettingsSection><YouTubePreferences host={host} /></div>;
}
