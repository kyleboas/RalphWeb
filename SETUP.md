# Ralph Dashboard - Railway Setup Guide

This guide explains how to configure the Ralph Dashboard for deployment on Railway.

## Project Overview

Ralph Dashboard is an iPhone-friendly web dashboard that orchestrates an autonomous AI coding loop. It uses Claude Opus for planning and Claude Haiku for iterative task execution, designed to keep costs under $20/month.

## Required Environment Variables

These variables **must** be set in Railway for the application to function:

### `ANTHROPIC_API_KEY`
- **Type:** String
- **Format:** `sk-ant-...`
- **Description:** Your Anthropic API key for Claude models (Manager and Ralph)
- **How to get it:** Visit https://console.anthropic.com/api_keys

## Optional Environment Variables

Configure these based on your needs:

### Server Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PORT` | Number | `3000` | Port for the Express server (Railway assigns this automatically, use if needed) |
| `REPOS_DIR` | String | `./repos` | Directory where repositories are cloned (use `/tmp/repos` on Railway) |

### Model Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `MANAGER_MODEL` | String | `claude-3-opus-20240229` | Claude model for planning phase |
| `INTERN_MODEL` | String | `claude-3-haiku-20240307` | Claude model for task execution |
| `ANTHROPIC_BASE_URL` | String | — | Optional router URL for cost optimization |

### GitHub Authentication

| Variable | Type | Description |
|----------|------|-------------|
| `GITHUB_TOKEN` | String | GitHub Personal Access Token (format: `ghp_...`) |

**How to create:**
1. Visit https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scopes: `repo` (Full control of private repositories)
4. Copy the token and paste into Railway

**Note:** This token is used for cloning private repositories, committing changes, and pushing to remotes.

### Optional: OpenAI Integration

| Variable | Type | Description |
|----------|------|-------------|
| `OPENAI_API_KEY` | String | OpenAI API key if using GPT-4o-mini via a router |

## Railway Deployment Steps

### 1. Set Up Environment Variables

In Railway dashboard:

1. Go to your project → Variables
2. Add each variable by clicking "Add Variable" and entering the name and value

### 2. Example Configuration

```
ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXXXXXXXXX
GITHUB_TOKEN=ghp_XXXXXXXXXXXXXXXXXXXX
PORT=3000
REPOS_DIR=/tmp/repos
MANAGER_MODEL=claude-3-opus-20240229
INTERN_MODEL=claude-3-haiku-20240307
```

## Important Notes

- **GitHub authentication is optional** — Only required if working with private repositories
- **Use `/tmp/repos` on Railway** — The `/app` directory is read-only in Railway
- **Keep `REPOS_DIR` writeable** — Railway's `/tmp` persists within a deployment, use for temporary data
- **Monitor costs** — The dashboard tracks API usage; set spending limits in Anthropic console

## Verification

After deployment, verify everything works:

1. Access your Railway app URL
2. The dashboard should load on any device
3. Try creating a new feature/loop to test API connectivity
4. Check Railway logs for any errors related to missing variables

## Troubleshooting

| Error | Solution |
|-------|----------|
| "ANTHROPIC_API_KEY not found" | Add `ANTHROPIC_API_KEY` to Railway variables |
| Cannot clone private repo | Add `GITHUB_TOKEN` to Railway variables |
| Permission denied writing to repos | Change `REPOS_DIR` to `/tmp/repos` |
| GitHub operations fail | Verify token has `repo` scope (Full control of private repositories) |

## Cost Tracking

The application includes built-in cost tracking:
- **Manager (Opus):** ~$0.15 per plan
- **Ralph (Haiku):** ~$0.0025 per iteration
- **Monthly estimate:** ~$20 for 50 plans + 5,000 iterations

Monitor via the `/api/costs` endpoint in the dashboard.
