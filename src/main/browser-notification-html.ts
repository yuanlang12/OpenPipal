import type { TOptions } from 'i18next'
import type { SupportedLocale } from '../shared/i18n/contract'

type Translate = (key: string, options?: TOptions) => string

export function renderBrowserNotificationHtml(
  browserName: string,
  locale: SupportedLocale,
  t: Translate
): string {
  // The prompt may be rendered while the process-wide i18n instance is still
  // applying a just-detected system-locale change. Pin every lookup to the
  // requested locale so <html lang> and the visible copy can never disagree.
  const translate = (key: string, options?: TOptions): string =>
    t(key, { ...options, lng: locale })
  return `<!DOCTYPE html>
<html lang="${locale}"><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: -apple-system, "PingFang SC", sans-serif;
    background: white;
    border-radius: 12px;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    border: 1px solid #e7e5e4;
    box-shadow: 0 8px 30px rgba(0,0,0,0.12);
  }
  .header { display:flex; align-items:center; gap:8px; }
  .avatar { width:28px; height:28px; border-radius:50%; background:#14b8a6; display:flex; align-items:center; justify-content:center; color:white; font-size:14px; font-weight:600; }
  .title { font-size:13px; font-weight:600; color:#1c1917; }
  .body { font-size:12px; color:#57534e; line-height:1.5; }
  .actions { display:flex; gap:8px; justify-content:flex-end; }
  button { padding:6px 16px; border-radius:8px; font-size:12px; cursor:pointer; border:none; }
  .dismiss { background:#f5f5f4; color:#78716c; }
  .dismiss:hover { background:#e7e5e4; }
  .action { background:#14b8a6; color:white; font-weight:500; }
  .action:hover { background:#0d9488; }
</style></head><body>
  <div class="header">
    <div class="avatar">S</div>
    <span class="title">OpenPipal</span>
  </div>
  <div class="body">${translate('shell.browserExtension.prompt', { browserName })}</div>
  <div class="actions">
    <button class="dismiss" onclick="window.close()">${translate('shell.browserExtension.dismiss')}</button>
    <button class="action" onclick="location.href='openpipal://install-extension'">${translate('shell.browserExtension.workTogether')}</button>
  </div>
</body></html>`
}
