const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;

require('dotenv').config();

// GitHub App Configuration
let githubAppConfig = {
  appId: process.env.GITHUB_APP_ID || '',
  privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || '',
  installationId: process.env.GITHUB_APP_INSTALLATION_ID || ''
};

// Cache for GitHub App installation token
let installationTokenCache = {
  token: null,
  expiresAt: null
};

// Generate JWT for GitHub App
function generateGitHubAppJWT() {
  if (!githubAppConfig.appId || !githubAppConfig.privateKeyPath) {
    return null;
  }

  try {
    const privateKeyPath = path.resolve(githubAppConfig.privateKeyPath);
    if (!fs.existsSync(privateKeyPath)) {
      console.error('GitHub App private key not found:', privateKeyPath);
      return null;
    }

    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    const now = Math.floor(Date.now() / 1000);

    const header = { alg: 'RS256', typ: 'JWT' };
    const payload = {
      iat: now - 60,
      exp: now + 600, // 10 minutes
      iss: githubAppConfig.appId
    };

    const base64Header = Buffer.from(JSON.stringify(header)).toString('base64url');
    const base64Payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signatureInput = `${base64Header}.${base64Payload}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signatureInput);
    const signature = sign.sign(privateKey, 'base64url');

    return `${signatureInput}.${signature}`;
  } catch (err) {
    console.error('Failed to generate GitHub App JWT:', err.message);
    return null;
  }
}

// Get GitHub App installation token
async function getInstallationToken() {
  // Return cached token if still valid
  if (installationTokenCache.token && installationTokenCache.expiresAt) {
    const now = new Date();
    if (now < new Date(installationTokenCache.expiresAt)) {
      return installationTokenCache.token;
    }
  }

  if (!githubAppConfig.installationId) {
    return null;
  }

  const jwt = generateGitHubAppJWT();
  if (!jwt) return null;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.github.com',
      path: `/app/installations/${githubAppConfig.installationId}/access_tokens`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'RalphDashboard',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.token) {
            installationTokenCache.token = json.token;
            installationTokenCache.expiresAt = json.expires_at;
            resolve(json.token);
          } else {
            console.error('GitHub App token error:', json.message || data);
            resolve(null);
          }
        } catch (e) {
          console.error('Failed to parse GitHub token response:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.error('GitHub API request failed:', err.message);
      resolve(null);
    });

    req.end();
  });
}

// Configure git to use GitHub token for a repo
// Priority: userOAuthToken > GitHub App token > GITHUB_TOKEN env var
async function configureGitAuth(repoPath, userOAuthToken = null) {
  // First priority: user's OAuth token from sign-in
  if (userOAuthToken) {
    return { token: userOAuthToken, method: 'oauth' };
  }

  // Second priority: GitHub App installation token
  const token = await getInstallationToken();
  if (token) {
    return { token, method: 'app' };
  }

  // Third priority: Personal Access Token from environment
  if (process.env.GITHUB_TOKEN) {
    return { token: process.env.GITHUB_TOKEN, method: 'pat' };
  }

  return { token: null, method: 'none' };
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

// Session configuration
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  }
});
app.use(sessionMiddleware);

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Store for user GitHub tokens (user ID -> access token)
const userGitHubTokens = new Map();

// Passport serialization
passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// GitHub OAuth Strategy
if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
  passport.use(new GitHubStrategy({
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: process.env.GITHUB_CALLBACK_URL || '/auth/github/callback',
      scope: ['user:email', 'repo']
    },
    (accessToken, refreshToken, profile, done) => {
      // Store the user's GitHub access token for later use
      const user = {
        id: profile.id,
        username: profile.username,
        displayName: profile.displayName || profile.username,
        avatar: profile.photos && profile.photos[0] ? profile.photos[0].value : null,
        email: profile.emails && profile.emails[0] ? profile.emails[0].value : null
      };

      // Store the access token associated with this user
      userGitHubTokens.set(user.id, accessToken);

      return done(null, user);
    }
  ));
  console.log('GitHub OAuth configured');
} else {
  console.log('GitHub OAuth not configured (missing GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET)');
}

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) {
    return next();
  }
  res.status(401).json({ error: 'Authentication required' });
}

// Optional auth middleware - adds user to request if logged in
function optionalAuth(req, res, next) {
  next();
}

// Get user's GitHub token for API calls
function getUserGitHubToken(userId) {
  return userGitHubTokens.get(userId);
}

app.use(express.static(path.join(__dirname, 'public')));

// Broadcast to all WebSocket clients
function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// =====================
// Authentication Routes
// =====================

// Start GitHub OAuth flow
app.get('/auth/github', passport.authenticate('github', {
  scope: ['user:email', 'repo']
}));

// GitHub OAuth callback
app.get('/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/?error=auth_failed' }),
  (req, res) => {
    // Successful authentication
    res.redirect('/');
  }
);

// Get current user info
app.get('/api/auth/user', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({
      authenticated: true,
      user: req.user,
      hasGitHubToken: userGitHubTokens.has(req.user.id)
    });
  } else {
    res.json({ authenticated: false, user: null });
  }
});

// Logout
app.post('/auth/logout', (req, res) => {
  if (req.user) {
    // Remove stored GitHub token
    userGitHubTokens.delete(req.user.id);
  }
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ success: true });
  });
});

// =====================
// Repository API Routes
// =====================

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
app.post('/api/repos/clone', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const repoName = url.split('/').pop().replace('.git', '');
  const repoPath = path.join(REPOS_DIR, repoName);

  // Get user's OAuth token if logged in for private repo access
  const userOAuthToken = req.user ? getUserGitHubToken(req.user.id) : null;
  const auth = await configureGitAuth(null, userOAuthToken);

  let cloneUrl = url;

  // Add authentication to URL if we have a token
  if (auth.token && url.includes('github.com')) {
    // Convert SSH URL to HTTPS if needed
    if (cloneUrl.startsWith('git@github.com:')) {
      cloneUrl = cloneUrl.replace('git@github.com:', 'https://github.com/');
    }
    // Add token to HTTPS URL
    if (cloneUrl.startsWith('https://github.com')) {
      cloneUrl = cloneUrl.replace('https://github.com', `https://x-access-token:${auth.token}@github.com`);
    }
  }

  const proc = spawn('git', ['clone', cloneUrl, repoPath]);

  let stderr = '';
  proc.stderr.on('data', data => {
    stderr += data.toString();
  });

  proc.on('close', code => {
    if (code === 0) {
      res.json({ success: true, name: repoName, path: repoPath });
    } else {
      const errorMsg = stderr.includes('Authentication failed') || stderr.includes('could not read')
        ? 'Clone failed - authentication required. Please sign in with GitHub.'
        : 'Clone failed';
      res.status(500).json({ error: errorMsg });
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

    // Get user's OAuth token if logged in
    const userOAuthToken = req.user ? getUserGitHubToken(req.user.id) : null;

    // Get authentication (uses OAuth token if available)
    const auth = await configureGitAuth(repoPath, userOAuthToken);

    if (auth.token) {
      // Get the remote URL and modify it to include the token
      const remoteUrl = await execGit(repoPath, 'remote get-url origin');
      let url = remoteUrl.stdout;

      // Convert SSH URL to HTTPS if needed
      if (url.startsWith('git@github.com:')) {
        url = url.replace('git@github.com:', 'https://github.com/');
      }

      // Add token authentication to URL
      if (url.startsWith('https://')) {
        const authUrl = url.replace('https://', `https://x-access-token:${auth.token}@`);

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

// API: Get GitHub App settings (masked)
app.get('/api/settings/github', (req, res) => {
  const privateKeyExists = githubAppConfig.privateKeyPath &&
    fs.existsSync(path.resolve(githubAppConfig.privateKeyPath));

  res.json({
    appId: githubAppConfig.appId || '',
    installationId: githubAppConfig.installationId || '',
    privateKeyConfigured: privateKeyExists,
    hasToken: !!process.env.GITHUB_TOKEN
  });
});

// API: Update GitHub App settings
app.post('/api/settings/github', (req, res) => {
  const { appId, installationId, privateKey } = req.body;

  // Update config
  if (appId !== undefined) {
    githubAppConfig.appId = appId;
  }
  if (installationId !== undefined) {
    githubAppConfig.installationId = installationId;
  }

  // Save private key if provided
  if (privateKey) {
    const keyPath = path.join(__dirname, 'github-app-private-key.pem');
    try {
      fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
      githubAppConfig.privateKeyPath = keyPath;
    } catch (err) {
      return res.status(500).json({ error: 'Failed to save private key' });
    }
  }

  // Clear cached token when settings change
  installationTokenCache = { token: null, expiresAt: null };

  res.json({ success: true });
});

// API: Test GitHub App connection
app.post('/api/settings/github/test', async (req, res) => {
  try {
    const token = await getInstallationToken();
    if (token) {
      res.json({ success: true, message: 'GitHub App authentication successful' });
    } else if (process.env.GITHUB_TOKEN) {
      res.json({ success: true, message: 'Using Personal Access Token' });
    } else {
      res.json({ success: false, message: 'No authentication configured' });
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
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
