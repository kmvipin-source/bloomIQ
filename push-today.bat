@echo off
REM One-shot commit + push for today's B2B billing + expiry work.
REM A Windows-side process (likely VS Code's git integration or
REM GitHub Desktop) was holding .git/index.lock open from inside the
REM sandbox, so commit had to be deferred to this script.
REM
REM Run from a normal cmd / Powershell window:
REM     cd C:\Users\kmvip\bloomiq
REM     push-today.bat
REM
REM If "another git process is running" still fires:
REM 1. Close VS Code's source-control panel and GitHub Desktop.
REM 2. Run: del .git\index.lock
REM 3. Re-run this script.

cd /d C:\Users\kmvip\bloomiq

if exist .git\index.lock (
  echo Removing stale .git\index.lock ...
  del .git\index.lock
)

echo.
echo === Committing ===
git commit -F COMMIT_MSG_TODAY.txt
if errorlevel 1 (
  echo.
  echo Commit failed. See output above.
  exit /b 1
)

echo.
echo === Pushing to origin/main ===
git push origin main
if errorlevel 1 (
  echo.
  echo Push failed. Check your network or auth and re-run: git push origin main
  exit /b 1
)

echo.
echo === Done ===
echo Today's changes are now on GitHub.
echo You can delete COMMIT_MSG_TODAY.txt and push-today.bat afterwards.
