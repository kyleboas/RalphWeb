const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

require('dotenv').config();

// Configure git authentication using personal access token
function getGitHubToken() {
  return process.env.GITHUB_TOKEN || null;
}

// Helper: Make GitHub API request
function githubApiRequest(endpoint, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'RalphDashboard/1.0',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Failed to parse GitHub response'));
          }
        } else {
          reject(new Error(`GitHub API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const REPOS_DIR = process.env.REPOS_DIR || path.join(__dirname, 'repos');
const LOGS_DIR = path.join(__dirname, 'logs');

// Ensure directories exist
[REPOS_DIR, LOGS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Track active jobs
const activeJobs = new Map();
let jobIdCounter = 1;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Broadcast to all WebSocket clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// API: List repositories
app.get('/api/repos', (req, res) => {
  try {
    if (!fs.existsSync(REPOS_DIR)) {
      return res.json([]);
    }
    const repos = fs.readdirSync(REPOS_DIR)
      .filter(f => fs.statSync(path.join(REPOS_DIR, f)).isDirectory())
      .map(name => {
        const repoPath = path.join(REPOS_DIR, name);
        const hasPrd = fs.existsSync(path.join(repoPath, 'prd.json'));
        let prd = null;
        if (hasPrd) {
          try {
            prd = JSON.parse(fs.readFileSync(path.join(repoPath, 'prd.json'), 'utf8'));
          } catch (e) { /* ignore parse errors */ }
        }
        return { name, path: repoPath, hasPrd, prd };
      });
    res.json(repos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get PRD for a repository
app.get('/api/repos/:name/prd', (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);
  const prdPath = path.join(repoPath, 'prd.json');

  if (!fs.existsSync(prdPath)) {
    return res.status(404).json({ error: 'No prd.json found' });
  }

  try {
    const prd = JSON.parse(fs.readFileSync(prdPath, 'utf8'));
    res.json(prd);
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse prd.json' });
  }
});

// API: Save PRD for a repository
app.post('/api/repos/:name/prd', (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);
  const prdPath = path.join(repoPath, 'prd.json');

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    fs.writeFileSync(prdPath, JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save prd.json' });
  }
});

// API: Get active jobs
app.get('/api/jobs', (req, res) => {
  const jobs = Array.from(activeJobs.entries()).map(([id, job]) => ({
    id,
    repo: job.repo,
    type: job.type,
    status: job.status,
    iterations: job.iterations,
    startTime: job.startTime,
    cost: job.cost
  }));
  res.json(jobs);
});

// API: Clone a repository
app.post('/api/repos/clone', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const repoName = url.split('/').pop().replace('.git', '');
  const repoPath = path.join(REPOS_DIR, repoName);

  const proc = spawn('git', ['clone', url, repoPath]);

  proc.on('close', code => {
    if (code === 0) {
      res.json({ success: true, name: repoName, path: repoPath });
    } else {
      res.status(500).json({ error: 'Clone failed' });
    }
  });
});

// API: Start Manager (planning phase)
app.post('/api/manager', (req, res) => {
  const { repo, request } = req.body;
  if (!repo || !request) {
    return res.status(400).json({ error: 'repo and request required' });
  }

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const jobId = jobIdCounter++;
  const job = {
    repo,
    type: 'manager',
    status: 'running',
    iterations: 0,
    startTime: Date.now(),
    cost: 0.15, // Estimated manager cost
    process: null
  };
  activeJobs.set(jobId, job);

  broadcast({ type: 'job_started', jobId, job: { ...job, process: undefined } });

  // Run manager script
  const scriptPath = path.join(__dirname, 'scripts', 'manager.sh');
  const proc = spawn('bash', [scriptPath, repoPath, request], {
    env: { ...process.env }
  });

  job.process = proc;

  proc.stdout.on('data', data => {
    broadcast({ type: 'log', jobId, data: data.toString() });
  });

  proc.stderr.on('data', data => {
    broadcast({ type: 'log', jobId, data: data.toString() });
  });

  proc.on('close', code => {
    job.status = code === 0 ? 'completed' : 'failed';
    broadcast({ type: 'job_completed', jobId, status: job.status });
  });

  res.json({ jobId, message: 'Manager started' });
});

// API: Start Ralph loop (execution phase)
app.post('/api/ralph', (req, res) => {
  const { repo } = req.body;
  if (!repo) {
    return res.status(400).json({ error: 'repo required' });
  }

  const repoPath = path.join(REPOS_DIR, repo);
  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  const prdPath = path.join(repoPath, 'prd.json');
  if (!fs.existsSync(prdPath)) {
    return res.status(400).json({ error: 'No prd.json found. Create a PRD first.' });
  }

  const jobId = jobIdCounter++;
  const job = {
    repo,
    type: 'ralph',
    status: 'running',
    iterations: 0,
    startTime: Date.now(),
    cost: 0,
    process: null
  };
  activeJobs.set(jobId, job);

  broadcast({ type: 'job_started', jobId, job: { ...job, process: undefined } });

  // Run ralph loop script
  const scriptPath = path.join(__dirname, 'scripts', 'ralph.sh');
  const proc = spawn('bash', [scriptPath, repoPath], {
    env: { ...process.env }
  });

  job.process = proc;

  proc.stdout.on('data', data => {
    const text = data.toString();
    broadcast({ type: 'log', jobId, data: text });

    // Track iterations
    const iterMatch = text.match(/Loop Iteration (\d+)/);
    if (iterMatch) {
      job.iterations = parseInt(iterMatch[1]);
      job.cost = job.iterations * 0.00255; // Cost per iteration
      broadcast({ type: 'job_update', jobId, iterations: job.iterations, cost: job.cost });
    }
  });

  proc.stderr.on('data', data => {
    broadcast({ type: 'log', jobId, data: data.toString() });
  });

  proc.on('close', code => {
    job.status = code === 0 ? 'completed' : 'failed';
    broadcast({ type: 'job_completed', jobId, status: job.status, cost: job.cost });
  });

  res.json({ jobId, message: 'Ralph loop started' });
});

// API: Stop a job
app.post('/api/jobs/:id/stop', (req, res) => {
  const jobId = parseInt(req.params.id);
  const job = activeJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.process) {
    job.process.kill('SIGTERM');
    job.status = 'stopped';
    broadcast({ type: 'job_completed', jobId, status: 'stopped' });
  }

  res.json({ success: true });
});

// API: Get cost summary
app.get('/api/costs', (req, res) => {
  let totalCost = 0;
  let managerCalls = 0;
  let ralphIterations = 0;

  activeJobs.forEach(job => {
    totalCost += job.cost;
    if (job.type === 'manager') managerCalls++;
    if (job.type === 'ralph') ralphIterations += job.iterations;
  });

  res.json({
    totalCost: totalCost.toFixed(4),
    managerCalls,
    ralphIterations,
    budgetRemaining: (20 - totalCost).toFixed(2)
  });
});

// Helper: Execute git command in repo
function execGit(repoPath, args) {
  return new Promise((resolve, reject) => {
    exec(`git ${args}`, { cwd: repoPath }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stderr });
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

// API: Get git status for a repository
app.get('/api/repos/:name/git/status', async (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    const [branch, status, remoteUrl, aheadBehind] = await Promise.all([
      execGit(repoPath, 'branch --show-current'),
      execGit(repoPath, 'status --porcelain'),
      execGit(repoPath, 'remote get-url origin').catch(() => ({ stdout: '' })),
      execGit(repoPath, 'rev-list --left-right --count HEAD...@{upstream}').catch(() => ({ stdout: '0\t0' }))
    ]);

    const [ahead, behind] = aheadBehind.stdout.split('\t').map(n => parseInt(n) || 0);
    const changes = status.stdout.split('\n').filter(l => l.trim());

    res.json({
      branch: branch.stdout,
      remoteUrl: remoteUrl.stdout,
      changes: changes.length,
      changedFiles: changes.map(line => ({
        status: line.substring(0, 2).trim(),
        file: line.substring(3)
      })),
      ahead,
      behind,
      clean: changes.length === 0
    });
  } catch (err) {
    res.status(500).json({ error: err.error || err.message });
  }
});

// API: Get branches for a repository
app.get('/api/repos/:name/git/branches', async (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    const [localBranches, currentBranch] = await Promise.all([
      execGit(repoPath, 'branch --format="%(refname:short)"'),
      execGit(repoPath, 'branch --show-current')
    ]);

    const branches = localBranches.stdout.split('\n').filter(b => b.trim());

    res.json({
      current: currentBranch.stdout,
      branches
    });
  } catch (err) {
    res.status(500).json({ error: err.error || err.message });
  }
});

// API: Switch branch
app.post('/api/repos/:name/git/checkout', async (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);
  const { branch, create } = req.body;

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  if (!branch) {
    return res.status(400).json({ error: 'Branch name required' });
  }

  try {
    const args = create ? `checkout -b ${branch}` : `checkout ${branch}`;
    await execGit(repoPath, args);
    res.json({ success: true, branch });
  } catch (err) {
    res.status(500).json({ error: err.error || err.message });
  }
});

// API: Commit changes
app.post('/api/repos/:name/git/commit', async (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);
  const { message, files } = req.body;

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  if (!message) {
    return res.status(400).json({ error: 'Commit message required' });
  }

  try {
    // Stage files (all if not specified)
    if (files && files.length > 0) {
      await execGit(repoPath, `add ${files.join(' ')}`);
    } else {
      await execGit(repoPath, 'add -A');
    }

    // Check if there are staged changes
    const staged = await execGit(repoPath, 'diff --cached --name-only');
    if (!staged.stdout.trim()) {
      return res.status(400).json({ error: 'No changes to commit' });
    }

    // Commit
    const safeMessage = message.replace(/"/g, '\\"');
    await execGit(repoPath, `commit -m "${safeMessage}"`);

    // Get the new commit hash
    const commitHash = await execGit(repoPath, 'rev-parse --short HEAD');

    broadcast({ type: 'git_commit', repo: req.params.name, hash: commitHash.stdout, message });
    res.json({ success: true, hash: commitHash.stdout });
  } catch (err) {
    res.status(500).json({ error: err.error || err.message });
  }
});

// API: Push to remote
app.post('/api/repos/:name/git/push', async (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);
  const { branch, setUpstream } = req.body;

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    // Get current branch if not specified
    let targetBranch = branch;
    if (!targetBranch) {
      const current = await execGit(repoPath, 'branch --show-current');
      targetBranch = current.stdout;
    }

    // Get authentication token
    const token = getGitHubToken();

    if (token) {
      // Get the remote URL and modify it to include the token
      const remoteUrl = await execGit(repoPath, 'remote get-url origin');
      let url = remoteUrl.stdout;

      // Convert SSH URL to HTTPS if needed
      if (url.startsWith('git@github.com:')) {
        url = url.replace('git@github.com:', 'https://github.com/');
      }

      // Add token authentication to URL
      if (url.startsWith('https://')) {
        const authUrl = url.replace('https://', `https://x-access-token:${token}@`);

        // Push with or without upstream tracking using authenticated URL
        const pushArgs = setUpstream
          ? `push -u ${authUrl} ${targetBranch}`
          : `push ${authUrl} ${targetBranch}`;

        await execGit(repoPath, pushArgs);
      } else {
        throw new Error('Unsupported remote URL format');
      }
    } else {
      // Try pushing without explicit auth (relies on git credentials)
      const pushArgs = setUpstream
        ? `push -u origin ${targetBranch}`
        : `push origin ${targetBranch}`;

      await execGit(repoPath, pushArgs);
    }

    broadcast({ type: 'git_push', repo: req.params.name, branch: targetBranch });
    res.json({ success: true, branch: targetBranch });
  } catch (err) {
    res.status(500).json({ error: err.error || err.message });
  }
});

// API: Pull from remote
app.post('/api/repos/:name/git/pull', async (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    await execGit(repoPath, 'pull');
    broadcast({ type: 'git_pull', repo: req.params.name });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.error || err.message });
  }
});

// API: Fetch from remote
app.post('/api/repos/:name/git/fetch', async (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    await execGit(repoPath, 'fetch origin');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.error || err.message });
  }
});

// API: Get recent commits
app.get('/api/repos/:name/git/log', async (req, res) => {
  const repoPath = path.join(REPOS_DIR, req.params.name);
  const limit = parseInt(req.query.limit) || 10;

  if (!fs.existsSync(repoPath)) {
    return res.status(404).json({ error: 'Repository not found' });
  }

  try {
    const log = await execGit(repoPath, `log -${limit} --format="%h|%s|%cr|%an"`);
    const commits = log.stdout.split('\n').filter(l => l.trim()).map(line => {
      const [hash, message, date, author] = line.split('|');
      return { hash, message, date, author };
    });
    res.json({ commits });
  } catch (err) {
    res.status(500).json({ error: err.error || err.message });
  }
});

// API: Get GitHub token status
app.get('/api/settings/github', (req, res) => {
  res.json({
    hasToken: !!process.env.GITHUB_TOKEN
  });
});

// API: Test GitHub token
app.post('/api/settings/github/test', async (req, res) => {
  try {
    const token = getGitHubToken();
    if (!token) {
      return res.json({ success: false, message: 'No GITHUB_TOKEN configured' });
    }

    // Actually test the token by calling GitHub API
    const user = await githubApiRequest('/user', token);
    res.json({
      success: true,
      message: `Connected as ${user.login}`,
      user: {
        login: user.login,
        name: user.name,
        avatar: user.avatar_url
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Token invalid: ' + err.message });
  }
});

// API: List available GitHub repositories from token
app.get('/api/github/repos', async (req, res) => {
  try {
    const token = getGitHubToken();
    if (!token) {
      return res.status(401).json({ error: 'No GITHUB_TOKEN configured' });
    }

    // Fetch all repos the user has access to (owned + collaborator + org member)
    // Using per_page=100 for efficiency, with affiliation filter for all accessible repos
    const repos = await githubApiRequest('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', token);

    // Get list of already cloned repos
    const clonedRepos = fs.existsSync(REPOS_DIR)
      ? fs.readdirSync(REPOS_DIR).filter(f => fs.statSync(path.join(REPOS_DIR, f)).isDirectory())
      : [];

    // Map to simplified format with cloned status
    const repoList = repos.map(repo => ({
      name: repo.name,
      fullName: repo.full_name,
      description: repo.description,
      url: repo.clone_url,
      sshUrl: repo.ssh_url,
      private: repo.private,
      owner: repo.owner.login,
      updatedAt: repo.updated_at,
      defaultBranch: repo.default_branch,
      cloned: clonedRepos.includes(repo.name)
    }));

    res.json(repoList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// API: Add (clone) a GitHub repository
app.post('/api/github/repos/add', async (req, res) => {
  const { fullName } = req.body;
  if (!fullName) {
    return res.status(400).json({ error: 'Repository fullName required (e.g., owner/repo)' });
  }

  const token = getGitHubToken();
  if (!token) {
    return res.status(401).json({ error: 'No GITHUB_TOKEN configured' });
  }

  const repoName = fullName.split('/').pop();
  const repoPath = path.join(REPOS_DIR, repoName);

  if (fs.existsSync(repoPath)) {
    return res.status(400).json({ error: 'Repository already exists locally' });
  }

  // Use HTTPS URL with token for cloning (works for private repos)
  const cloneUrl = `https://x-access-token:${token}@github.com/${fullName}.git`;

  const proc = spawn('git', ['clone', cloneUrl, repoPath]);

  let stderr = '';
  proc.stderr.on('data', data => stderr += data.toString());

  proc.on('close', code => {
    if (code === 0) {
      // Update remote to use clean URL (without token) for display
      exec(`git remote set-url origin https://github.com/${fullName}.git`, { cwd: repoPath }, () => {
        res.json({ success: true, name: repoName, path: repoPath });
      });
    } else {
      res.status(500).json({ error: 'Clone failed: ' + stderr });
    }
  });
});

// WebSocket connection handler
wss.on('connection', ws => {
  console.log('Client connected');

  // Send current state
  const jobs = Array.from(activeJobs.entries()).map(([id, job]) => ({
    id,
    repo: job.repo,
    type: job.type,
    status: job.status,
    iterations: job.iterations,
    cost: job.cost
  }));
  ws.send(JSON.stringify({ type: 'init', jobs }));

  ws.on('close', () => console.log('Client disconnected'));
});

// Serve dashboard
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Ralph Dashboard running at http://localhost:${PORT}`);
  console.log(`Access from iPhone: http://<your-ip>:${PORT}`);
});
