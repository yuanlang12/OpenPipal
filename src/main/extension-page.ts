import type { SupportedLocale } from '../shared/i18n/contract'
import { APP_I18N_RESOURCES } from '../shared/i18n/resources'

const EXTENSIONS_URL = 'chrome://extensions/'
const EXTENSION_FOLDER = 'openpipal-extension'

export function escapeExtensionPageHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] || character)
}

export function getExtensionPageHtml(locale: SupportedLocale): string {
  const messages = APP_I18N_RESOURCES[locale].extensionInstall
  const html = escapeExtensionPageHtml

  return `<!DOCTYPE html>
<html lang="${html(locale)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${html(messages.metaTitle)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
      background: #fafaf9;
      color: #292524;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      padding: 60px 20px;
    }
    .container { max-width: 640px; width: 100%; }
    .hero { text-align: center; margin-bottom: 48px; }
    .logo {
      width: 64px; height: 64px;
      border-radius: 16px;
      background: #14b8a6;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-size: 28px;
      font-weight: 700;
      margin-bottom: 20px;
    }
    h1 {
      font-size: 28px;
      font-weight: 700;
      color: #1c1917;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
      overflow-wrap: anywhere;
    }
    .subtitle { font-size: 15px; color: #78716c; line-height: 1.6; overflow-wrap: anywhere; }
    .features {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      margin-bottom: 40px;
    }
    .feature {
      min-width: 0;
      background: white;
      border: 1px solid #e7e5e4;
      border-radius: 12px;
      padding: 20px;
    }
    .feature-icon { font-size: 24px; margin-bottom: 10px; }
    .feature h3 { font-size: 14px; font-weight: 600; color: #1c1917; margin-bottom: 6px; overflow-wrap: anywhere; }
    .feature p { font-size: 13px; color: #78716c; line-height: 1.5; overflow-wrap: anywhere; }
    .install-section {
      background: white;
      border: 1px solid #e7e5e4;
      border-radius: 16px;
      padding: 32px;
      margin-bottom: 32px;
    }
    .install-section h2 { font-size: 18px; font-weight: 600; color: #1c1917; margin-bottom: 20px; }
    .steps { list-style: none; counter-reset: step; }
    .steps li {
      counter-increment: step;
      display: flex;
      align-items: flex-start;
      gap: 12px;
      margin-bottom: 16px;
      font-size: 14px;
      color: #44403c;
      line-height: 1.6;
    }
    .steps li:last-child { margin-bottom: 0; }
    .steps li::before {
      content: counter(step);
      flex-shrink: 0;
      width: 24px; height: 24px;
      border-radius: 50%;
      background: #14b8a6;
      color: white;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-top: 1px;
    }
    .step-content { min-width: 0; overflow-wrap: anywhere; }
    code {
      background: #f5f5f4;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
      color: #0f766e;
      font-family: "SF Mono", monospace;
      overflow-wrap: anywhere;
    }
    .path-box {
      background: #1c1917;
      color: #e7e5e4;
      border-radius: 8px;
      padding: 12px 16px;
      font-family: "SF Mono", monospace;
      font-size: 13px;
      margin: 12px 0;
      user-select: all;
      cursor: pointer;
      overflow-wrap: anywhere;
    }
    .path-box:hover::after {
      content: attr(data-copy-label);
      display: block;
      margin-top: 6px;
      font-size: 11px;
      color: #a8a29e;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    }
    .path-box.copied::after { content: attr(data-copied-label); color: #14b8a6; }
    .note { font-size: 12px; color: #a8a29e; text-align: center; margin-top: 24px; line-height: 1.6; }
    .note span { display: block; overflow-wrap: anywhere; }
    @media (max-width: 500px) {
      body { padding-top: 32px; }
      .features { grid-template-columns: minmax(0, 1fr); }
      .install-section { padding: 24px; }
    }
  </style>
</head>
<body>
  <main class="container">
    <header class="hero">
      <div class="logo">S</div>
      <h1>${html(messages.hero.title)}</h1>
      <p class="subtitle">${html(messages.hero.subtitle)}</p>
    </header>

    <section class="features">
      <article class="feature">
        <div class="feature-icon">📄</div>
        <h3>${html(messages.features.web.title)}</h3>
        <p>${html(messages.features.web.description)}</p>
      </article>
      <article class="feature">
        <div class="feature-icon">🎬</div>
        <h3>${html(messages.features.video.title)}</h3>
        <p>${html(messages.features.video.description)}</p>
      </article>
      <article class="feature">
        <div class="feature-icon">🔍</div>
        <h3>${html(messages.features.selection.title)}</h3>
        <p>${html(messages.features.selection.description)}</p>
      </article>
      <article class="feature">
        <div class="feature-icon">🔗</div>
        <h3>${html(messages.features.continuity.title)}</h3>
        <p>${html(messages.features.continuity.description)}</p>
      </article>
    </section>

    <section class="install-section">
      <h2>${html(messages.installTitle)}</h2>
      <ol class="steps">
        <li><div class="step-content">${html(messages.steps.openChrome)} <code>${html(EXTENSIONS_URL)}</code></div></li>
        <li><div class="step-content">${html(messages.steps.enableDeveloperBefore)} <strong>${html(messages.steps.developerMode)}</strong></div></li>
        <li><div class="step-content">${html(messages.steps.selectBefore)} <strong>${html(messages.steps.loadUnpacked)}</strong></div></li>
        <li><div class="step-content">${html(messages.steps.chooseFolder)}
          <div class="path-box" role="button" tabindex="0" aria-label="${html(messages.actions.copy)}" data-copy-label="${html(messages.actions.copy)}" data-copied-label="${html(messages.actions.copied)}">${html(EXTENSION_FOLDER)}</div>
        </div></li>
        <li><div class="step-content">${html(messages.steps.complete)}</div></li>
      </ol>
    </section>

    <p class="note">
      <span>${html(messages.notes.desktopRequired)}</span>
      <span>${html(messages.notes.storeLater)}</span>
    </p>
  </main>
  <script>
    const pathBox = document.querySelector('.path-box');
    const copyPath = async () => {
      if (!(pathBox instanceof HTMLElement)) return;
      try {
        await navigator.clipboard.writeText(pathBox.textContent?.trim() || '');
        pathBox.classList.add('copied');
        window.setTimeout(() => pathBox.classList.remove('copied'), 2000);
      } catch {
        pathBox.focus();
      }
    };
    pathBox?.addEventListener('click', () => { void copyPath(); });
    pathBox?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      void copyPath();
    });
  </script>
</body>
</html>`
}
