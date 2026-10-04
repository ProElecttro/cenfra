# Cenfra

> **Centralized deployment for repositories that should not need to know they are being deployed.**

Cenfra is a lightweight self-hosted deployment platform that sits between **GitHub** and your **Docker host**.

A project repository does not need its own CI/CD pipeline. You register it once in Cenfra, and Cenfra takes care of the rest:

```text
                    GitHub
                      │
             ┌────────┴────────┐
             │                 │
        Repository Push     Current HEAD
             │                 │
             └────────┬────────┘
                      ▼
                 ┌─────────┐
                 │  Cenfra │
                 └────┬────┘
                      │
             repository_dispatch
                      │
                      ▼
             GitHub Actions
                      │
             self-hosted runner
                      │
                docker build
                      │
                docker compose
                      ▼
                Running App
```

The result is a simple hosting workflow:

```text
Register → Start → Running
              ↑      │
              │      ↓
           Start    Stop
              │      │
              └── Stopped → Deregister
```

---

## What is Cenfra?

Cenfra is designed around one central idea:

> **Application repositories should contain application code, not infrastructure orchestration.**

Instead of putting deployment configuration in every project, Cenfra owns the deployment logic centrally.

A source repository such as:

```text
ProElecttro/dropsend
ProElecttro/testapp1
ProElecttro/testapp2
```

does not need to contain a Cenfra-specific workflow.

Cenfra stores the deployment configuration, creates the GitHub webhook, resolves the exact commit to deploy, and sends the deployment event to the central Cenfra workflow.

---

# Features

### Centralized deployments

All deployment logic lives in the Cenfra repository instead of being duplicated across every application repository.

### GitHub webhook driven

Cenfra reacts to GitHub `push` events. It does not continuously poll repositories for changes.

### Start without a push

A registered repository can be started directly from the dashboard. Cenfra resolves the current branch HEAD and deploys that exact commit.

### Stop applications

Running applications can be stopped from the dashboard without deregistering them.

### Safe deregistration

A repository must be stopped before it can be deregistered. Deregistration removes the GitHub webhook and Cenfra's deployment state.

### Automatic host-port allocation

Cenfra allocates an available host port from the configured range.

By default:

```text
3001 - 3030
```

### Application-port detection

The dashboard can attempt to detect the container's application port automatically.

Detection currently checks, in order:

1. `EXPOSE` in `Dockerfile`
2. `ENV PORT` in `Dockerfile`
3. A port declared in `package.json` scripts
4. Next.js default: `3000`
5. Vite default: `5173`

If no port can be detected, enter it manually.

### Live Docker status

The dashboard reconciles deployment status with the actual Docker container state. A running container is shown as **Running**, even if an earlier deployment state was still `Deploying`.

### Shared infrastructure

Multiple repositories can run on the same self-hosted machine while remaining separated by Docker containers and independent host ports.

---

# Architecture

Cenfra has four main pieces.

```text
┌─────────────────────┐
│ Application Repos   │
│                     │
│ DropSend            │
│ TestApp1            │
│ TestApp2            │
└──────────┬──────────┘
           │ GitHub Webhooks
           ▼
┌─────────────────────┐
│ Cenfra Server       │
│ Node.js + Express   │
│                     │
│ Dashboard           │
│ Registry            │
│ Webhook receiver    │
│ GitHub API client   │
└──────────┬──────────┘
           │ repository_dispatch
           ▼
┌─────────────────────┐
│ Cenfra GitHub Repo  │
│                     │
│ deploy.yml          │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│ Self-hosted Runner  │
│                     │
│ Docker              │
│ Docker Compose      │
└──────────┬──────────┘
           │
           ▼
      ┌───────────┐
      │ Containers│
      └───────────┘
```

### Why `repository_dispatch`?

The application repository triggers an event, but the **deployment workflow belongs to Cenfra**.

That keeps the source repository free of CI/CD configuration while still allowing Cenfra to deploy an exact commit SHA.

---

# Project structure

A typical Cenfra installation looks like:

```text
cenfra/
├── server.js
├── package.json
├── package-lock.json
├── .env
├── .gitignore
├── data/
│   └── deployments.json
│
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
│
└── .github/
    └── workflows/
        └── deploy.yml
```

### Important files

| File | Purpose |
|---|---|
| `server.js` | Cenfra API, dashboard backend, GitHub integration, webhook receiver, Docker control |
| `public/index.html` | Dashboard UI |
| `public/app.js` | Dashboard behavior and API calls |
| `public/style.css` | Dashboard styling |
| `data/deployments.json` | Local deployment registry |
| `.env` | GitHub/webhook configuration and secrets |
| `.github/workflows/deploy.yml` | Central deployment workflow |

---

# Requirements

Cenfra expects the hosting machine to have:

- Node.js
- npm
- Docker / Docker Desktop
- Git
- A GitHub account with access to the repositories you want to host
- A GitHub self-hosted runner configured for the Cenfra repository
- A publicly reachable HTTPS URL for GitHub webhooks

For the current local setup, the webhook endpoint is exposed through a Cloudflare Quick Tunnel.

---

# 1. Clone Cenfra

```bash
git clone git@github.com:ProElecttro/cenfra.git
cd cenfra
```

Install dependencies:

```bash
npm install
```

The server uses Node.js packages including Express and dotenv.

---

# 2. Configure `.env`

Create a `.env` file in the root of Cenfra:

```env
GITHUB_OWNER=ProElecttro
CENFRA_REPO=cenfra
GITHUB_TOKEN=YOUR_GITHUB_TOKEN
WEBHOOK_SECRET=YOUR_WEBHOOK_SECRET
PUBLIC_WEBHOOK_URL=https://YOUR_PUBLIC_HOST
```

### `GITHUB_OWNER`

The GitHub account or organization that owns the Cenfra repository.

Example:

```env
GITHUB_OWNER=ProElecttro
```

### `CENFRA_REPO`

The central repository containing the Cenfra deployment workflow.

Example:

```env
CENFRA_REPO=cenfra
```

### `GITHUB_TOKEN`

Token used by the **Cenfra Node.js server** to communicate with GitHub.

It is used for:

- Listing repositories
- Inspecting repositories
- Reading repository files
- Creating GitHub webhooks
- Updating GitHub webhooks
- Deleting GitHub webhooks during deregistration
- Triggering `repository_dispatch` on the Cenfra repository

For private repositories, the token needs access to the repositories Cenfra manages.

For a fine-grained token, give the minimum repository access required by your setup. At minimum, the source repositories need repository metadata/content access and webhook management, while the Cenfra repository needs permission to receive the dispatch event.

**Never commit this token.**

### `WEBHOOK_SECRET`

A shared secret used to verify that incoming GitHub webhook requests were actually generated by GitHub.

Generate one locally, for example:

```bash
openssl rand -hex 32
```

Then put the generated value in `.env`.

### `PUBLIC_WEBHOOK_URL`

The public base URL that GitHub can reach.

Cenfra automatically appends:

```text
/webhooks/github
```

So if:

```env
PUBLIC_WEBHOOK_URL=https://example.com
```

the final webhook URL becomes:

```text
https://example.com/webhooks/github
```

For the current Quick Tunnel setup:

```env
PUBLIC_WEBHOOK_URL=https://sue-troubleshooting-wheel-liver.trycloudflare.com
```

A Cloudflare Quick Tunnel URL is temporary. If the tunnel URL changes, restart the tunnel and update `.env`, then restart Cenfra. Existing GitHub webhooks may need to be recreated/updated so they point to the new URL.

---

# 3. Start the public webhook tunnel

For the current local setup, a Cloudflare Quick Tunnel can expose port `3100`:

```bash
cloudflared tunnel --url http://localhost:3100
```

You will receive a URL similar to:

```text
https://something.trycloudflare.com
```

Put that value in `.env`:

```env
PUBLIC_WEBHOOK_URL=https://something.trycloudflare.com
```

Keep the tunnel process running while you expect GitHub to deliver webhooks.

---

# 4. Start Cenfra

```bash
node server.js
```

The current server listens on:

```text
http://localhost:3100
```

Open the dashboard at:

```text
http://localhost:3100/
```

Health check:

```text
http://localhost:3100/health
```

---

# 5. Configure the GitHub self-hosted runner

The central deployment workflow runs on a self-hosted machine, because Cenfra needs access to the local Docker daemon.

The runner should have:

- Docker installed and running
- Git installed
- GitHub Actions runner installed
- Permission to execute Docker commands

The current workflow expects the labels:

```yaml
runs-on: [self-hosted, cenfra-runner]
```

`self-hosted` is automatically present on GitHub self-hosted runners.

`cenfra-runner` is a custom label identifying the machine intended for Cenfra deployments.

Start the runner on the machine with the GitHub runner's `run.sh`.

---

# 6. Configure the deployment workflow

The Cenfra repository needs a workflow such as:

```text
.github/workflows/deploy.yml
```

The workflow is triggered centrally:

```yaml
on:
  repository_dispatch:
    types: [deploy]
```

It may also expose `workflow_dispatch` for manual testing.

The deployment event contains:

```text
repository
branch
sha
app_port
host_port
```

For example:

```json
{
  "repository": "ProElecttro/dropsend",
  "branch": "main",
  "sha": "<exact-commit-sha>",
  "app_port": "5050",
  "host_port": "3001"
}
```

The workflow then:

1. Checks out the source repository at the exact SHA.
2. Verifies that a `Dockerfile` exists.
3. Creates a Cenfra-managed Docker Compose definition.
4. Builds the image locally on the self-hosted runner.
5. Starts the container with the allocated host port.
6. Verifies the resulting container.

A deployment should use the exact SHA sent by Cenfra rather than simply checking out whatever happens to be at `main` when the workflow runs.

---

# GitHub Actions secret used by the workflow

The central deployment workflow uses:

```text
HOSTING_GH_TOKEN
```

as a GitHub Actions repository secret in the **Cenfra repository**.

This token is used by `actions/checkout` to read the source repository when the source repository is private.

For least privilege, give this token read-only access to the source repositories it needs to deploy.

Keep this separate from the server-side `.env` token when practical:

```text
GITHUB_TOKEN       → Cenfra server → GitHub API
HOSTING_GH_TOKEN   → GitHub Actions runner → source repository checkout
```

---

# Hosting an application

A source repository needs a Dockerfile.

Example:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
```

The important part for Cenfra's port detector is:

```dockerfile
EXPOSE 3000
```

If your application listens on another port, declare that port instead.

---

# Registering a repository

Open:

```text
http://localhost:3100
```

Then:

### 1. Select a repository

Cenfra loads repositories available to the configured GitHub token.

### 2. Select the branch

The repository's default branch is populated automatically.

### 3. Check the Dockerfile

Cenfra verifies that the selected branch contains a Dockerfile.

### 4. Fetch the application port

Click:

```text
Fetch Port
```

Cenfra attempts to detect the port automatically.

### 5. Register

Cenfra then:

- Verifies the repository
- Verifies the Dockerfile
- Allocates a host port
- Creates/updates the GitHub push webhook
- Stores the deployment configuration

Registration itself does **not** start the container.

After registration, the repository appears in the dashboard as stopped and can be started from the UI.

---

# Start a repository

Click:

```text
Start
```

No GitHub push is necessary.

Cenfra:

```text
1. Finds the registered repository
2. Resolves the current branch HEAD SHA
3. Sends repository_dispatch to Cenfra
4. GitHub Actions starts on the self-hosted runner
5. Docker builds the image
6. Docker Compose starts the application
7. Dashboard detects the live container state
```

The important detail is that the deployment targets the **current branch HEAD at the time Start was pressed**.

---

# Push-based deployment

Once a repository is registered, Cenfra also installs a GitHub push webhook.

A push to the configured branch follows this path:

```text
Git push
   ↓
GitHub webhook
   ↓
Cenfra /webhooks/github
   ↓
Signature verification
   ↓
Repository lookup
   ↓
repository_dispatch
   ↓
Cenfra deploy workflow
   ↓
Docker build + run
```

A push to another branch does not deploy if that branch is not the registered branch.

---

# Stop a repository

When a repository is running, click:

```text
Stop
```

Cenfra stops the Docker Compose application on the self-hosted host.

The deployment registration remains intact.

The repository becomes:

```text
Stopped
```

It can be started again later without re-registering.

---

# Deregister a repository

Deregistration is intentionally stricter.

A running application cannot be deregistered.

The intended flow is:

```text
Running
   ↓
Stop
   ↓
Stopped
   ↓
Deregister
```

Deregistration removes:

- The Cenfra deployment record
- The GitHub webhook created by Cenfra
- Cenfra's local deployment directory
- The Docker Compose deployment stack when present

After deregistration, the repository is no longer managed by Cenfra.

---

# Host ports vs application ports

These are deliberately different concepts.

### Application port

The port the application listens on **inside the container**.

Example:

```text
DropSend → 5050
TestApp2 → 3000
```

### Host port

The port exposed by the machine running Docker.

Example:

```text
DropSend → 3001
TestApp2 → 3003
```

The resulting mapping is:

```text
localhost:3001  →  container:5050
localhost:3003  →  container:3000
```

Two containers may use the same application port because they are isolated, but their host ports must be different on the same machine.

---

# Host-port allocation

Cenfra currently allocates host ports from:

```text
3001 - 3030
```

The allocation logic avoids ports already assigned to registered deployments.

To change the range, edit these constants in `server.js`:

```js
const HOST_PORT_START = 3001;
const HOST_PORT_END = 3030;
```

Restart Cenfra after changing them.

---

# Where deployment state lives

Cenfra stores repository registrations in:

```text
data/deployments.json
```

Docker deployment files are stored under:

```text
~/.cenfra/deployments/<repository-name>/
```

Cenfra uses a sanitized repository name for Docker/Compose resources.

For example:

```text
ProElecttro/dropsend
```

becomes a deployment name similar to:

```text
proelecttro-dropsend
```

and the container name is derived from that deployment name.

`deployments.json` is local state. Back it up if Cenfra's registrations need to survive machine loss or filesystem cleanup.

---

# API endpoints

The backend exposes a small API used by the dashboard.

| Endpoint | Purpose |
|---|---|
| `GET /api/repos` | List GitHub repositories accessible to Cenfra |
| `GET /api/inspect` | Validate repository and inspect Dockerfile/port information |
| `GET /api/detect-port` | Detect the application port |
| `POST /api/register` | Register a repository and create its webhook |
| `GET /api/deployments` | Return registered deployments and live Docker state |
| `POST /api/deployments/:repository/start` | Start/deploy the current branch HEAD |
| `POST /api/deployments/:repository/stop` | Stop the running application |
| `DELETE /api/deployments/:repository` | Deregister a stopped repository |
| `POST /webhooks/github` | Receive GitHub webhook events |
| `GET /health` | Service health check |

---

# Security notes

Cenfra sits between GitHub and a machine with Docker access, so treat it as infrastructure software rather than a normal web demo.

### Protect secrets

Never commit:

```text
.env
GITHUB_TOKEN
WEBHOOK_SECRET
HOSTING_GH_TOKEN
```

Add `.env` to `.gitignore`.

### Verify webhook signatures

GitHub webhook requests are checked using `WEBHOOK_SECRET` and the `X-Hub-Signature-256` header before Cenfra processes the event.

### Be careful with self-hosted runners

A self-hosted runner executes workflow code on a real machine. For public repositories, untrusted workflow changes can become a host-level security problem.

Keep the Cenfra deployment workflow under a repository and access model you trust, and be especially careful about executing arbitrary code from pull requests.

### Restrict token permissions

Use the narrowest GitHub permissions that satisfy the operations you actually need.

---

# Troubleshooting

## Dashboard does not load

Check:

```bash
node server.js
```

Then open:

```text
http://localhost:3100
```

If the page looks unstyled, verify that:

```text
public/index.html
public/app.js
public/style.css
```

exist and that Express is serving `public/`.

---

## GitHub repositories are not appearing

Check:

```env
GITHUB_TOKEN=...
```

Then verify that the token can read the repositories you expect.

Restart Cenfra after changing `.env`.

---

## Start shows deployment but no container appears

Check the Cenfra GitHub Actions run.

Then inspect Docker on the runner:

```bash
docker ps -a
docker images
```

Also verify that the GitHub Actions runner is online and has the expected label:

```yaml
runs-on: [self-hosted, cenfra-runner]
```

---

## Application port detection fails

Add an explicit line to the application's Dockerfile:

```dockerfile
EXPOSE 3000
```

Then use **Fetch Port** again.

If automatic detection still does not fit the application, enter the correct container port manually.

---

## GitHub push does not deploy

Check all four pieces:

```text
1. Repository is registered
2. GitHub webhook exists
3. Public webhook URL is reachable
4. Cenfra can call repository_dispatch
```

Cenfra logs should show the incoming push and the resulting deployment trigger.

Check GitHub's repository webhook delivery history as well.

---

## Cloudflare webhook URL stopped working

Quick Tunnel URLs can change.

Start a new tunnel:

```bash
cloudflared tunnel --url http://localhost:3100
```

Update:

```env
PUBLIC_WEBHOOK_URL=https://new-url.trycloudflare.com
```

Restart Cenfra.

Repositories whose webhook URL points to the old tunnel may need to be re-registered or have their webhook updated.

---

# Development workflow

For normal application development:

```text
Code change
   ↓
git add .
git commit
git push
   ↓
GitHub
   ↓
Webhook
   ↓
Cenfra
   ↓
Central deploy workflow
   ↓
Self-hosted runner
   ↓
Docker rebuild
```

For a manual deployment without changing GitHub:

```text
Dashboard → Start
```

For taking an application offline temporarily:

```text
Dashboard → Stop
```

For removing Cenfra management completely:

```text
Dashboard → Stop → Deregister
```

---

# Example: DropSend

Suppose DropSend listens on container port `5050`.

Cenfra may allocate host port `3001`:

```text
DropSend

Application port: 5050
Host port:        3001

http://localhost:3001
```

Docker mapping:

```text
3001:5050
```

A GitHub push to the registered branch triggers a redeployment.

A dashboard **Start** deploys the current branch HEAD without requiring a new push.

---

# Example: TestApp2

Suppose TestApp2 listens on `3000`.

Cenfra can assign another host port, for example `3003`:

```text
Application port: 3000
Host port:        3003

http://localhost:3003
```

Both applications can run simultaneously because their host ports are different:

```text
localhost:3001 → DropSend → 5050
localhost:3003 → TestApp2 → 3000
```

---

# Operational model

Cenfra deliberately separates three states:

```text
Registered
    │
    ├── stopped
    │
    └── running
```

Registration answers:

> **Should Cenfra manage this repository?**

Start answers:

> **Should its application be running now?**

Stop answers:

> **Keep the registration, but take the application offline.**

Deregister answers:

> **Remove this repository from Cenfra entirely.**

This separation is what allows a project to be stopped and later started again without recreating its webhook or port allocation.

---

# Future direction

Cenfra's current architecture provides a foundation for adding things such as:

- Deployment history and rollback
- Build logs in the dashboard
- Health checks and automatic recovery
- Per-repository environment variables
- Custom domains
- HTTPS termination and reverse proxying
- Multiple deployment hosts
- Machine capacity awareness
- Deployment queues
- Versioned releases
- Zero-downtime replacement strategies

The important piece is already in place: **the application repository does not need to own the deployment system. Cenfra does.**

---

# License

Add the license that applies to your Cenfra repository.

