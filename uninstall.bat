@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title ワードチェイン アンインストール

echo ============================================
echo   ワードチェイン アンインストール
echo ============================================
echo.
echo このアプリはポータブル版です。インストールはされていません。
echo このスクリプトは「追加辞書・対戦設定などのユーザーデータ」を削除します。
echo （アプリ本体の .exe ファイルは最後にご自身で削除してください）
echo.

set "CONFIRM="
set /p CONFIRM="ユーザーデータを削除しますか? (Y/N): "
if /I not "%CONFIRM%"=="Y" (
  echo 中止しました。
  echo.
  pause
  exit /b 0
)

echo.
echo 実行中のアプリを終了しています...
taskkill /IM "ワードチェイン.exe" /F >nul 2>&1

rem --- ユーザーデータ (追加辞書・設定) を削除 ---
set "REMOVED=0"
for %%D in ("%APPDATA%\ワードチェイン" "%APPDATA%\word-chain") do (
  if exist "%%~D" (
    echo ユーザーデータを削除しています: %%~D
    rmdir /S /Q "%%~D"
    set "REMOVED=1"
  )
)
if "%REMOVED%"=="0" (
  echo 削除するユーザーデータは見つかりませんでした。
)

echo.
echo 完了しました。
echo.
echo ※ アプリを完全に消すには、WordChain-1.0.0-portable.exe ファイルを
echo    手動で削除してください（このフォルダごと削除でもOKです）。
echo.
pause
exit /b 0
