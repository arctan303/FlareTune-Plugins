import React from 'react';
import { X } from 'lucide-react';
import { t, decodeUserImage, encodeUserImage, PrivateCoverImage, ImagePreviewDialog } from "@flaretune/plugin-sdk";
export default React.forwardRef(function AssistantAttachments({ host, attachments, onChange, disabled, onBusy, session }, ref) {
  const uploadUserImage = async blob => {
    const response = await host.requestResponse('images/upload/chat', { method: 'POST', body: blob, rawBody: true, contentType: 'image/webp' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '图片上传失败');
    host.assertCurrent(); return data;
  };
  const discardUserImage = async id => {
    if (!host.isCurrent()) return;
    await host.request(`images/${encodeURIComponent(id)}`, { method: 'DELETE', body: {} }).catch(() => {});
  };
  const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState(''); const active = React.useRef(true);
  const owner = session?.user?.accountId;
  const isCurrent = () => active.current && host.isCurrent() && host.session.get()?.user?.accountId === owner;
  const busyRef = React.useRef(false); const input = React.useRef(null);
  const [previewId, setPreviewId] = React.useState(null);
  const preview = attachments.find(image => image.id === previewId);
  React.useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const add = async files => {
    if (!files.length || busyRef.current || disabled || !isCurrent()) return;
    if (files.length + attachments.length > 4) { setError('单次最多附加 4 张图片。'); return; }
    busyRef.current = true;
    setBusy(true); onBusy(true); setError(''); const uploaded = [];
    try {
      for (const file of files) {
        if (!isCurrent()) return;
        const image = await decodeUserImage(file);
        try {
          if (!isCurrent()) return;
          const encoded = await encodeUserImage(image, { purpose: 'chat' });
          if (!isCurrent()) return;
          uploaded.push(await uploadUserImage(encoded));
        }
        finally { image.close(); }
      }
      if (isCurrent()) onChange([...attachments, ...uploaded]);
      else uploaded.forEach(image => void discardUserImage(image.id, session));
    } catch (cause) { uploaded.forEach(image => void discardUserImage(image.id, session)); if (isCurrent()) setError(cause.message); }
    finally { busyRef.current = false; if (isCurrent()) { setBusy(false); onBusy(false); } }
  };
  React.useImperativeHandle(ref, () => ({
    pick: () => input.current?.click(),
    addFiles: files => { void add(files); },
  }));
  return <div className={attachments.length || busy || error ? 'space-y-2 px-3 pt-3' : ''}>
    <input ref={input} hidden aria-label={t('选择图片文件')} type="file" multiple accept="image/jpeg,image/png,image/webp" disabled={busy || disabled || attachments.length >= 4} onChange={event => { void add(Array.from(event.target.files || [])); event.target.value = ''; }} />
    {attachments.length > 0 && <div className="flex flex-wrap gap-2">{attachments.map((image, index) => <div key={image.id} className="relative">
      <button type="button" aria-label={t('查看第 {position} 张图片', { position: index + 1 })} className="block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]" onClick={() => setPreviewId(image.id)}>
        <PrivateCoverImage src={image.url} alt={t('待发送图片')} className="h-16 w-16 rounded-lg object-contain" />
      </button>
      <button type="button" disabled={disabled || busy} className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--surface)] shadow-sm" aria-label={t('移除第 {position} 张图片', { position: index + 1 })} onClick={() => { if (previewId === image.id) setPreviewId(null); onChange(attachments.filter(item => item.id !== image.id)); void discardUserImage(image.id, session); }}><X size={13} aria-hidden="true" /></button></div>)}</div>}
    {busy && <p role="status" className="text-xs text-[var(--muted)]">{t('正在处理图片…')}</p>}
    {error && <p role="alert" className="text-xs text-red-500">{t(error)}</p>}
    {preview && <ImagePreviewDialog key={preview.url} image={preview} onClose={() => setPreviewId(null)} />}
  </div>;
});
