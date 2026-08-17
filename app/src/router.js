import { useEffect, useState, useCallback } from 'react';

/**
 * Routing, in forty lines.
 *
 * Reoperative does the same thing (pushState + popstate, no router library) so
 * ported pages will not fight this. There is no dependency to keep current and
 * no route config to keep in sync with the nav.
 *
 * Every path here is relative to /app.
 */
const BASE = '/app';

export function currentPath() {
  const p = window.location.pathname;
  const stripped = p.startsWith(BASE) ? p.slice(BASE.length) : p;
  return stripped.replace(/\/+$/, '') || '/';
}

export function navigate(to) {
  const target = BASE + (to === '/' ? '' : to);
  if (target === window.location.pathname) return;
  window.history.pushState({}, '', target);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute() {
  const [path, setPath] = useState(currentPath);

  useEffect(() => {
    const onPop = () => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return path;
}

/**
 * Intercepts clicks on in-app links so they route without a page load, while
 * leaving modified clicks (new tab, download) and external links alone.
 */
export function useLinkInterceptor() {
  const onClick = useCallback((e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href.startsWith(BASE)) return;
    e.preventDefault();
    navigate(href.slice(BASE.length) || '/');
  }, []);

  useEffect(() => {
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [onClick]);
}

/** `/leads/:id` -> id, for the one dynamic route the app has today. */
export function matchLeadId(path) {
  const m = path.match(/^\/leads\/([0-9a-f-]{36})$/i);
  return m ? m[1] : null;
}
