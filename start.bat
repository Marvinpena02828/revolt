@echo off
if exist "node_modules" (
    echo The node_modules directory exists. Running test.js...
    node puppeteer_revolt.js
    pause
) else (
    echo The node_modules directory does not exist. Running npm install...
    npm install
    node puppeteer_revolt.js
    pause
)