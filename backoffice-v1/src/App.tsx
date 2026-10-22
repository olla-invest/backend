import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { LoginPage } from './pages/LoginPage';
import { MemberDetailPage } from './pages/MemberDetailPage';
import { MembersPage } from './pages/MembersPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { useRoute, type Route } from './router';

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Screens />
      </AuthProvider>
    </ToastProvider>
  );
}

function Screens() {
  const { status } = useAuth();
  const route = useRoute();

  if (status === 'loading') return <div className="boot">불러오는 중…</div>;
  if (status === 'anonymous') return <LoginPage />;

  return (
    <Layout route={route}>
      <Page route={route} />
    </Layout>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case 'memberDetail':
      return <MemberDetailPage key={route.userId} userId={route.userId} />;
    case 'dashboard':
      return (
        <PlaceholderPage
          title="서비스 현황"
          description="서비스 현황 지표는 데이터 수집이 준비되면 제공됩니다."
          items={[
            'GA 연동: 신규 사용자, 랜딩 → 가입 전환율, 평균 참여 시간, 이용 환경(기기·OS·해상도)',
            '회원 데이터로 바로 계산 가능: 가입 완료, 가입경로 1위',
            '행동 이벤트 로그 수집 필요: 핵심 기능 도달, 기능별 사용률, 탐색 깊이, 재방문(D7·D30, WAU·DAU·MAU)',
          ]}
        />
      );
    case 'service':
      return <PlaceholderPage title="서비스 관리" description="서비스 관리 메뉴는 후속 기획 후 제공됩니다." />;
    default:
      return <MembersPage />;
  }
}
