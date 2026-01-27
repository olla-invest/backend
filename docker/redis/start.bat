@echo off
REM Redis Docker 컨테이너 시작 스크립트 (Windows)

echo Starting Kiwoom Redis Docker container...
docker-compose -f docker-compose.yml up -d

echo.
echo ✅ Redis container started successfully!
echo.
echo Redis Connection Info:
echo   - Host: localhost
echo   - Port: 6379
echo   - Password: kiwoom@redis2026
echo.
echo Redis Insight (Web UI):
echo   - URL: http://localhost:8001
echo.
echo Connection String:
echo   redis://:kiwoom@redis2026@localhost:6379
echo.
echo Useful commands:
echo   Check status: docker-compose ps
echo   View logs: docker-compose logs -f
echo   Stop container: docker-compose down
echo   Remove data: docker-compose down -v
echo.
echo Redis CLI:
echo   docker exec -it kiwoom-redis redis-cli -a kiwoom@redis2026
pause
