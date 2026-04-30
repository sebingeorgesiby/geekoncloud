# GeekOnCloud Daily Post Agent

Automatically generates and publishes a new DevOps blog post every day using Claude AI.

## How it works

1. Picks a topic from a 40+ topic rotation list (never repeats until all used)
2. Calls Claude API to write a full ~1200 word technical post with code examples
3. Generates SEO metadata (title, excerpt, tags, slug)
4. Saves the post as a Markdown file in `/posts/`
5. Commits and pushes to GitHub
6. Vercel detects the push and redeploys the site automatically

## Files

| File | Purpose |
|------|---------|
| `daily-post.js` | Main agent script |
| `run-daily.bat` | Windows batch wrapper (called by Task Scheduler) |
| `setup-scheduler.ps1` | One-time PowerShell script to install the scheduled task |
| `agent.log` | Log of every run (auto-created) |
| `used-topics.json` | Tracks which topics have been used (auto-created) |

## Manual run

```cmd
# From your project root:
node agent\daily-post.js

# With a custom topic:
node agent\daily-post.js "How to set up Prometheus alerting for Kubernetes"
```

## Automatic daily run (Windows Task Scheduler)

Run once in PowerShell as Administrator:

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\agent\setup-scheduler.ps1
```

This creates a task called "GeekOnCloud Daily Post" that runs every day at 8:00 AM.
Edit `setup-scheduler.ps1` to change the time.

## Customising topics

Edit the `TOPIC_POOL` array in `daily-post.js` to add your own topics.
Topics are picked randomly without repetition until all are used, then the cycle resets.

## Logs

Check `agent/agent.log` to see what ran and when.
