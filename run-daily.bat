@echo off
REM GeekOnCloud Daily Post Agent
REM This file is run by Windows Task Scheduler every day

REM Change this path to where your project lives
cd /d "C:\Project\geekoncloud\project1\geekoncloud"

REM Run the agent
node agent\daily-post.js

REM Log completion time
echo [%date% %time%] Agent run complete >> agent\scheduler.log
