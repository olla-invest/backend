import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 브라우저는 같은 출처의 /api 만 호출하고, 개발·미리보기 서버가 백엔드로 넘긴다 (CORS 설정 불필요).
// 기본값은 개발 API. 서버에서 띄울 때는 BACKOFFICE_API_TARGET=http://localhost:3001 로 지정한다.
const apiTarget = process.env.BACKOFFICE_API_TARGET || 'https://api-dev.ollainvest.com';
const proxy = {
  '/api': {
    target: apiTarget,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api/, ''),
  },
};

export default defineConfig({
  plugins: [react()],
  server: { port: 5175, allowedHosts: true, proxy },
  preview: { port: 4175, allowedHosts: true, proxy },
});
