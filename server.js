const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');

require('dotenv').config();

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
