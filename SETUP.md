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

Choose **one** of these approaches:

#### Option A: Personal Access Token (Simpler)

| Variable | Type | Description |
|----------|------|-------------|
| `GITHUB_TOKEN` | String | GitHub Personal Access Token (format: `ghp_...`) |

**How to create:**
1. Visit https://github.com/settings/tokens
2. Click "Generate new token (classic)"
3. Select scopes: `repo`, `read:user`
4. Copy the token and paste into Railway

#### Option B: GitHub App Authentication (More Secure)

| Variable | Type | Description |
|----------|------|-------------|
| `GITHUB_APP_ID` | String | Your GitHub App ID (numeric) |
| `GITHUB_APP_INSTALLATION_ID` | String | Installation ID (numeric) |
| `GITHUB_APP_PRIVATE_KEY_PATH` | String | Path to private key file: `/app/github-app-private-key.pem` |

**How to set up GitHub App:**
1. Visit https://github.com/settings/apps
2. Click "New GitHub App"
3. Fill in details:
   - **Homepage URL:** Your Railway public URL
   - **Webhook URL:** `https://<your-railway-url>/webhook`
   - **Permissions:** `contents:read_write`, `pull_requests:read_write`
4. Generate and download the private key
5. In Railway, add the private key as a secret file (see below)

### Optional: OpenAI Integration

| Variable | Type | Description |
|----------|------|-------------|
| `OPENAI_API_KEY` | String | OpenAI API key if using GPT-4o-mini via a router |

## Railway Deployment Steps

### 1. Set Up Environment Variables

In Railway dashboard:

1. Go to your project → Variables
2. Add each variable:
   - For standard variables: Click "Add Variable", enter name and value
   - For multi-line secrets (GitHub App key): Use the "Raw editor" or create as a file

### 2. Add GitHub App Private Key (if using GitHub App auth)

1. In Railway Variables, click "Create Secret File"
2. **File path:** `/app/github-app-private-key.pem`
3. **File content:** Paste the contents of your GitHub App private key
4. Ensure the file has proper line breaks

### 3. Example Configuration

```
ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXXXXXXXXX
GITHUB_TOKEN=ghp_XXXXXXXXXXXXXXXXXXXX
PORT=3000
REPOS_DIR=/tmp/repos
MANAGER_MODEL=claude-3-opus-20240229
INTERN_MODEL=claude-3-haiku-20240307
```

Or with GitHub App:

```
ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXXXXXXXXX
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=789101
GITHUB_APP_PRIVATE_KEY_PATH=/app/github-app-private-key.pem
PORT=3000
REPOS_DIR=/tmp/repos
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
| Cannot clone private repo | Add `GITHUB_TOKEN` or set up GitHub App |
| Permission denied writing to repos | Change `REPOS_DIR` to `/tmp/repos` |
| GitHub operations fail | Verify token has `repo` scope or GitHub App has correct permissions |

## Cost Tracking

The application includes built-in cost tracking:
- **Manager (Opus):** ~$0.15 per plan
- **Ralph (Haiku):** ~$0.0025 per iteration
- **Monthly estimate:** ~$20 for 50 plans + 5,000 iterations

Monitor via the `/api/costs` endpoint in the dashboard.
