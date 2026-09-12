@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

:: Define ANSI Escape Sequences
for /f "tokens=1-2 delims=#" %%a in ('"prompt #$H#$E# & echo on & for %%b in (1) do rem"') do set "ESC=%%b"

set "C_RESET=%ESC%[0m"
set "C_BOLD=%ESC%[1m"
set "C_CYAN=%ESC%[38;2;94;231;182m"
set "C_GREEN=%ESC%[38;2;86;219;167m"
set "C_BLUE=%ESC%[38;2;104;166;244m"
set "C_YELLOW=%ESC%[38;2;247;189;77m"
set "C_DIM=%ESC%[38;2;120;140;135m"
set "C_WHITE=%ESC%[38;2;240;248;245m"

title Env Doctor - Local Engine

cls
echo.
echo %C_CYAN%  ┌────────────────────────────────────────────────────────┐%C_RESET%
echo %C_CYAN%  │                                                        │%C_RESET%
echo %C_CYAN%  │%C_RESET%   %C_BOLD%%C_GREEN%✦  E N V   D O C T O R   U I%C_RESET%                 %C_CYAN%│%C_RESET%
echo %C_CYAN%  │%C_RESET%      %C_DIM%Automated Environment Health & Verified Repair%C_RESET% %C_CYAN%│%C_RESET%
echo %C_CYAN%  │                                                        │%C_RESET%
echo %C_CYAN%  └────────────────────────────────────────────────────────┘%C_RESET%
echo.

:: Step 1: Dependencies
if not exist node_modules (
  echo %C_YELLOW%  ◌ %C_WHITE%Installing node_modules dependencies...%C_RESET%
  call npm install >nul 2>&1
  if !errorlevel! neq 0 (
    echo %C_YELLOW%    Retrying npm install with stdout...%C_RESET%
    call npm install
  )
  echo %C_GREEN%  ✓ %C_WHITE%Dependencies installed successfully%C_RESET%
) else (
  echo %C_GREEN%  ✓ %C_WHITE%Dependencies verified%C_RESET%
)

:: Step 2: Build
if not exist dist (
  echo %C_BLUE%  ◌ %C_WHITE%Compiling TypeScript build artifacts...%C_RESET%
  call npm run build >nul 2>&1
  echo %C_GREEN%  ✓ %C_WHITE%Build complete%C_RESET%
) else (
  echo %C_GREEN%  ✓ %C_WHITE%Build artifacts ready%C_RESET%
)

echo.
echo %C_CYAN%  ────────────────────────────────────────────────────────%C_RESET%
echo %C_GREEN%  ✦ %C_BOLD%%C_WHITE%Launching Env Doctor engine...%C_RESET%
echo %C_BLUE%  ⌁ %C_WHITE%Dashboard URL: %C_BOLD%%C_CYAN%http://localhost:4200%C_RESET%
echo %C_DIM%    Opening browser and starting server session...%C_RESET%
echo %C_CYAN%  ────────────────────────────────────────────────────────%C_RESET%
echo.

call npm start
