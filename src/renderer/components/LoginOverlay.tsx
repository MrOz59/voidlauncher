import React from 'react'
import type { WebviewTag } from 'electron'
import { useI18n } from '../i18n'

const STORE_PARTITION = 'persist:online-fix'
const LOGIN_HOME = 'https://online-fix.me/'
const LOGIN_PAGE = 'https://online-fix.me/index.php?do=login'
const LOGIN_PROVIDER_URLS = {
  google: 'https://online-fix.me/auth.php?p=google&preloader=yes',
  discord: 'https://online-fix.me/auth.php?p=discord&preloader=yes'
}

const ALLOWED_HOSTS = new Set([
  'online-fix.me',
  'accounts.google.com',
  'accounts.google.com.br',
  'discord.com'
])
const ALLOWED_SUFFIXES = ['.online-fix.me', '.discord.com', '.discordapp.com', '.google.com', '.google.com.br']

function isAllowedLoginUrl(raw?: string | null) {
  const url = String(raw || '').trim()
  if (!url) return false
  if (url.startsWith('about:')) return true
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return false
    const host = parsed.hostname.toLowerCase()
    if (ALLOWED_HOSTS.has(host)) return true
    return ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix))
  } catch {
    return false
  }
}

// Minimal adblock for the login webview (same idea as StoreTab)
const cssRules = [
  '[class*="advertisement"]', '[class*="ad-container"]', '[class*="ad-banner"]',
  '[class*="ad-wrapper"]', '[class*="ad-slot"]', '[class*="adsense"]',
  '[id*="advertisement"]', '[id*="ad-container"]', '[id*="ad-banner"]',
  '[id*="google_ads"]', '[data-ad-client]', '[data-ad-slot]',
  'iframe[src*="doubleclick"]', 'iframe[src*="/ads"]', 'iframe[src*="googlesyndication"]',
  '.adsbygoogle', 'ins.adsbygoogle',
  '[class*="popup"]', '[class*="pop-up"]', '[class*="modal-ad"]', '[class*="overlay-ad"]',
  '[class*="yandex-ad"]', '[class*="begun"]', '[class*="adfox"]',
  'div[id*="yandex_ad"]'
]

const adBlockCSS = `
  ${cssRules.join(',\n  ')} {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    height: 0 !important;
    width: 0 !important;
    position: absolute !important;
    left: -9999px !important;
  }

  body, html {
    overflow: auto !important;
  }

  html[style*="overflow: hidden"] {
    overflow: auto !important;
  }
`

const buildLoginInstructionsScript = (labels: { title: string; instructions: string; gotIt: string }) => `
(function() {
  const labels = ${JSON.stringify({
    title: '__TITLE__',
    instructions: '__INSTRUCTIONS__',
    gotIt: '__GOT_IT__'
  })};
  labels.title = ${JSON.stringify(labels.title)};
  labels.instructions = ${JSON.stringify(labels.instructions)};
  labels.gotIt = ${JSON.stringify(labels.gotIt)};
  try {
    if (document.getElementById('of-login-instructions')) return;

    const wrap = document.createElement('div');
    wrap.id = 'of-login-instructions';
    wrap.style.cssText = [
      'position: fixed',
      'left: 16px',
      'right: 16px',
      'bottom: 16px',
      'z-index: 2147483647',
      'display: flex',
      'align-items: flex-start',
      'justify-content: space-between',
      'gap: 12px',
      'padding: 14px 14px',
      'border-radius: 12px',
      'background: rgba(15, 15, 15, 0.92)',
      'border: 1px solid rgba(255, 255, 255, 0.18)',
      'box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45)',
      'color: #fff',
      'font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Helvetica Neue, Arial, sans-serif'
    ].join(';');

    const text = document.createElement('div');
    text.style.cssText = 'font-size: 13px; line-height: 1.35; font-weight: 600;';
    text.innerHTML = [
      '<div style="font-size: 13px; font-weight: 800; margin-bottom: 4px;"></div>',
      '<div style="opacity: 0.85; font-weight: 600;"></div>'
    ].join('');
    text.children[0].textContent = labels.title;
    text.children[1].textContent = labels.instructions;

    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = labels.gotIt;
    close.style.cssText = [
      'flex: none',
      'cursor: pointer',
      'border-radius: 10px',
      'padding: 10px 12px',
      'border: 1px solid rgba(255, 255, 255, 0.18)',
      'background: rgba(255, 255, 255, 0.08)',
      'color: #fff',
      'font-weight: 800'
    ].join(';');
    close.addEventListener('click', function() {
      try { wrap.remove(); } catch(e) {}
    });

    wrap.appendChild(text);
    wrap.appendChild(close);

    document.documentElement.appendChild(wrap);
  } catch (e) {
    // ignore
  }
})();
`

const buildLoginClickScript = (provider: 'password' | 'google' | 'discord') => `
(function() {
  try {
    const lower = (s) => String(s || '').toLowerCase();
    const qs = (sel) => document.querySelector(sel);
    const closestLink = (el) => (el && typeof el.closest === 'function' ? el.closest('a') : null);
    const textIncludes = (el, tokens) => {
      const t = lower(el?.textContent || '');
      return tokens.some(tok => t.includes(tok));
    };
    const hrefIncludes = (el, tokens) => {
      const h = lower(el?.getAttribute?.('href') || '');
      return tokens.some(tok => h.includes(tok));
    };
    const navigateTo = (el) => {
      if (!el) return false;
      const href = el.getAttribute?.('href') || '';
      if (href) {
        try {
          const target = new URL(href, window.location.href).toString();
          window.location.assign(target);
          return true;
        } catch {}
      }
      if (typeof el.click === 'function') {
        el.click();
        return true;
      }
      return false;
    };

    const tokens = {
      password: ['login', 'entrar', 'вход', 'sign in', 'log in', 'autorizar'],
      google: ['google'],
      discord: ['discord']
    };

    const all = Array.from(document.querySelectorAll('a, button, div, span'));
    const pick = (pred) => all.find((el) => pred(el));

    if ('${provider}' === 'password') {
      const loginLink = pick((el) => hrefIncludes(el, ['do=login', 'login']) || textIncludes(el, tokens.password));
      if (loginLink && typeof loginLink.click === 'function') {
        loginLink.click();
        return true;
      }
      return false;
    }

    if ('${provider}' === 'google') {
      const googleLink =
        qs('a.btn-google[href]') ||
        qs('a[href*="p=google"]') ||
        qs('a[href*="auth.php"][href*="google"]') ||
        closestLink(qs('img[alt="Google"]')) ||
        pick((el) => hrefIncludes(el, ['google']) || textIncludes(el, tokens.google));
      if (navigateTo(googleLink)) return true;
    }

    if ('${provider}' === 'discord') {
      const discordLink =
        qs('a.btn-discord[href]') ||
        qs('a[href*="p=discord"]') ||
        qs('a[href*="auth.php"][href*="discord"]') ||
        closestLink(qs('img[alt="Discord"]')) ||
        pick((el) => hrefIncludes(el, ['discord']) || textIncludes(el, tokens.discord));
      if (navigateTo(discordLink)) return true;
    }
  } catch (e) {
    // ignore
  }
  return false;
})();
`

const buildPasswordSubmitScript = (username: string, password: string) => `
(function() {
  const user = ${JSON.stringify(username || '')};
  const pass = ${JSON.stringify(password || '')};
  console.log('[LoginScript] Starting password submit, URL:', location.href);
  if (!user || !pass) {
    console.log('[LoginScript] Missing credentials');
    return Promise.resolve({ ok: false, reason: 'missing-credentials' });
  }

  const findLoginForm = () => {
    // online-fix.me uses form#login-form with class login-form
    const direct =
      document.querySelector('form#login-form.login-form') ||
      document.querySelector('form#login-form') ||
      document.querySelector('form.login-form') ||
      document.querySelector('form[name="loginform"]') ||
      document.querySelector('form[action*="login"]');
    if (direct) {
      console.log('[LoginScript] Found form via direct selector');
      return direct;
    }

    const forms = Array.from(document.querySelectorAll('form'));
    console.log('[LoginScript] Total forms on page:', forms.length);
    const byPassword = forms.find((f) => f.querySelector('input[type="password"]'));
    if (byPassword) {
      console.log('[LoginScript] Found form via password input');
      return byPassword;
    }

    const docForms = Array.from(document.forms || []);
    const byDoc = docForms.find((f) => f.querySelector && f.querySelector('input[type="password"]'));
    if (byDoc) {
      console.log('[LoginScript] Found form via document.forms');
      return byDoc;
    }

    const frames = Array.from(document.querySelectorAll('iframe'));
    console.log('[LoginScript] Checking iframes:', frames.length);
    for (const frame of frames) {
      try {
        const doc = frame.contentDocument;
        if (!doc) continue;
        const f =
          doc.querySelector('form#login-form') ||
          doc.querySelector('form.login-form') ||
          doc.querySelector('form[action*="login"]') ||
          Array.from(doc.querySelectorAll('form')).find((x) => x.querySelector('input[type="password"]'));
        if (f) {
          console.log('[LoginScript] Found form inside iframe');
          return f;
        }
      } catch (e) {
        // ignore cross-origin iframes
      }
    }
    console.log('[LoginScript] No form found');
    return null;
  };

  const fillAndSubmit = (form) => {
    if (!form) return { ok: false, reason: 'no-form', href: location.href, forms: (document.forms || []).length };
    const ownerDoc = form.ownerDocument || document;
    const findInForm = (sel) => form.querySelector(sel) || ownerDoc.querySelector(sel);
    const inputs = Array.from(form.querySelectorAll('input'));
    console.log('[LoginScript] Form inputs:', inputs.length, inputs.map(i => i.name || i.type));

    const hasType = (el, type) => String((el && el.type) || '').toLowerCase() === type;
    const attr = (el, key) => String((el && el.getAttribute && el.getAttribute(key)) || '');
    const matches = (el, tokens) => tokens.some((t) => {
      const n = (attr(el, 'name') + ' ' + attr(el, 'id') + ' ' + attr(el, 'class')).toLowerCase();
      return n.includes(t);
    });

    // online-fix.me uses: input[name="login_name"] and input[name="login_password"]
    const userInput =
      findInForm('input[name="login_name"]') ||
      findInForm('input[name="login"]') ||
      findInForm('input[name="username"]') ||
      findInForm('input[type="email"]') ||
      inputs.find((el) => hasType(el, 'text') || hasType(el, 'email')) ||
      inputs.find((el) => matches(el, ['login', 'user', 'email', 'mail', 'nome']));

    const passInput =
      findInForm('input[name="login_password"]') ||
      findInForm('input[name="password"]') ||
      inputs.find((el) => hasType(el, 'password')) ||
      inputs.find((el) => matches(el, ['pass', 'senha']));

    console.log('[LoginScript] Found user input:', !!userInput, userInput?.name);
    console.log('[LoginScript] Found pass input:', !!passInput, passInput?.name);

    const setValue = (el, value) => {
      if (!el) return;
      el.focus?.();
      el.value = value;
      try {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      } catch {}
    };

    setValue(userInput, user);
    setValue(passInput, pass);

    // Try the site's dologin function first (online-fix.me uses this)
    const dologinOk = typeof window.dologin === 'function';
    console.log('[LoginScript] dologin function available:', dologinOk);
    if (dologinOk) {
      try {
        window.dologin();
        console.log('[LoginScript] Called dologin()');
        return { ok: true, reason: 'dologin', hasForm: true, hasUser: !!userInput, hasPass: !!passInput };
      } catch (e) {
        console.log('[LoginScript] dologin() error:', e);
      }
    }

    // Try clicking submit button
    const submitBtn = form.querySelector('button[type="submit"]') ||
      form.querySelector('input[type="submit"]') ||
      form.querySelector('.submit') ||
      form.querySelector('button');
    if (submitBtn) {
      console.log('[LoginScript] Clicking submit button');
      submitBtn.click();
      return { ok: true, reason: 'click-submit', hasForm: true, hasUser: !!userInput, hasPass: !!passInput };
    }

    if (form && typeof form.submit === 'function') {
      console.log('[LoginScript] Calling form.submit()');
      form.submit();
      return { ok: true, reason: 'submit', hasForm: true, hasUser: !!userInput, hasPass: !!passInput };
    }
    return { ok: false, reason: 'no-inputs' };
  };

  return new Promise((resolve) => {
    let tries = 0;
    const tick = () => {
      tries += 1;
      console.log('[LoginScript] Attempt', tries, 'URL:', location.href);
      const form = findLoginForm();
      if (form) return resolve(fillAndSubmit(form));
      if (tries >= 20) {
        console.log('[LoginScript] Gave up after', tries, 'attempts');
        return resolve({ ok: false, reason: 'no-form', href: location.href, tries });
      }
      setTimeout(tick, 400);
    };
    tick();
  });
})();
`

type Props = {
  open: boolean
  onClose: () => void
  onLoggedIn: () => void
}

export default function LoginOverlay({ open, onClose, onLoggedIn }: Props) {
  const { t } = useI18n()
  const webviewRef = React.useRef<WebviewTag | null>(null)
  const [checking, setChecking] = React.useState(false)
  const [loginUser, setLoginUser] = React.useState('')
  const [loginPass, setLoginPass] = React.useState('')
  const [loginError, setLoginError] = React.useState<string | null>(null)
  const [showWebview, setShowWebview] = React.useState(false)
  const [isLoggingIn, setIsLoggingIn] = React.useState(false)
  const injectedRef = React.useRef(false)
  const lastIntentRef = React.useRef<'password' | 'google' | 'discord' | null>(null)
  const pendingPasswordRef = React.useRef<{ user: string; pass: string } | null>(null)
  const pendingAttemptRef = React.useRef(0)

  const formatLoginError = (payload: any) => {
    const reason = String(payload?.reason || '')
    if (reason === 'missing-credentials') return t('login.error.missingCredentials')
    if (reason === 'no-form') {
      const href = payload?.href ? ` URL: ${payload.href}` : ''
      const forms = typeof payload?.forms === 'number' ? ` Forms: ${payload.forms}` : ''
      return `${t('login.error.noForm')}${href}${forms}`
    }
    if (reason === 'no-inputs') return t('login.error.noInputs')
    return t('login.error.siteLoginFailed')
  }

  const runPasswordAttempt = React.useCallback(async () => {
    const wv = webviewRef.current as any
    const pending = pendingPasswordRef.current
    // Only run for password login with pending credentials
    if (!wv || !pending) return false
    // Don't run if we're in OAuth mode
    if (lastIntentRef.current !== 'password') return false

    try {
      const res = await wv.executeJavaScript?.(buildPasswordSubmitScript(pending.user, pending.pass), true)
      if (res?.ok) {
        setLoginError(null)
        return true
      }
      if (!res?.ok) {
        if (res?.reason === 'no-form') {
          try {
            wv.loadURL(LOGIN_PAGE)
          } catch {
            // ignore
          }
        }
        setLoginError(formatLoginError(res))
      }
      return false
    } catch {
      setLoginError(t('login.error.siteLoginFailed'))
      return false
    }
  }, [t])

  const handleLoggedIn = React.useCallback(() => {
    pendingPasswordRef.current = null
    setLoginPass('')
    lastIntentRef.current = null
    setShowWebview(false)
    setIsLoggingIn(false)
    onLoggedIn()
  }, [onLoggedIn])

  const checkLoggedIn = React.useCallback(async () => {
    if (!open) return
    if (checking) return
    setChecking(true)
    try {
      const res = await window.electronAPI.getUserProfile()
      if (res?.success) {
        handleLoggedIn()
      }
    } catch {
      // ignore
    } finally {
      setChecking(false)
    }
  }, [open, checking, handleLoggedIn])

  React.useEffect(() => {
    if (!open) return

    const wv = webviewRef.current
    if (!wv) return

    const injectOnce = async () => {
      if (injectedRef.current) return
      injectedRef.current = true
      try {
        await (wv as any).insertCSS?.(adBlockCSS)
      } catch (e) {
        console.warn('[LoginOverlay] insertCSS failed:', e)
      }
      try {
        await (wv as any).executeJavaScript?.(buildLoginInstructionsScript({
          title: t('login.webview.title'),
          instructions: t('login.webview.instructions'),
          gotIt: t('login.webview.gotIt')
        }), true)
      } catch (e) {
        console.warn('[LoginOverlay] loginInstructionsScript failed:', e)
      }
    }

    const onLoaded = async () => {
      console.log('[LoginOverlay] Page loaded, URL:', (wv as any).getURL?.())
      await injectOnce()
      void checkLoggedIn()
      const intent = lastIntentRef.current

      // Only run password script for password login - OAuth providers handle their own flow
      if (intent === 'password' && pendingPasswordRef.current && wv) {
        // Wait a bit for JavaScript to initialize on the page
        await new Promise((r) => setTimeout(r, 500))
        try {
          console.log('[LoginOverlay] Running password attempt')
          void runPasswordAttempt()
        } catch (e) {
          console.warn('[LoginOverlay] Script execution failed:', e)
        }
      }
      // For Google/Discord, we don't need to run any scripts - user interacts directly
    }

    const onDomReady = () => {
      console.log('[LoginOverlay] DOM ready')
    }

    // Try a few common webview lifecycle events
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-finish-load', onLoaded)
    wv.addEventListener('did-navigate', onLoaded as any)
    wv.addEventListener('did-stop-loading', onLoaded)

    // The site's sign-in popups (window.open) are opened by the main process's
    // window open handler; <webview> has had no 'new-window' event since Electron 22.
    const onWillNavigate = (e: any) => {
      const url = String(e?.url || '')
      console.log('[LoginOverlay] Will navigate to:', url)
      if (!isAllowedLoginUrl(url)) {
        console.log('[LoginOverlay] Blocked navigation (not allowed)')
        e.preventDefault?.()
      }
    }
    wv.addEventListener('will-navigate', onWillNavigate as any)

    // Poll while open in case the site is SPA-ish
    const interval = setInterval(() => {
      void checkLoggedIn()
    }, 1500)

    return () => {
      clearInterval(interval)
      try { wv.removeEventListener('dom-ready', onDomReady) } catch {}
      try { wv.removeEventListener('did-finish-load', onLoaded) } catch {}
      try { wv.removeEventListener('did-navigate', onLoaded as any) } catch {}
      try { wv.removeEventListener('did-stop-loading', onLoaded) } catch {}
      try { wv.removeEventListener('will-navigate', onWillNavigate as any) } catch {}
    }
  }, [open, checkLoggedIn, runPasswordAttempt, t])

  React.useEffect(() => {
    if (!open) {
      injectedRef.current = false
      pendingPasswordRef.current = null
      lastIntentRef.current = null
      setLoginError(null)
      setLoginUser('')
      setLoginPass('')
      setShowWebview(false)
      setIsLoggingIn(false)
    }
  }, [open])

  if (!open) return null

  const triggerLogin = (kind: 'password' | 'google' | 'discord') => {
    console.log('[LoginOverlay] triggerLogin:', kind)
    lastIntentRef.current = kind
    injectedRef.current = false // Reset injection flag for new page

    // Show webview for OAuth providers (user needs to interact)
    if (kind === 'google' || kind === 'discord') {
      setShowWebview(true)
      setIsLoggingIn(false)
    } else {
      setShowWebview(false)
    }

    const wv = webviewRef.current as any
    if (!wv) {
      console.warn('[LoginOverlay] No webview ref')
      return
    }
    try {
      if (kind === 'google') {
        console.log('[LoginOverlay] Loading Google auth URL')
        wv.loadURL(LOGIN_PROVIDER_URLS.google)
      } else if (kind === 'discord') {
        console.log('[LoginOverlay] Loading Discord auth URL')
        wv.loadURL(LOGIN_PROVIDER_URLS.discord)
      } else {
        console.log('[LoginOverlay] Loading login page')
        wv.loadURL(LOGIN_PAGE)
      }
    } catch (e) {
      console.warn('[LoginOverlay] loadURL failed:', e)
    }
    // Note: the actual script execution happens in the 'did-finish-load' handler
  }

  const triggerPasswordLogin = () => {
    const user = loginUser.trim()
    const pass = loginPass
    console.log('[LoginOverlay] triggerPasswordLogin for user:', user)
    if (!user || !pass) {
      setLoginError(t('login.error.missingCredentials'))
      return
    }
    setLoginError(null)
    setIsLoggingIn(true)
    pendingPasswordRef.current = { user, pass }
    pendingAttemptRef.current = 0
    triggerLogin('password')
    // The script execution is now handled by the 'did-finish-load' event
    // We also retry a few times after the page loads
    const tryLoop = () => {
      if (!pendingPasswordRef.current) {
        console.log('[LoginOverlay] Password cleared, stopping retry loop')
        setIsLoggingIn(false)
        return
      }
      pendingAttemptRef.current += 1
      console.log('[LoginOverlay] Password attempt:', pendingAttemptRef.current)
      void runPasswordAttempt()
      if (pendingAttemptRef.current < 6) {
        setTimeout(tryLoop, 800)
      } else {
        // Stop loading after all attempts
        setIsLoggingIn(false)
      }
    }
    // Start the retry loop after giving the page time to load
    setTimeout(tryLoop, 1200)
  }

  return (
    <div className="login-overlay" role="dialog" aria-modal="true">
      <div className="login-overlay__scrim" onClick={onClose} />
      <div className="login-overlay__panel">
        <div className="login-overlay__header">
          <div className="login-overlay__title">{t('login.title')}</div>
          <div className="login-overlay__methods">
            <button className="login-overlay__method" data-provider="password" onClick={() => triggerLogin('password')}>
              {t('login.method.password')}
            </button>
            <button className="login-overlay__method" data-provider="google" onClick={() => triggerLogin('google')}>
              Google
            </button>
            <button className="login-overlay__method" data-provider="discord" onClick={() => triggerLogin('discord')}>
              Discord
            </button>
          </div>
          <button className="login-overlay__close" onClick={onClose} aria-label={t('login.close')}>
            ✕
          </button>
        </div>

        <div className="login-overlay__body">
          {showWebview ? (
            <div className="login-overlay__webview-header">
              <button
                className="login-overlay__back-btn"
                onClick={() => {
                  setShowWebview(false)
                  lastIntentRef.current = null
                }}
              >
                ← {t('login.back')}
              </button>
              <span className="login-overlay__webview-title">
                {lastIntentRef.current === 'google' ? t('login.withGoogle') : t('login.withDiscord')}
              </span>
            </div>
          ) : (
            <div className="login-overlay__form">
              <div className="login-overlay__form-title">{t('login.withPassword')}</div>
              <div className="login-overlay__form-row">
                <input
                  className="login-overlay__input"
                  type="text"
                  value={loginUser}
                  onChange={(e) => {
                    setLoginUser(e.target.value)
                    if (loginError) setLoginError(null)
                  }}
                  placeholder={t('login.usernamePlaceholder')}
                  autoComplete="username"
                  disabled={isLoggingIn}
                />
                <input
                  className="login-overlay__input"
                  type="password"
                  value={loginPass}
                  onChange={(e) => {
                    setLoginPass(e.target.value)
                    if (loginError) setLoginError(null)
                  }}
                  placeholder={t('login.passwordPlaceholder')}
                  autoComplete="current-password"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isLoggingIn) triggerPasswordLogin()
                  }}
                  disabled={isLoggingIn}
                />
                <button
                  className="btn accent"
                  onClick={triggerPasswordLogin}
                  disabled={isLoggingIn}
                >
                  {isLoggingIn ? (
                    <span className="login-overlay__spinner" />
                  ) : (
                    t('login.submit')
                  )}
                </button>
              </div>
              {loginError && <div className="login-overlay__error">{loginError}</div>}
              {isLoggingIn && (
                <div className="login-overlay__loading">
                  <span className="login-overlay__spinner" />
                  <span>{t('login.loading')}</span>
                </div>
              )}
              <div className="login-overlay__divider">{t('login.divider')}</div>
              <div className="login-overlay__social">
                <button
                  className="login-overlay__method"
                  data-provider="google"
                  onClick={() => triggerLogin('google')}
                  disabled={isLoggingIn}
                >
                  Google
                </button>
                <button
                  className="login-overlay__method"
                  data-provider="discord"
                  onClick={() => triggerLogin('discord')}
                  disabled={isLoggingIn}
                >
                  Discord
                </button>
              </div>
              <div className="login-overlay__note">{t('login.note')}</div>
            </div>
          )}
          {/* One webview for every method, hidden for password login. Swapping in a
              second element when Google/Discord is picked threw away the provider
              URL triggerLogin had just loaded and showed the site's login page. */}
          <webview
            ref={(el: any) => {
              webviewRef.current = el
            }}
            src={LOGIN_PAGE}
            partition={STORE_PARTITION}
            // @ts-expect-error - webview expects string attributes
            allowpopups="true"
            webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes, javascript=yes"
            className={`login-overlay__webview${showWebview ? ' login-overlay__webview--visible' : ''}`}
          />

        </div>

        <div className="login-overlay__footer">
          <div className="login-overlay__hint">
            {showWebview
              ? t('login.footer.webview')
              : t('login.footer.default')}
          </div>
        </div>
      </div>
    </div>
  )
}
