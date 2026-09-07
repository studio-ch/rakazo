/** Executed in the renderer; keep readiness independent of translated UI text. */
export const MOUNTED_APP_DOCUMENT_READY = String.raw`(() => {
  const appState = document.querySelector('[data-rakazo-app-state]')?.getAttribute('data-rakazo-app-state') ?? null;
  if (appState === 'session-pending') return false;
  const shell = document.querySelector('[data-testid="shell-root"]');
  const shellBootstrapped = Boolean(
    (shell && shell.getAttribute('data-ready') === 'true') ||
    performance.getEntriesByName('rk:renderer:shell-ready').length > 0
  );
  const authOrWelcomeSurface = Boolean(
    document.querySelector('[data-testid="welcome-page"]') ||
    document.querySelector('form input[type="email"], form input[name="email"], form input#email') ||
    Array.from(document.querySelectorAll('button')).some((button) => /sign\s*in/i.test((button.textContent || '').trim())) ||
    document.querySelector('[aria-label="Model"], [aria-label="Model id"], [aria-label="Models from server"]')
  );
  const sessionReady = appState === 'ready' || performance.getEntriesByName('rk:renderer:session-committed').length > 0;
  if (sessionReady && (shellBootstrapped || authOrWelcomeSurface)) return true;
  // Plain desktop fixtures omit the app-state marker; loading shells still fail.
  if (appState === null) {
    const bodyText = (document.body?.innerText || '').trim();
    if (bodyText.includes('Opening your Space') || bodyText === 'Loading…' || bodyText === 'Loading...') return false;
    const mainText = (document.querySelector('main')?.textContent || '').trim();
    const rootChildren = document.getElementById('root')?.childElementCount ?? 0;
    return mainText.length > 0 || rootChildren > 0;
  }
  return false;
})()`;
