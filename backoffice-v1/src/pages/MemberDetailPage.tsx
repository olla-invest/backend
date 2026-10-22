import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ChevronLeft } from 'lucide-react';
import { errorMessage, type MemberDetail, type UnmaskedProfile } from '../api';
import { useAuth } from '../auth';
import { StatusBadge } from '../components/Badges';
import { useToast } from '../components/Toast';
import { canOperate, formatDate, formatDateTime, PLAN_LABELS, PROVIDER_LABELS } from '../format';
import { PasswordResetModal } from '../modals/PasswordResetModal';
import { PlanChangeModal } from '../modals/PlanChangeModal';
import { ProfileEditModal } from '../modals/ProfileEditModal';
import { StatusChangeModal } from '../modals/StatusChangeModal';
import { UnmaskModal } from '../modals/UnmaskModal';

type ModalName = 'unmask' | 'unmaskForEdit' | 'plan' | 'status' | 'password' | 'edit';

export function MemberDetailPage({ userId }: { userId: string }) {
  const { api, admin } = useAuth();
  const toast = useToast();
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unmasked, setUnmasked] = useState<UnmaskedProfile | null>(null);
  const [modal, setModal] = useState<ModalName | null>(null);

  const operator = canOperate(admin?.role);
  const deleted = detail?.status === 'DELETED';

  const load = useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.get<MemberDetail>(`/admin/users/${userId}`));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [api, userId]);

  useEffect(() => {
    setDetail(null);
    setUnmasked(null);
    load();
  }, [load]);

  // 조치가 끝나면 이력·감사 로그가 바뀌므로 다시 불러온다. 원문 표시는 다시 마스킹한다.
  const finishAction = (message: string) => {
    setModal(null);
    setUnmasked(null);
    toast(message);
    load();
  };

  if (error && !detail) {
    return (
      <div className="page">
        <BackLink />
        <div className="empty-state is-error">
          {error}
          <button type="button" className="link-button" onClick={load}>
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page">
        <BackLink />
        <div className="empty-state">불러오는 중…</div>
      </div>
    );
  }

  const info = detail.basicInfo;
  const disabledReason = !operator ? '조회 전용 계정은 사용할 수 없습니다.' : deleted ? '삭제된 계정입니다.' : undefined;
  const passwordDisabledReason =
    disabledReason ?? (info.provider !== 'LOCAL' ? '소셜 로그인 계정은 비밀번호를 초기화할 수 없습니다.' : undefined);

  return (
    <div className="page">
      <BackLink />
      <h1 className="page-title">회원관리 / 회원상세</h1>

      <header className="detail-header">
        <div className="detail-identity">
          <span className="detail-name">{unmasked?.name ?? detail.name ?? '-'}</span>
          <span className="detail-username">{detail.username}</span>
          <StatusBadge status={detail.status} />
        </div>
        <div className="detail-actions">
          <ActionButton label="플랜 변경" disabledReason={disabledReason} onClick={() => setModal('plan')} />
          <ActionButton label="상태변경" disabledReason={!operator ? disabledReason : undefined} onClick={() => setModal('status')} />
          <ActionButton label="비밀번호 초기화" disabledReason={passwordDisabledReason} onClick={() => setModal('password')} />
          <ActionButton
            label="정보 수정"
            primary
            disabledReason={disabledReason}
            onClick={() => setModal(unmasked ? 'edit' : 'unmaskForEdit')}
          />
        </div>
      </header>

      <div className="detail-grid">
        <div className="detail-column">
          <Card
            title="기본정보"
            action={
              unmasked ? (
                <button type="button" className="button button-small button-white" onClick={() => setUnmasked(null)}>
                  다시 마스킹
                </button>
              ) : (
                <button
                  type="button"
                  className="button button-small button-white"
                  disabled={!operator}
                  title={!operator ? '조회 전용 계정은 마스킹을 해제할 수 없습니다.' : undefined}
                  onClick={() => setModal('unmask')}
                >
                  마스킹 해제
                </button>
              )
            }
          >
            <dl className="info-list">
              <InfoRow label="이메일" value={unmasked ? unmasked.email : info.email} />
              <InfoRow label="전화번호" value={unmasked ? unmasked.phone : info.phone} />
              <InfoRow label="가입경로" value={PROVIDER_LABELS[info.provider] ?? info.provider} />
              <InfoRow label="가입일" value={formatDateTime(info.createdAt)} />
              <InfoRow label="최근 접속일" value={formatDateTime(info.lastLoginAt)} />
              <InfoRow
                label="마케팅 수신"
                value={info.marketingConsent ? `동의 · ${formatDateTime(info.marketingConsentAt)}` : '미동의'}
              />
            </dl>
          </Card>

          <Card title="활동 요약" subtitle={`최근 ${detail.activitySummary.windowDays}일`}>
            <div className="stat-grid">
              <Stat label="접속일수" value={detail.activitySummary.visitedDays} />
              <Stat label="필터적용" value={detail.activitySummary.filterApplied} pendingNote="행동 이벤트 수집 후 제공" />
              <Stat label="저장한 필터" value={detail.activitySummary.savedFilters} />
              <Stat label="관심 종목" value={detail.activitySummary.watchlistCount} />
            </div>
          </Card>

          <Card title="플랜 이력">
            {detail.planHistories.length === 0 ? (
              <div className="plan-history-item">
                <strong>{PLAN_LABELS[detail.planType]}</strong>
                <div className="plan-history-row">
                  <span className="muted">변경 이력 없음</span>
                </div>
              </div>
            ) : (
              detail.planHistories.map((history) => (
                <div key={history.historyId} className="plan-history-item">
                  <strong>
                    {history.fromPlan && history.fromPlan !== history.toPlan
                      ? `${PLAN_LABELS[history.fromPlan]} → ${PLAN_LABELS[history.toPlan]}`
                      : PLAN_LABELS[history.toPlan]}
                  </strong>
                  <div className="plan-history-row">
                    <span className="muted">
                      {history.note ?? history.reason ?? '-'}
                      {history.changedBy ? ` · ${history.changedBy}` : ''}
                    </span>
                    <span className="muted">
                      {formatDate(history.effectiveAt)}
                      {history.expiresAt ? ` ~ ${formatDate(history.expiresAt)}` : ''}
                    </span>
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>

        <div className="detail-column">
          <Card title="로그인 이력" subtitle="최근 5건" subtitleRight>
            <table className="mini-table">
              <thead>
                <tr>
                  <th className="align-left">일시</th>
                  <th>경로</th>
                  <th>IP</th>
                  <th>기기 / OS</th>
                </tr>
              </thead>
              <tbody>
                {detail.loginHistories.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="table-message">
                      로그인 이력이 없습니다.
                    </td>
                  </tr>
                ) : (
                  detail.loginHistories.map((history, index) => (
                    <tr key={`${history.loggedInAt}-${index}`}>
                      <td className="align-left">{formatDateTime(history.loggedInAt)}</td>
                      <td>{history.provider ? PROVIDER_LABELS[history.provider] ?? history.provider : '-'}</td>
                      <td>{history.ipAddress ?? '-'}</td>
                      <td>{history.device ?? '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </Card>

          <Card title="운영 감사 로그">
            {detail.auditLogs.length === 0 ? (
              <p className="muted">기록이 없습니다.</p>
            ) : (
              <ul className="audit-list">
                {detail.auditLogs.map((log) => (
                  <li key={log.logId}>
                    <span className="audit-time">{formatDateTime(log.createdAt)}</span>
                    <span className="audit-admin">{log.adminLoginId}</span>
                    <span className="audit-description">
                      {log.description}
                      {!log.success && <span className="audit-failed"> (실패)</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {(modal === 'unmask' || modal === 'unmaskForEdit') && (
        <UnmaskModal
          api={api}
          userId={userId}
          purpose={modal === 'unmaskForEdit' ? 'edit' : 'view'}
          onClose={() => setModal(null)}
          onUnmasked={(profile) => {
            setUnmasked(profile);
            setModal(modal === 'unmaskForEdit' ? 'edit' : null);
            load();
          }}
        />
      )}
      {modal === 'plan' && <PlanChangeModal api={api} detail={detail} onClose={() => setModal(null)} onDone={finishAction} />}
      {modal === 'status' && (
        <StatusChangeModal
          api={api}
          userIds={[detail.userId]}
          currentStatus={detail.status}
          onClose={() => setModal(null)}
          onDone={finishAction}
        />
      )}
      {modal === 'password' && (
        <PasswordResetModal
          api={api}
          userId={detail.userId}
          maskedEmail={info.email}
          onClose={() => setModal(null)}
          onDone={finishAction}
        />
      )}
      {modal === 'edit' && unmasked && (
        <ProfileEditModal
          api={api}
          userId={detail.userId}
          username={detail.username}
          original={unmasked}
          onClose={() => setModal(null)}
          onDone={finishAction}
        />
      )}
    </div>
  );
}

function BackLink() {
  return (
    <a className="back-link" href="#/members">
      <ChevronLeft size={16} /> 회원 목록
    </a>
  );
}

function ActionButton({
  label,
  primary,
  disabledReason,
  onClick,
}: {
  label: string;
  primary?: boolean;
  disabledReason?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`button${primary ? ' button-primary' : ''}`}
      disabled={Boolean(disabledReason)}
      title={disabledReason}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function Card({
  title,
  subtitle,
  subtitleRight,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  subtitleRight?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-header">
        <h2>
          {title}
          {subtitle && !subtitleRight && <span className="card-subtitle">{subtitle}</span>}
        </h2>
        {subtitle && subtitleRight && <span className="card-subtitle">{subtitle}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd>{value ?? '-'}</dd>
    </div>
  );
}

function Stat({ label, value, pendingNote }: { label: string; value: number | null; pendingNote?: string }) {
  return (
    <div className="stat" title={value === null ? pendingNote : undefined}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value === null ? '-' : value}</strong>
    </div>
  );
}
