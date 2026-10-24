'use client';

import { useRef, useState, type ReactNode } from 'react';
import { Copy, Mail, MessageCircle, Phone, QrCode } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { platformBrandAssetUrl, usePlatformBranding } from '@/hooks/use-platform-branding';
import './brand-contact-panel.css';

/** Public published brand data only. No private configuration or fallback contacts. */
export function BrandContactButton({ className = '', children = '联系支持' }: { className?: string; children?: ReactNode }) {
  const branding = usePlatformBranding();
  const contact = branding.brand.contact;
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const [failedImages, setFailedImages] = useState<string[]>([]);
  const [copyMessage, setCopyMessage] = useState('');
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const contactPanelRef = useRef<HTMLDivElement | null>(null);
  const qrs = [
    { purpose: 'contact_wechat_qr_primary' as const, label: '微信联系二维码' },
    { purpose: 'contact_wechat_qr_secondary' as const, label: '备用微信二维码' },
  ].flatMap(item => { const url = platformBrandAssetUrl(branding, item.purpose); return url ? [{ ...item, url }] : []; });
  const hasContact = Boolean(contact.wechat || contact.phone || contact.email || qrs.length);
  const copyWechat = async () => {
    const value = contact.wechat.trim();
    if (!value) return;
    let copied = false;
    try { await navigator.clipboard.writeText(value); copied = true; }
    catch {
      const field = document.createElement('textarea');
      field.value = value; field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(field); field.select();
      try { copied = document.execCommand('copy'); } catch { copied = false; }
      finally { field.remove(); }
    }
    setCopyMessage(copied ? '微信号已复制' : '未能复制，请选中上方微信号手动复制。');
  };
  return <>
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (value) setCopyMessage(''); }}>
      <DialogTrigger asChild><button type="button" className={`public-contact-trigger ${className}`}><MessageCircle size={16} aria-hidden="true" />{children}</button></DialogTrigger>
      <DialogContent ref={contactPanelRef} className="public-contact-dialog" data-testid="public-brand-contact" onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); setOpen(false); }}>
        <div className="public-contact-heading"><DialogTitle>联系{contact.name || '客服'}</DialogTitle><DialogDescription>{hasContact ? '选择方便的方式联系我们。' : '暂未提供公开联系方式，请稍后再试。'}</DialogDescription></div>
        {hasContact && <div className="public-contact-body">
          {(contact.wechat || contact.phone || contact.email) && <dl className="public-contact-details">
            {contact.wechat && <div><dt><QrCode size={17} />微信</dt><dd><span className="public-contact-value">{contact.wechat}</span><button type="button" onClick={() => void copyWechat()}><Copy size={14} />复制</button></dd></div>}
            {contact.phone && <div><dt><Phone size={17} />电话</dt><dd><a href={`tel:${contact.phone}`}>{contact.phone}</a></dd></div>}
            {contact.email && <div><dt><Mail size={17} />邮箱</dt><dd><a href={`mailto:${contact.email}`}>{contact.email}</a></dd></div>}
          </dl>}
          {qrs.length > 0 && <div className="public-contact-qrs">{qrs.map(item => <figure key={item.purpose}>
            {failedImages.includes(item.url) ? <div className="public-contact-image-error" role="status"><QrCode size={30} /><span>二维码暂时无法加载</span></div> : <button type="button" className="public-contact-qr-button" aria-label={`放大${item.label}`} onClick={event => { previewTriggerRef.current = event.currentTarget; setPreview(item); }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={item.url} alt={item.label} onError={() => setFailedImages(items => [...new Set([...items, item.url])])} />
            </button>}
            <figcaption>{item.label}<span>{failedImages.includes(item.url) ? '请使用其他联系方式' : '使用微信扫一扫 · 点击放大'}</span></figcaption>
          </figure>)}</div>}
        </div>}
        {copyMessage && <p className="public-contact-feedback" role="status">{copyMessage}</p>}
      </DialogContent>
    </Dialog>
    <Dialog open={Boolean(preview)} onOpenChange={value => { if (!value) setPreview(null); }}>
      <DialogContent className="public-contact-dialog public-contact-preview" aria-describedby={undefined} onCloseAutoFocus={event => {
        event.preventDefault();
        const trigger = previewTriggerRef.current;
        if (trigger?.isConnected && trigger.getClientRects().length) trigger.focus();
        else contactPanelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
      }} onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); setPreview(null); }}>
        <DialogTitle>{preview?.label || '二维码预览'}</DialogTitle>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {preview && (failedImages.includes(preview.url) ? <p className="public-contact-feedback" role="status">二维码暂时无法加载，请使用其他联系方式。</p> : <img src={preview.url} alt={`${preview.label}完整图片`} onError={() => setFailedImages(items => [...new Set([...items, preview.url])])} />)}
      </DialogContent>
    </Dialog>
  </>;
}
