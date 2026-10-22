export type UserStatus = 'ACTIVE' | 'INACTIVE' | 'DORMANT' | 'DELETED';
export type PlanType = 'FREE' | 'BASIC' | 'PRO' | 'PREMIUM';
export type AuthProvider = 'LOCAL' | 'KAKAO' | 'NAVER';
export type AdminRole = 'SUPER_ADMIN' | 'OPERATOR' | 'VIEWER';

export interface Admin {
  adminId: string;
  loginId: string;
  name: string;
  role: AdminRole;
}

export interface MemberRow {
  userId: string;
  username: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  provider: AuthProvider;
  planType: PlanType;
  status: UserStatus;
  createdAt: string;
  deletedAt: string | null;
}

export interface MemberListResponse {
  users: MemberRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface MemberDetail {
  userId: string;
  username: string;
  name: string | null;
  status: UserStatus;
  planType: PlanType;
  nextBillingDate: string | null;
  basicInfo: {
    email: string | null;
    phone: string | null;
    provider: AuthProvider;
    createdAt: string;
    lastLoginAt: string | null;
    marketingConsent: boolean;
    marketingConsentAt: string | null;
    masked: boolean;
  };
  activitySummary: {
    windowDays: number;
    visitedDays: number;
    filterApplied: number | null;
    savedFilters: number;
    watchlistCount: number;
  };
  loginHistories: Array<{
    loggedInAt: string;
    provider: AuthProvider | null;
    ipAddress: string | null;
    device: string | null;
  }>;
  planHistories: Array<{
    historyId: string;
    fromPlan: PlanType | null;
    toPlan: PlanType;
    note: string | null;
    reason: string | null;
    effectiveAt: string;
    expiresAt: string | null;
    changedBy: string | null;
  }>;
  auditLogs: Array<{
    logId: string;
    createdAt: string;
    adminLoginId: string;
    adminName: string;
    action: string;
    description: string;
    reason: string | null;
    success: boolean;
  }>;
}

export interface UnmaskedProfile {
  email: string | null;
  name: string | null;
  phone: string | null;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type QueryValue = string | number | boolean | string[] | null | undefined;
export type Query = Record<string, QueryValue>;

// 같은 출처의 /api 를 개발·미리보기 서버가 백엔드로 프록시한다 (vite.config.ts).
const API_BASE = '/api';

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
      continue;
    }
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

async function readError(response: Response): Promise<ApiError> {
  let message = `요청에 실패했습니다. (${response.status})`;
  try {
    const body = await response.json();
    const raw = body?.message;
    if (Array.isArray(raw)) message = raw.join('\n');
    else if (typeof raw === 'string' && raw) message = raw;
  } catch {
    /* 본문이 JSON 이 아니면 기본 문구를 쓴다. */
  }
  return new ApiError(message, response.status);
}

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  return match ? decodeURIComponent(match[1]) : fallback;
}

export function createApiClient(getToken: () => string | null, onUnauthorized: () => void) {
  async function send(method: string, path: string, options: { query?: Query; body?: unknown } = {}) {
    const token = getToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    if (!response.ok) {
      // 로그인 상태에서만 세션 만료로 처리한다 (로그인 실패 401 은 화면에서 안내).
      if (response.status === 401 && token) onUnauthorized();
      throw await readError(response);
    }
    return response;
  }

  async function json<T>(method: string, path: string, options?: { query?: Query; body?: unknown }): Promise<T> {
    const response = await send(method, path, options);
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    get: <T>(path: string, query?: Query) => json<T>('GET', path, { query }),
    post: <T>(path: string, body?: unknown) => json<T>('POST', path, { body: body ?? {} }),
    patch: <T>(path: string, body?: unknown) => json<T>('PATCH', path, { body: body ?? {} }),
    /** 파일 응답을 받아 브라우저 다운로드로 저장하고 행 수를 돌려준다. */
    async download(path: string, query: Query, fallbackName: string): Promise<number | null> {
      const response = await send('GET', path, { query });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filenameFrom(response.headers.get('Content-Disposition'), fallbackName);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      const rows = response.headers.get('X-Total-Rows');
      return rows === null ? null : Number(rows);
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return '알 수 없는 오류가 발생했습니다.';
}
