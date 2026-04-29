# GeekOnCloud — geekoncloud.com

A full-stack Next.js blog for DevOps, Cloud & Infrastructure content, with a built-in Claude-powered admin panel.

## Stack

- **Next.js 14** (Pages Router, SSG + SSR)
- **TypeScript**
- **Tailwind CSS** (IBM Plex Sans + Syne fonts)
- **File-based blog** — posts are plain Markdown files in `/posts`
- **Claude AI** in the admin for drafting, editing, SEO, and outlines
- **No database** — dead simple, deploy anywhere

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
# Edit .env.local:
#   ADMIN_PASSWORD=your-strong-password
#   ANTHROPIC_API_KEY=sk-ant-...

# 3. Run development server
npm run dev
```

Open http://localhost:3000

## Pages

| Route | Description |
|-------|-------------|
| `/` | Homepage with featured + recent posts |
| `/blog` | All posts with search + tag filter |
| `/blog/[slug]` | Individual post |
| `/tags` | All topics |
| `/tags/[tag]` | Posts by tag |
| `/about` | About page |
| `/admin/login` | Admin login |
| `/admin` | Post management dashboard |
| `/admin/new` | Create post (with AI) |
| `/admin/edit/[slug]` | Edit post (with AI) |

## Writing posts

### Via admin panel
Go to `/admin` → **New post** → write in Markdown or use the AI assistant.

### Via filesystem
Create a `.md` file in `/posts/`:

```markdown
---
title: My Post Title
date: 2025-04-29
excerpt: A short description for SEO and listing pages.
tags: ["Kubernetes", "Terraform"]
author: GeekOnCloud
draft: false
---

## Introduction

Your content here in Markdown...
```

## Deployment

### Vercel (recommended — free)
```bash
npm install -g vercel
vercel --prod
```
Set environment variables in Vercel dashboard.

### Netlify
```bash
npm run build
# Upload .next/ or connect repo
```

### Self-hosted VPS
```bash
npm run build
npm start
# Or use PM2:
pm2 start npm --name geekoncloud -- start
```

### Cloudflare Pages
Note: File-based posts require a persistent filesystem. Use Vercel or a VPS for the file-based approach. For Cloudflare Pages, migrate posts to a CMS or database.

## Customisation

- **Branding**: Edit `components/Navbar.tsx` and `components/Footer.tsx`
- **About page**: Edit `pages/about.tsx`
- **Admin password**: Set `ADMIN_PASSWORD` in `.env.local`
- **Analytics**: Add your script to `pages/_app.tsx` or `components/Layout.tsx`
- **Custom domain**: Point DNS to your host and update `next.config.js`

## Security

The admin panel uses a simple cookie-based auth. For production:
1. Change `ADMIN_PASSWORD` to something strong
2. Consider adding rate limiting to `/api/admin/login`
3. Optionally add IP allowlisting at the reverse proxy level (nginx/Cloudflare)
