import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, CalendarRange, ChevronDown, Search } from 'lucide-react';
import { errorMessage, type MemberListResponse, type Query } from '../api';
import { useAuth } from '../auth';
import { StatusBadge } from '../components/Badges';
import { Pagination } from '../components/Pagination';
import { useToast } from '../components/Toast';
import {
  canOperate,
  formatDateTime,
  formatNumber,
  PLAN_LABELS,
  PLAN_OPTIONS,
  PROVIDER_LABELS,
  PROVIDER_OPTIONS,
  STATUS_FILTER_OPTIONS,
  STATUS_LABELS,
  todayKst,
} from '../format';
import { StatusChangeModal } from '../modals/StatusChangeModal';
import { navigate } from '../router';

interface Filters {
  joinedFrom: string;
  joinedTo: string;
  provider: string;
  planType: string;
  status: string;
  search: string;
  includeDeleted: boolean;
}

interface ListState {
  filters: Filters;
  page: number;
  pageSize: number;
  sortOrder: 'asc' | 'desc';
}

const PAGE_SIZES = [10, 20, 50, 100];
const STATE_KEY = 'olla.backoffice.members';
const INITIAL_STATE: ListState = {
  filters: { joinedFrom: '', joinedTo: '', provider: '', planType: '', status: '', search: '', includeDeleted: false },
  page: 1,
  pageSize: 10,
  sortOrder: 'desc',
};

// 상세에 다녀와도 조건·페이지가 유지되도록 탭 단위로 기억한다 (검색어가 URL 에 남지 않게 sessionStorage 사용).
function loadState(): ListState {
  try {
    const saved = sessionStorage.getItem(STATE_KEY);
    return saved ? { ...INITIAL_STATE, ...JSON.parse(saved) } : INITIAL_STATE;
  } catch {
    return INITIAL_STATE;
  }
}

function toQuery(state: ListState): Query {
  const { filters } = state;
  return {
    joinedFrom: filters.joinedFrom,
    joinedTo: filters.joinedTo,
    provider: filters.provider,
    planType: filters.planType,
    status: filters.status,
    search: filters.search.trim(),
    // 삭제 상태로 거르면 삭제 계정을 포함해야 결과가 나온다.
    includeDeleted: filters.includeDeleted || filters.status === 'DELETED',
    sortBy: 'createdAt',
    sortOrder: state.sortOrder,
  };
}

export function MembersPage() {
  const { api, admin } = useAuth();
  const toast = useToast();
  const [state, setState] = useState<ListState>(loadState);
  const [searchInput, setSearchInput] = useState(state.filters.search);
  const [data, setData] = useState<MemberListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const showDeletedAt = state.filters.includeDeleted || state.filters.status === 'DELETED';
  const operator = canOperate(admin?.role);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.get<MemberListResponse>('/admin/users', {
        ...toQuery(state),
        page: state.page,
        pageSize: state.pageSize,
      });
      setData(result);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [api, state]);

  useEffect(() => {
    try {
      sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      /* 저장하지 못해도 조회에는 영향이 없다. */
    }
    load();
  }, [state, load]);

  const updateFilters = (patch: Partial<Filters>) => {
    setSelected(new Set());
    setState((current) => ({ ...current, filters: { ...current.filters, ...patch }, page: 1 }));
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    updateFilters({ search: searchInput });
  };

  const rows = data?.users ?? [];
  const allOnPageSelected = rows.length > 0 && rows.every((row) => selected.has(row.userId));

  const toggleAllOnPage = () => {
    setSelected((current) => {
      const next = new Set(current);
      if (allOnPageSelected) rows.forEach((row) => next.delete(row.userId));
      else rows.forEach((row) => next.add(row.userId));
      return next;
    });
  };

  const toggleRow = (userId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  // 선택한 회원이 있으면 그 회원만, 없으면 현재 조건의 전체 결과를 내려받는다.
  const downloadCsv = async () => {
    setDownloading(true);
    try {
      const rowCount = await api.download(
        '/admin/users/export',
        { ...toQuery(state), userIds: selected.size > 0 ? [...selected] : undefined },
        `olla-members-${todayKst()}.csv`,
      );
      toast(`CSV ${rowCount === null ? '' : `${formatNumber(rowCount)}건 `}다운로드를 시작했습니다.`);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="page">
      <h1 className="page-title">회원관리</h1>

      <section className="filter-panel">
        <div className="filter-row">
          <div className="filter-box filter-dates">
            <CalendarRange size={16} className="filter-icon" />
            <span className="filter-label">가입기간</span>
            <input
              type="date"
              aria-label="가입기간 시작일"
              value={state.filters.joinedFrom}
              max={state.filters.joinedTo || undefined}
              onChange={(event) => updateFilters({ joinedFrom: event.target.value })}
            />
            <span className="filter-tilde">~</span>
            <input
              type="date"
              aria-label="가입기간 종료일"
              value={state.filters.joinedTo}
              min={state.filters.joinedFrom || undefined}
              onChange={(event) => updateFilters({ joinedTo: event.target.value })}
            />
          </div>
          <FilterSelect
            label="가입경로"
            value={state.filters.provider}
            options={PROVIDER_OPTIONS.map((value) => ({ value, label: PROVIDER_LABELS[value] }))}
            onChange={(provider) => updateFilters({ provider })}
          />
          <FilterSelect
            label="플랜"
            value={state.filters.planType}
            options={PLAN_OPTIONS.map((value) => ({ value, label: PLAN_LABELS[value] }))}
            onChange={(planType) => updateFilters({ planType })}
          />
          <FilterSelect
            label="상태"
            value={state.filters.status}
            options={STATUS_FILTER_OPTIONS.map((value) => ({ value, label: STATUS_LABELS[value] }))}
            onChange={(status) => updateFilters({ status })}
          />
        </div>
        <div className="filter-row">
          <form className="search-box" onSubmit={submitSearch}>
            <Search size={18} />
            <input
              value={searchInput}
              placeholder="ID · 이메일 · 이름 · 전화번호로 검색하세요"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </form>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={state.filters.includeDeleted}
              onChange={(event) => updateFilters({ includeDeleted: event.target.checked })}
            />
            삭제 계정 포함
          </label>
          {(state.filters.joinedFrom ||
            state.filters.joinedTo ||
            state.filters.provider ||
            state.filters.planType ||
            state.filters.status ||
            state.filters.search ||
            state.filters.includeDeleted) && (
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setSearchInput('');
                updateFilters(INITIAL_STATE.filters);
              }}
            >
              조건 초기화
            </button>
          )}
        </div>
      </section>

      <div className="table-toolbar">
        <span className="selection-count">{selected.size > 0 ? `${formatNumber(selected.size)}명 선택` : ''}</span>
        <button
          type="button"
          className="button button-small"
          disabled={selected.size === 0 || !operator}
          title={!operator ? '조회 전용 계정은 상태를 변경할 수 없습니다.' : undefined}
          onClick={() => setBulkOpen(true)}
        >
          일괄 상태변경
        </button>
        <button type="button" className="button button-small" disabled={downloading} onClick={downloadCsv}>
          {downloading ? '내려받는 중…' : 'CSV 다운로드'}
        </button>
        <div className="select-wrap select-small">
          <select
            aria-label="페이지 크기"
            value={state.pageSize}
            onChange={(event) => setState((current) => ({ ...current, pageSize: Number(event.target.value), page: 1 }))}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
      </div>

      <div className="table-card">
        <table className="data-table">
          <thead>
            <tr>
              <th className="col-check">
                <input type="checkbox" aria-label="현재 페이지 전체 선택" checked={allOnPageSelected} onChange={toggleAllOnPage} />
              </th>
              <th className="align-left">ID</th>
              <th>이메일</th>
              <th>이름</th>
              <th>전화번호</th>
              <th>가입경로</th>
              <th>플랜</th>
              <th>상태</th>
              <th>
                <button
                  type="button"
                  className="sort-button"
                  onClick={() =>
                    setState((current) => ({ ...current, sortOrder: current.sortOrder === 'desc' ? 'asc' : 'desc', page: 1 }))
                  }
                >
                  가입일 {state.sortOrder === 'desc' ? <ArrowDown size={14} /> : <ArrowUp size={14} />}
                </button>
              </th>
              {showDeletedAt && <th>탈퇴일</th>}
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr>
                <td colSpan={showDeletedAt ? 10 : 9} className="table-message is-error">
                  {error}
                  <button type="button" className="link-button" onClick={load}>
                    다시 시도
                  </button>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={showDeletedAt ? 10 : 9} className="table-message">
                  {loading ? '불러오는 중…' : '조건에 맞는 회원이 없습니다.'}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.userId} className="clickable" onClick={() => navigate(`/members/${row.userId}`)}>
                  <td className="col-check" onClick={(event) => event.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`${row.username} 선택`}
                      checked={selected.has(row.userId)}
                      onChange={() => toggleRow(row.userId)}
                    />
                  </td>
                  <td className="align-left strong">{row.username}</td>
                  <td>{row.email ?? '-'}</td>
                  <td>{row.name ?? '-'}</td>
                  <td>{row.phone ?? '-'}</td>
                  <td>{PROVIDER_LABELS[row.provider] ?? row.provider}</td>
                  <td>{PLAN_LABELS[row.planType] ?? row.planType}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="muted small">{formatDateTime(row.createdAt)}</td>
                  {showDeletedAt && <td className="muted small">{formatDateTime(row.deletedAt)}</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
        {loading && rows.length > 0 && <div className="table-loading" aria-hidden="true" />}
      </div>

      <div className="table-footer">
        <span>전체 {formatNumber(data?.totalCount ?? 0)} 건</span>
        {data && data.totalPages > 1 && (
          <Pagination page={state.page} totalPages={data.totalPages} onChange={(page) => setState((current) => ({ ...current, page }))} />
        )}
      </div>

      {bulkOpen && (
        <StatusChangeModal
          api={api}
          userIds={[...selected]}
          onClose={() => setBulkOpen(false)}
          onDone={(message) => {
            setBulkOpen(false);
            setSelected(new Set());
            toast(message);
            load();
          }}
        />
      )}
    </div>
  );
}

interface FilterSelectProps {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}

function FilterSelect({ label, value, options, onChange }: FilterSelectProps) {
  return (
    <label className="filter-box filter-select">
      <span className="filter-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">전체</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown size={16} className="filter-chevron" />
    </label>
  );
}
