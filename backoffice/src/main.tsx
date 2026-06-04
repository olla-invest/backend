import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Check, Edit3, Plus, RefreshCw, Search, Shield, Tags, Trash2, Undo2, Users } from 'lucide-react';
import './styles.css';

type Tab = 'users' | 'metrics' | 'themes';

type UserRow = {
  userId: string;
  username: string;
  email: string;
  name: string | null;
  phone: string | null;
  provider: string;
  planType: string;
  marketingConsent: boolean;
  isTempPassword: boolean;
  createdAt: string;
  deletedAt: string | null;
  status: 'ACTIVE' | 'DELETED';
};

type MetricRow = {
  metricId: string;
  stockCode: string;
  companyName: string;
  marketType: string;
  rank: number;
  closePrice: number;
  relativeStrengthScore: number;
  rsRaw: number | null;
  priceChangeRate1d: number | null;
  tradingValue: string | null;
  ma50: number | null;
  ma150: number | null;
  ma200: number | null;
  ma200Uptrend: boolean | null;
  passedStaticFilters: boolean;
  isNewHigh: boolean;
  isVolatilityContraction: boolean;
  isPriceCompression: boolean;
  isTrendTemplate: boolean;
  strengthContinuationDays: number | null;
};

type ThemeRow = {
  themeCode: number;
  themeName: string;
  source: string;
  sourceThemeNo: string | null;
  stockCount: number;
  status: 'ACTIVE' | 'DELETED';
};

const planTypes = ['FREE', 'BASIC', 'PRO', 'PREMIUM'];
const providers = ['LOCAL', 'NAVER', 'KAKAO'];

function App() {
  const [tab, setTab] = useState<Tab>('users');
  const [baseUrl, setBaseUrl] = useStoredState('bo.baseUrl', 'https://ballot-pack-donations-exposure.trycloudflare.com/');
  const [adminKey, setAdminKey] = useStoredState('bo.adminKey', 'local-admin-dev-key');

  const api = useMemo(() => createApi(baseUrl, adminKey), [baseUrl, adminKey]);

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand">
          <Shield size={22} />
          <div>
            <strong>Backoffice</strong>
            <span>Kiwoom Admin</span>
          </div>
        </div>
        <nav>
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
            <Users size={18} /> Users
          </button>
          <button className={tab === 'metrics' ? 'active' : ''} onClick={() => setTab('metrics')}>
            <Check size={18} /> Metrics
          </button>
          <button className={tab === 'themes' ? 'active' : ''} onClick={() => setTab('themes')}>
            <Tags size={18} /> Themes
          </button>
        </nav>
      </aside>

      <section className="content">
        <header className="topbar">
          <label>
            API URL
            <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
          </label>
          <label>
            Admin Key
            <input type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} />
          </label>
        </header>

        {tab === 'users' ? <UsersView api={api} /> : tab === 'metrics' ? <MetricsView api={api} /> : <ThemesView api={api} />}
      </section>
    </main>
  );
}

function UsersView({ api }: { api: ReturnType<typeof createApi> }) {
  const [rows, setRows] = useState<UserRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(30);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get('/users/admin', { page, pageSize, search, includeDeleted });
      setRows(data.users);
      setTotalCount(data.totalCount || 0);
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setError(getMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [page, pageSize, includeDeleted]);

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    setPage(1);
    load();
  };

  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h1>Users</h1>
        </div>
        <button className="primary" onClick={() => setCreateOpen(true)}>
          <Plus size={18} /> New
        </button>
      </div>

      <form className="toolbar" onSubmit={submitSearch}>
        <div className="searchBox">
          <Search size={18} />
          <input placeholder="아이디, 이메일, 이름, 전화번호" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <label className="checkLabel">
          <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
          삭제 계정 포함
        </label>
        <select className="pageSize" value={pageSize} onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }}>
          {[20, 30, 50, 100].map((size) => <option key={size} value={size}>{size} rows</option>)}
        </select>
        <button type="submit"><RefreshCw size={16} /> 조회</button>
      </form>

      {error && <div className="error">{error}</div>}
      {tempPassword && <div className="notice">임시 비밀번호: <strong>{tempPassword}</strong></div>}

      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>아이디</th>
              <th>이메일</th>
              <th>이름</th>
              <th>전화</th>
              <th>가입</th>
              <th>플랜</th>
              <th>상태</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((user) => (
              <tr key={user.userId}>
                <td>{user.username}</td>
                <td>{user.email}</td>
                <td>{user.name || '-'}</td>
                <td>{user.phone || '-'}</td>
                <td>{user.provider}</td>
                <td>{user.planType}</td>
                <td><span className={`badge ${user.status.toLowerCase()}`}>{user.status}</span></td>
                <td className="actions">
                  <button title="수정" onClick={() => setEditing(user)}><Edit3 size={16} /></button>
                  {user.deletedAt ? (
                    <button title="복구" onClick={async () => { await api.patch(`/users/admin/${user.userId}`, { restore: true }); load(); }}><Undo2 size={16} /></button>
                  ) : (
                    <button title="삭제" onClick={async () => { await api.patch(`/users/admin/${user.userId}`, { delete: true }); load(); }}><Trash2 size={16} /></button>
                  )}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={8} className="empty">데이터가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>

      <Pager page={page} pageSize={pageSize} totalCount={totalCount} totalPages={totalPages} onPage={setPage} />

      {createOpen && (
        <UserDialog
          title="사용자 생성"
          onClose={() => setCreateOpen(false)}
          onSubmit={async (payload) => {
            const result = await api.post('/users/admin', payload);
            setTempPassword(result.tempPassword || '');
            setCreateOpen(false);
            load();
          }}
        />
      )}

      {editing && (
        <UserDialog
          title="사용자 수정"
          user={editing}
          onClose={() => setEditing(null)}
          onSubmit={async (payload) => {
            await api.patch(`/users/admin/${editing.userId}`, payload);
            setEditing(null);
            load();
          }}
        />
      )}
    </section>
  );
}

function UserDialog({ title, user, onClose, onSubmit }: {
  title: string;
  user?: UserRow;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    username: user?.username || '',
    email: user?.email || '',
    password: '',
    name: user?.name || '',
    phone: user?.phone || '',
    planType: user?.planType || 'FREE',
    marketingConsent: user?.marketingConsent || false,
    isTempPassword: user?.isTempPassword || false,
  });
  const [error, setError] = useState('');

  return (
    <div className="modalBackdrop">
      <form className="modal" onSubmit={async (event) => {
        event.preventDefault();
        setError('');
        try {
          const payload: Record<string, unknown> = { ...form };
          if (!form.password) delete payload.password;
          await onSubmit(payload);
        } catch (err) {
          setError(getMessage(err));
        }
      }}>
        <h2>{title}</h2>
        {error && <div className="error">{error}</div>}
        <div className="grid2">
          <label>아이디<input required value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></label>
          <label>이메일<input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label>비밀번호<input type="password" placeholder={user ? '변경 시 입력' : '비우면 임시 생성'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <label>플랜<select value={form.planType} onChange={(e) => setForm({ ...form, planType: e.target.value })}>{planTypes.map((p) => <option key={p}>{p}</option>)}</select></label>
          <label>이름<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>전화<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
        </div>
        <label className="checkLabel"><input type="checkbox" checked={form.marketingConsent} onChange={(e) => setForm({ ...form, marketingConsent: e.target.checked })} /> 마케팅 동의</label>
        <label className="checkLabel"><input type="checkbox" checked={form.isTempPassword} onChange={(e) => setForm({ ...form, isTempPassword: e.target.checked })} /> 임시 비밀번호 상태</label>
        <div className="modalActions">
          <button type="button" onClick={onClose}>취소</button>
          <button className="primary" type="submit">저장</button>
        </div>
      </form>
    </div>
  );
}

function MetricsView({ api }: { api: ReturnType<typeof createApi> }) {
  const [rows, setRows] = useState<MetricRow[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [tradeDate, setTradeDate] = useState('');
  const [marketType, setMarketType] = useState('all');
  const [mode, setMode] = useState('aggregated');
  const [passed, setPassed] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recalculating, setRecalculating] = useState(false);

  const load = async () => {
    setError('');
    try {
      const data = await api.get('/real-time-chart/admin/metrics', {
        tradeDate,
        marketType,
        mode,
        page,
        pageSize,
        search,
        ...(mode === 'raw' && passed !== 'all' ? { passedStaticFilters: passed } : {}),
      });
      setRows(data.rows);
      setDates(data.dates);
      setTradeDate(data.tradeDate || '');
      setTotalCount(data.totalCount || 0);
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setError(getMessage(err));
    }
  };

  useEffect(() => {
    load();
  }, [page, pageSize, marketType, mode, passed]);

  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h1>Daily Metrics</h1>
        </div>
        <button type="button" className="primary" onClick={async () => {
          const targetDate = (tradeDate || dates[0] || '').replace(/-/g, '');
          if (!targetDate) {
            setError('재집계할 거래일이 없습니다.');
            return;
          }
          if (!window.confirm(`${targetDate} 전체 메트릭스를 재집계할까요?`)) return;
          setRecalculating(true);
          setError('');
          setNotice('');
          try {
            await api.post('/real-time-chart/metrics/calculate', {
              marketType: 'all',
              tradeDate: targetDate,
              writeLogFile: false,
            });
            setNotice(`${targetDate} 전체 재집계가 완료되었습니다.`);
            setPage(1);
            await load();
          } catch (err) {
            setError(getMessage(err));
          } finally {
            setRecalculating(false);
          }
        }} disabled={recalculating}>
          <RefreshCw size={16} /> {recalculating ? '재집계 중' : '전체 재집계'}
        </button>
      </div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
        <select value={tradeDate} onChange={(e) => setTradeDate(e.target.value)}>
          {dates.length === 0 && <option value="">최신 거래일</option>}
          {dates.map((date) => <option key={date} value={date}>{date}</option>)}
        </select>
        <select value={marketType} onChange={(e) => setMarketType(e.target.value)}>
          <option value="all">전체</option>
          <option value="0">KOSPI</option>
          <option value="10">KOSDAQ</option>
        </select>
        <select value={mode} onChange={(e) => { setPage(1); setMode(e.target.value); }}>
          <option value="aggregated">집계 결과</option>
          <option value="raw">원본 메트릭</option>
        </select>
        <select value={passed} disabled={mode === 'aggregated'} onChange={(e) => setPassed(e.target.value)}>
          <option value="all">필터 전체</option>
          <option value="true">통과</option>
          <option value="false">미통과</option>
        </select>
        <select className="pageSize" value={pageSize} onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }}>
          {[30, 50, 100, 200].map((size) => <option key={size} value={size}>{size} rows</option>)}
        </select>
        <div className="searchBox"><Search size={18} /><input placeholder="종목코드" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
        <button type="submit"><RefreshCw size={16} /> 조회</button>
      </form>
      {error && <div className="error">{error}</div>}
      {notice && <div className="notice">{notice}</div>}
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>순위</th>
              <th>종목</th>
              <th>시장</th>
              <th>RS Score</th>
              <th>RS Raw</th>
              <th>종가</th>
              <th>등락률</th>
              <th>거래대금</th>
              <th>MA50</th>
              <th>MA150</th>
              <th>MA200</th>
              <th>MA200 Trend</th>
              <th>필터</th>
              <th>신호</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.metricId}>
                <td>{row.rank}</td>
                <td><strong>{row.companyName}</strong><span className="sub">{row.stockCode}</span></td>
                <td>{row.marketType}</td>
                <td>{row.relativeStrengthScore.toFixed(2)}</td>
                <td>{formatRsRaw(row.rsRaw)}</td>
                <td>{formatNumber(row.closePrice)}</td>
                <td className={row.priceChangeRate1d && row.priceChangeRate1d > 0 ? 'up' : row.priceChangeRate1d && row.priceChangeRate1d < 0 ? 'down' : ''}>{formatRate(row.priceChangeRate1d)}</td>
                <td>{formatBig(row.tradingValue)}</td>
                <td>{row.ma50 ? formatNumber(row.ma50) : '-'}</td>
                <td>{row.ma150 ? formatNumber(row.ma150) : '-'}</td>
                <td>{row.ma200 ? formatNumber(row.ma200) : '-'}</td>
                <td>{formatUptrend(row.ma200Uptrend)}</td>
                <td><span className={`badge ${row.passedStaticFilters ? 'active' : 'deleted'}`}>{row.passedStaticFilters ? 'PASS' : 'FAIL'}</span></td>
                <td className="signals">{[row.isNewHigh && 'NH', row.isVolatilityContraction && 'VC', row.isPriceCompression && 'PC', row.isTrendTemplate && 'TT'].filter(Boolean).join(' ') || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={pageSize} totalCount={totalCount} totalPages={totalPages} onPage={setPage} />
    </section>
  );
}

function ThemesView({ api }: { api: ReturnType<typeof createApi> }) {
  const [rows, setRows] = useState<ThemeRow[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('all');
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');

  const load = async (overrides: Partial<{ page: number; pageSize: number; search: string; source: string; includeDeleted: boolean }> = {}) => {
    setLoading(true);
    setError('');
    try {
      const data = await api.get('/issue-theme/admin/themes', {
        page: overrides.page ?? page,
        pageSize: overrides.pageSize ?? pageSize,
        search: overrides.search ?? search,
        source: overrides.source ?? source,
        includeDeleted: overrides.includeDeleted ?? includeDeleted,
      });
      setRows(data.themes);
      setTotalCount(data.totalCount || 0);
      setTotalPages(data.totalPages || 1);
    } catch (err) {
      setError(getMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [page, pageSize, source, includeDeleted]);

  const syncGroups = async () => {
    setSyncing(true);
    setError('');
    try {
      await api.post('/issue-theme/sync-grouped-themes', {});
      setSource('GROUP');
      setPage(1);
      await load({ page: 1, source: 'GROUP' });
    } catch (err) {
      setError(getMessage(err));
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="panel">
      <div className="panelHeader">
        <div>
          <h1>Themes</h1>
        </div>
        <button type="button" onClick={syncGroups} disabled={syncing}>
          <RefreshCw size={16} /> {syncing ? 'Syncing' : 'Sync Groups'}
        </button>
      </div>
      <form className="toolbar" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
        <div className="searchBox">
          <Search size={18} />
          <input placeholder="theme code, name, source no" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select value={source} onChange={(e) => { setPage(1); setSource(e.target.value); }}>
          <option value="all">All sources</option>
          <option value="LEGACY">LEGACY</option>
          <option value="NAVER">NAVER</option>
          <option value="GROUP">GROUP</option>
        </select>
        <label className="checkLabel">
          <input type="checkbox" checked={includeDeleted} onChange={(e) => setIncludeDeleted(e.target.checked)} />
          Include deleted
        </label>
        <select className="pageSize" value={pageSize} onChange={(e) => { setPage(1); setPageSize(Number(e.target.value)); }}>
          {[30, 50, 100, 200].map((size) => <option key={size} value={size}>{size} rows</option>)}
        </select>
        <button type="submit"><RefreshCw size={16} /> Search</button>
      </form>
      {error && <div className="error">{error}</div>}
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Theme Code</th>
              <th>Theme Name</th>
              <th>Source</th>
              <th>Source No</th>
              <th>Stocks</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((theme) => (
              <tr key={theme.themeCode}>
                <td>{theme.themeCode}</td>
                <td><strong>{theme.themeName}</strong></td>
                <td>{theme.source}</td>
                <td>{theme.sourceThemeNo || '-'}</td>
                <td>{formatNumber(theme.stockCount)}</td>
                <td><span className={`badge ${theme.status.toLowerCase()}`}>{theme.status}</span></td>
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={6} className="empty">No themes found.</td></tr>}
          </tbody>
        </table>
      </div>
      <Pager page={page} pageSize={pageSize} totalCount={totalCount} totalPages={totalPages} onPage={setPage} />
    </section>
  );
}

function Pager({ page, pageSize, totalCount, totalPages, onPage }: {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  onPage: (page: number) => void;
}) {
  const from = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalCount);
  return (
    <div className="pager">
      <span className="pageMeta">{from}-{to} / {totalCount}</span>
      <button disabled={page <= 1} onClick={() => onPage(1)}>처음</button>
      <button disabled={page <= 1} onClick={() => onPage(page - 1)}>이전</button>
      <span>{page} / {Math.max(1, totalPages)}</span>
      <button disabled={page >= totalPages} onClick={() => onPage(page + 1)}>다음</button>
      <button disabled={page >= totalPages} onClick={() => onPage(totalPages)}>마지막</button>
    </div>
  );
}

function createApi(baseUrl: string, adminKey: string) {
  const request = async (path: string, options: RequestInit = {}) => {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-api-key': adminKey,
        ...(options.headers || {}),
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${response.status}`);
    }
    return response.json();
  };
  return {
    get: (path: string, params: Record<string, unknown> = {}) => {
      const query = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
      });
      return request(`${path}${query.toString() ? `?${query}` : ''}`);
    },
    post: (path: string, body: unknown) => request(path, { method: 'POST', body: JSON.stringify(body) }),
    patch: (path: string, body: unknown) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
  };
}

function useStoredState(key: string, initial: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) || initial);
  useEffect(() => localStorage.setItem(key, value), [key, value]);
  return [value, setValue] as const;
}

function getMessage(err: unknown) {
  return err instanceof Error ? err.message : '요청에 실패했습니다.';
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value);
}

function formatBig(value: string | null) {
  if (!value) return '-';
  return `${(Number(value) / 100000000).toFixed(1)}억`;
}

function formatRate(value: number | null) {
  if (value === null || Number.isNaN(value)) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function formatRsRaw(value: number | null) {
  if (value === null || Number.isNaN(value)) return '-';
  return value.toFixed(4);
}

function formatUptrend(value: boolean | null) {
  if (value === null) return '-';
  return <span className={`badge ${value ? 'active' : 'deleted'}`}>{value ? 'UP' : 'NO'}</span>;
}

createRoot(document.getElementById('root')!).render(<App />);
