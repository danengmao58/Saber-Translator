@echo off
chcp 65001 >nul
title Saber Translator

echo ========================================
echo    Saber Translator - Windows 启动
echo ========================================
echo.

cd /d "%~dp0"

echo [1/1] 启动 Saber Translator 后端服务...
echo ^(首次启动会自动下载 MangaOCR 模型，可能需要几分钟^)
echo.

:: PYTHONIOENCODING=utf-8 解决 Windows cmd GBK 编码崩溃问题
start "Saber Translator" /B .venv\Scripts\python.exe -X utf8 app.py

echo 等待启动...
timeout /t 10 /nobreak >nul
echo.

:: 验证启动
curl -s http://127.0.0.1:5000/api/get_settings >nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ Saber Translator 已启动 ^(http://127.0.0.1:5000^)
    start "" "http://127.0.0.1:5000"
) else (
    echo ! 正在启动中，请稍后访问 http://127.0.0.1:5000
)

echo.
echo Chrome 扩展后端地址需设为：http://127.0.0.1:5000
echo.
pause
