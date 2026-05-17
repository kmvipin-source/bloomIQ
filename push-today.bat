@echo off
setlocal
REM Holistic GitHub sync: pull -> stage EVERYTHING -> commit -> push.
REM Stages every uncommitted change in the repo, respecting .gitignore.
REM Run from a normal cmd / Powershell window:
REM     cd C:\Users\kmvip\bloomiq
REM     .\push-today.bat

cd /d C:\Users\kmvip\bloomiq

if exist .git\index.lock (
  echo Removing stale .git\index.lock ...
  del .git\index.lock
)

echo.
echo === Pre-flight: what's local-only ===
git status --short
echo.
echo --- Branches with commits ahead of origin/main ---
for /f "tokens=*" %%b in ('git for-each-ref --format="%%(refname:short)" refs/heads') do (
  for /f %%c in ('git rev-list --count origin/main..%%b 2^>nul') do (
    if not "%%c"=="0" echo   %%b: %%c ahead
  )
)
echo.

echo === Pulling latest from origin/main ===
git pull --no-rebase origin main
if errorlevel 1 goto fail_pull

echo.
echo === Staging EVERYTHING ===
git add -A
if errorlevel 1 goto fail_add

echo.
echo === Files staged ===
git status --short
echo.

echo === Committing ===
git commit -F COMMIT_MSG_TODAY.txt
if errorlevel 1 goto warn_commit

echo.
echo === Pushing main to origin ===
git push origin main
if errorlevel 1 goto fail_push

echo.
echo === Done ===
echo Local main is fully in sync with origin/main on GitHub.
echo You can delete COMMIT_MSG_TODAY.txt and push-today.bat afterwards if you like.
endlocal
exit /b 0

:fail_pull
echo.
echo Pull failed. Resolve conflicts or check network/auth, then re-run.
endlocal
exit /b 1

:fail_add
echo.
echo git add failed. See output above.
endlocal
exit /b 1

:warn_commit
echo.
echo Commit step exited non-zero. Most common cause: "nothing to commit".
echo If so, you're already in sync -- attempting push anyway in case there
echo are local commits not yet on origin.
git push origin main
if errorlevel 1 goto fail_push
echo.
echo === Done ===
echo Local main is fully in sync with origin/main on GitHub.
endlocal
exit /b 0

:fail_push
echo.
echo Push failed. Check your network or auth and re-run: git push origin main
endlocal
exit /b 1
