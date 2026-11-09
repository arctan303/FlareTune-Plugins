import React from 'react';
import { createSpeakerSessionGuard, speakerRequest, speakerOutcomeMessage, speakerErrorMessage } from "./speakers.js";

const loadFailure = '音箱连接信息加载失败，请重试。';
const loginFailure = '小米授权暂时无法完成。请重试检查授权，或重新生成二维码。';
const normalizeStatus = (value) => ({ connected: value?.connected === true,
  needsReconnect: value?.needsReconnect === true, devices: Array.isArray(value?.devices) ? value.devices : [] });

export function useSpeakers(host, { onStatus } = {}) {
  const isDemoRuntime = host.environment?.demo === true;
  const session = host.session.get();
  const [status, setStatus] = React.useState(null);
  const [loading, setLoading] = React.useState(!isDemoRuntime);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [message, setMessage] = React.useState('');
  const [qr, setQr] = React.useState(null);
  const [polling, setPolling] = React.useState(false);
  const scopeRef = React.useRef(null);
  const busyRef = React.useRef(false);
  const statusCallback = React.useRef(onStatus);
  statusCallback.current = onStatus;
  const accountId = session?.user?.accountId;
  const token = host;
  const current = (scope) => scopeRef.current === scope && scope?.isCurrent();
  const acceptStatus = (value) => {
    const next = normalizeStatus(value);
    setStatus(next); statusCallback.current?.(next);
    return next;
  };
  const request = (scope, action, body) => scope.run(async signal => {
    return speakerRequest(action, host, body, { signal });
  });

  const refresh = async () => {
    const scope = scopeRef.current;
    if (!current(scope) || isDemoRuntime || busyRef.current) return;
    setLoading(true); setError('');
    try { const result = await request(scope, 'status'); if (current(scope)) acceptStatus(result); }
    catch { if (current(scope)) setError(loadFailure); }
    finally { if (current(scope)) setLoading(false); }
  };

  React.useEffect(() => {
    setStatus(null); setError(''); setMessage(''); setQr(null); setPolling(false); setBusy(false);
    busyRef.current = false;
    if (isDemoRuntime) { setLoading(false); return undefined; }
    const scope = createSpeakerSessionGuard(host);
    scopeRef.current = scope;
    const unsubscribe = host.session.subscribe(() => { scope.isCurrent(); });
    void refresh();
    return () => { unsubscribe(); scope.close(); if (scopeRef.current === scope) scopeRef.current = null; };
  }, [accountId, token]);

  React.useEffect(() => {
    if (!qr || !polling) return undefined;
    const scope = scopeRef.current;
    let active = true, timer;
    const poll = async () => {
      if (!active || !current(scope)) return;
      if (Date.now() >= qr.expiresAt) {
        setPolling(false); setError('二维码已过期，请重新生成。'); return;
      }
      try {
        const result = await request(scope, 'poll', { loginId: qr.loginId });
        if (!active || !current(scope)) return;
        if (result.phase === 'ready') {
          acceptStatus(result.status || result); setQr(null); setPolling(false); setError('');
        } else if (result.phase === 'waiting') timer = setTimeout(poll, 2000);
        else { setPolling(false); setError(loginFailure); }
      } catch {
        if (active && current(scope)) { setPolling(false); setError(loginFailure); }
      }
    };
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [qr, polling, accountId, token]);

  const act = async (action, body) => {
    const scope = scopeRef.current;
    if (!current(scope) || isDemoRuntime || busyRef.current || polling) return;
    busyRef.current = true; setBusy(true); setError(''); setMessage('');
    try {
      // Pause local playback before any command that can start speaker audio.
      if (action === 'play' || action === 'test') host.player.pause();
      const result = await request(scope, action, body);
      if (!current(scope)) return;
      if (action === 'login') {
        const expiresAt = typeof result.expiresAt === 'number' ? result.expiresAt : Date.parse(result.expiresAt);
        if (typeof result.loginId !== 'string' || !/^data:image\/(?:png|jpeg|gif|webp);base64,/iu.test(result.qrDataUrl || '')
          || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid QR response');
        setQr({ loginId: result.loginId, qrDataUrl: result.qrDataUrl, expiresAt }); setPolling(true);
      } else if (['play', 'test', 'stop'].includes(action)) {
        setMessage(speakerOutcomeMessage(result.outcome));
        if (result.outcome === 'failed') {
          try { const next = await request(scope, 'status'); if (current(scope)) acceptStatus(next); }
          catch { /* Retain the command receipt; never resend a command. */ }
        }
      }
      else { acceptStatus(result); if (action === 'disconnect') { setQr(null); setPolling(false); } }
    } catch (cause) {
      if (!current(scope)) return;
      const safeMessage = speakerErrorMessage(cause?.code);
      if (['SPEAKER_RECONNECT_REQUIRED', 'XIAOMI_AUTH_EXPIRED'].includes(cause?.code)) {
        acceptStatus({ ...status, needsReconnect: true });
      }
      if (safeMessage) setError(safeMessage);
      else if (['play', 'test', 'stop'].includes(action)) {
        setMessage(speakerOutcomeMessage(cause?.status >= 400 && cause.status < 500 ? 'failed' : 'uncertain'));
      } else setError(action === 'login' ? loginFailure : '音箱连接操作未完成，请重试。');
    } finally { if (current(scope)) { busyRef.current = false; setBusy(false); } }
  };

  return { status, setStatus, loading, busy, error, message, qr, polling, refresh,
    demo: isDemoRuntime, connect: () => act('login'),
    retryLogin: () => { if (qr && !busyRef.current) { setError(''); setPolling(true); } },
    refreshDevices: () => act('devices'), disconnect: () => act('disconnect'),
    play: (speakerId, songId) => act('play', { speakerId, songId }),
    stop: (speakerId) => act('stop', { speakerId }), test: (speakerId) => act('test', { speakerId }) };
}
