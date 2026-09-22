'use strict';

// Idempotent deploy to Render's free tier:
//   RENDER_API_KEY=... npm run deploy
// Finds the web service named after this repo (e.g. runo-foo), creates it if
// missing, triggers a deploy, waits until it is live, checks /api/health and
// prints the public URL. Running it again reuses the same service.
//
// Optional env: RENDER_SERVICE_NAME, RENDER_OWNER_ID, RENDER_REGION, RUNO_REPO_URL.

const { execSync } = require('node:child_process');

const API = 'https://api.render.com/v1';
const KEY = process.env.RENDER_API_KEY;
const FAILED = new Set(['build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  console.error(`Deploy failed: ${message}`);
  process.exit(1);
}

async function render(method, path, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      await sleep(2000 * attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
    return text ? JSON.parse(text) : null;
  }
}

function repoUrl() {
  if (process.env.RUNO_REPO_URL) return process.env.RUNO_REPO_URL;
  let url;
  try {
    url = execSync('git remote get-url origin', { encoding: 'utf8' }).trim();
  } catch {
    fail('no git remote "origin" found. Push the project to GitHub first or set RUNO_REPO_URL.');
  }
  const ssh = url.match(/^git@github\.com:(.+?)(\.git)?$/);
  if (ssh) url = `https://github.com/${ssh[1]}`;
  return url.replace(/\.git$/, '');
}

async function findOwnerId() {
  if (process.env.RENDER_OWNER_ID) return process.env.RENDER_OWNER_ID;
  const owners = await render('GET', '/owners?limit=20');
  if (!owners.length) fail('no Render workspace found for this API key.');
  return owners[0].owner.id;
}

async function findService(name, ownerId) {
  const list = await render('GET', `/services?name=${encodeURIComponent(name)}&ownerId=${ownerId}&limit=100`);
  const matches = list.map((item) => item.service).filter((s) => s.name === name);
  if (matches.length > 1) fail(`found ${matches.length} services named ${name}; refusing to guess.`);
  return matches[0] || null;
}

async function createService(name, ownerId, repo) {
  const body = {
    type: 'web_service',
    name,
    ownerId,
    repo,
    branch: 'main',
    autoDeploy: 'yes',
    serviceDetails: {
      runtime: 'node',
      plan: 'free', // never omit: the API defaults to a paid instance
      region: process.env.RENDER_REGION || 'oregon',
      healthCheckPath: '/api/health',
      envSpecificDetails: {
        buildCommand: 'npm install',
        startCommand: 'npm start',
      },
    },
  };
  const created = await render('POST', '/services', body);
  return { service: created.service || created, deployId: created.deployId || null };
}

async function waitForDeploy(serviceId, deployId) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 20 * 60_000) {
    const deploy = await render('GET', `/services/${serviceId}/deploys/${deployId}`);
    if (deploy.status !== last) {
      console.log(`  deploy ${deployId}: ${deploy.status}`);
      last = deploy.status;
    }
    if (deploy.status === 'live') return;
    if (FAILED.has(deploy.status)) fail(`deploy ended with status "${deploy.status}". Check the Render dashboard logs.`);
    await sleep(8000);
  }
  fail('timed out after 20 minutes waiting for the deploy to go live.');
}

async function checkHealth(url) {
  for (let attempt = 1; attempt <= 20; attempt++) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.status === 200) return;
      console.log(`  /api/health returned ${res.status}, retrying...`);
    } catch (err) {
      console.log(`  /api/health not reachable yet (${err.cause?.code || err.message}), retrying...`);
    }
    await sleep(6000);
  }
  fail(`${url}/api/health never returned 200.`);
}

async function main() {
  if (!KEY) fail('set the RENDER_API_KEY environment variable.');
  const repo = repoUrl();
  const name = process.env.RENDER_SERVICE_NAME || repo.split('/').pop();
  if (!/^runo-/.test(name)) fail(`service name "${name}" should start with "runo-".`);

  const ownerId = await findOwnerId();
  let service = await findService(name, ownerId);
  let deployId;

  if (service) {
    console.log(`Found existing service ${name} (${service.id}).`);
    if (service.serviceDetails?.plan && service.serviceDetails.plan !== 'free') {
      console.warn(`  warning: this service is on the "${service.serviceDetails.plan}" plan, not free.`);
    }
    const deploy = await render('POST', `/services/${service.id}/deploys`, { clearCache: 'do_not_clear' });
    deployId = deploy.id;
    console.log(`Triggered deploy ${deployId}.`);
  } else {
    console.log(`Creating free web service ${name} from ${repo}...`);
    const created = await createService(name, ownerId, repo);
    service = created.service;
    deployId = created.deployId;
    if (!deployId) {
      const deploys = await render('GET', `/services/${service.id}/deploys?limit=1`);
      deployId = deploys[0]?.deploy?.id;
      if (!deployId) deployId = (await render('POST', `/services/${service.id}/deploys`, {})).id;
    }
    console.log(`Created service ${service.id}; initial deploy ${deployId}.`);
  }

  await waitForDeploy(service.id, deployId);
  const fresh = await render('GET', `/services/${service.id}`);
  const url = (fresh.serviceDetails?.url || `https://${name}.onrender.com`).replace(/\/+$/, '');
  await checkHealth(url);

  console.log('');
  console.log(`Live:       ${url}`);
  console.log(`Service ID: ${service.id}`);
  console.log(`Repository: ${repo}`);
}

main().catch((err) => fail(err.message));
