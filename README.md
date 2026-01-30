# Ralph Dashboard

An iPhone-friendly web dashboard for orchestrating the "Ralph Wiggum" autonomous coding loop architecture.

Based on [snarktank/ralph](https://github.com/snarktank/ralph) - an autonomous AI agent loop that runs AI coding tools repeatedly until all PRD items are complete.

## What is Ralph?

Ralph implements an **autonomous AI agent loop** where each iteration is a fresh instance with clean context. Memory persists via:
- **Git commit history** from completed work
- **`progress.txt`** capturing learnings
- **`prd.json`** tracking task completion status

The "Ralph Wiggum" technique solves context rot by resetting the AI's context each iteration, keeping costs under **$20/month** while handling 100+ features.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment configuration
cp .env.example .env
# Edit .env with your API keys

# Start the dashboard
npm start
```

Access the dashboard at `http://localhost:3000`

### From iPhone

1. Find your computer's IP: `hostname -I` or `ifconfig`
2. Open Safari on iPhone: `http://<your-ip>:3000`
3. Add to Home Screen for app-like experience

## Features

- **Mobile-first design** optimized for iPhone
- **Real-time logs** via WebSocket
- **Budget tracking** with $20/month limit
- **Repository management** - clone and manage multiple repos
- **Job control** - start, monitor, and stop Ralph loops

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    iPhone Browser                        │
│                  (Web Dashboard)                         │
└─────────────────────┬───────────────────────────────────┘
                      │ WebSocket + REST API
┌─────────────────────▼───────────────────────────────────┐
│                    server.js                             │
│              (Express + WebSocket)                       │
└──────────┬──────────────────────────────┬───────────────┘
           │                              │
┌──────────▼──────────┐      ┌───────────▼───────────────┐
│    manager.sh       │      │       ralph.sh            │
│  (Claude Opus)      │      │  (Haiku/GPT-4o-mini)      │
│                     │      │                           │
│  Creates PROMPT.md  │      │  while not DONE:          │
│  with task specs    │      │    read PROMPT.md         │
│                     │      │    execute + test         │
│  Cost: ~$0.15/task  │      │    commit to git          │
│                     │      │                           │
└─────────────────────┘      │  Cost: ~$0.0025/loop      │
                              └───────────────────────────┘
```

## Cost Model

| Component | Cost per Unit | Monthly Capacity |
|-----------|--------------|------------------|
| Manager (Opus) | ~$0.15/plan | ~50 plans |
| Intern (Haiku) | ~$0.0025/iteration | ~4000 iterations |
| **Total Budget** | **$20/month** | **~100 features** |

## Usage

### 1. Clone a Repository

Enter a GitHub URL in the dashboard to clone a repository into the workspace.

### 2. Create PRD (Manager)

Describe your feature: "Add a dark mode toggle to settings"

The Manager (Opus) analyzes your codebase and creates a `prd.json` with right-sized user stories.

### 3. Run Ralph Loop

Click "Run Ralph Loop" to start execution. Ralph iterates through stories until:
- All stories pass and it outputs `<promise>COMPLETE</promise>`
- Maximum iterations (10 default) reached
- You manually stop the job

Each iteration:
1. Selects highest-priority incomplete story
2. Implements the story
3. Runs quality checks (typecheck, tests)
4. Commits if passing
5. Updates `prd.json` to mark story complete
6. Appends learnings to `progress.txt`

### 4. Monitor Progress

- **Repos tab**: See story completion progress
- **Jobs tab**: Active/completed jobs with costs
- **Logs tab**: Real-time execution logs

## Key Concepts

### Right-Sized Stories

Stories must fit within ONE context window. The Manager breaks features into small, specific tasks.

**Good stories:**
- "Create dashboard layout component"
- "Add navigation sidebar"
- "Implement user profile section"

**Bad stories (too large):**
- "Build the entire dashboard"
- "Implement authentication system"

### Fresh Context Per Iteration

Each Ralph loop iteration spawns a fresh AI instance. No context rot. Memory persists only through:
- Git commits
- `progress.txt` learnings
- `prd.json` task status

## Configuration

### Environment Variables

```bash
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Optional
PORT=3000                    # Server port
REPOS_DIR=./repos            # Repository storage
MANAGER_MODEL=claude-3-opus-20240229
INTERN_MODEL=claude-3-haiku-20240307
```

### Model Router (Optional)

For GPT-4o-mini as the Intern (even cheaper), configure a router:

```bash
ANTHROPIC_BASE_URL=http://localhost:3001
```

## Security Notes

- API keys are stored in `.env` (gitignored)
- Repos are cloned locally, not exposed
- Consider running in Docker for sandboxing
- Use fine-grained GitHub PATs for private repos

## Deployment Options

### Local (Mac Mini / Linux)

```bash
# Use tmux/screen for persistence
tmux new -s ralph
npm start
# Ctrl+B, D to detach
```

### Cloud (Railway/Render)

Deploy as a Docker container. Add volume for `/repos` persistence.

## License

MIT
