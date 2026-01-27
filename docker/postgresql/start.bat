@echo off
REM PostgreSQL Docker 컨테이너 시작 스크립트 (Windows)

echo Starting Kiwoom PostgreSQL Docker container...
docker-compose -f docker-compose.yml up -d

echo.
echo ✅ PostgreSQL container started successfully!
echo.
echo PostgreSQL Connection Info:
echo   - Host: localhost
echo   - Port: 15432
echo   - Database: investment_db
echo   - User: kiwoom_user
echo   - Password: kiwoom@2026
echo.
echo Connection String:
echo   postgresql://kiwoom_user:kiwoom@2026@localhost:15432/investment_db
echo.
echo Useful commands:
echo   Check status: docker-compose ps
echo   View logs: docker-compose logs -f
echo   Stop container: docker-compose down
echo   Remove data: docker-compose down -v
pause
