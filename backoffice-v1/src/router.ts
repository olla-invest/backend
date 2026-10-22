import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'members' }
  | { name: 'memberDetail'; userId: string }
  | { name: 'dashboard' }
  | { name: 'service' };

// 정적 파일로 배포해도 서버 rewrite 없이 동작하도록 해시 라우팅을 쓴다.
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/members';
  const detail = path.match(/^\/members\/([0-9a-f-]{36})\/?$/i);
  if (detail) return { name: 'memberDetail', userId: detail[1] };
  if (path.startsWith('/dashboard')) return { name: 'dashboard' };
  if (path.startsWith('/service')) return { name: 'service' };
  return { name: 'members' };
}

function subscribe(callback: () => void) {
  window.addEventListener('hashchange', callback);
  return () => window.removeEventListener('hashchange', callback);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseRoute(hash);
}

export function navigate(path: string) {
  window.location.hash = path;
}
