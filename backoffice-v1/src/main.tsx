import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// StrictMode 는 개발 중 effect 를 두 번 실행해 '회원 상세 조회' 감사 로그가 중복 기록되므로 쓰지 않는다.
createRoot(document.getElementById('root')!).render(<App />);
