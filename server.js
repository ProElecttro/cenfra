const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
const PORT = 3100;
const execFileAsync = promisify(execFile);

// ============================================================
// Configuration
// ============================================================

const GITHUB_OWNER = process.env.GITHUB_OWNER;
const CENFRA_REPO = process.env.CENFRA_REPO;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const PUBLIC_WEBHOOK_URL = process.env.PUBLIC_WEBHOOK_URL;

const HOST_PORT_START = 3001;
const HOST_PORT_END = 3030;

// ============================================================
// Paths
// ============================================================

const DATA_DIR = path.join(__dirname, "data");
const DEPLOYMENTS_FILE = path.join(DATA_DIR, "deployments.json");
const PUBLIC_DIR = path.join(__dirname, "public");

fs.mkdirSync(DATA_DIR, { recursive: true });

if (!fs.existsSync(DEPLOYMENTS_FILE)) {
    fs.writeFileSync(DEPLOYMENTS_FILE, "[]\n");
}

// ============================================================
// Middleware
// ============================================================

app.use(
    "/webhooks/github",
    express.raw({ type: "application/json" })
);

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// ============================================================
// Data helpers
// ============================================================

function loadDeployments() {
    try {
        return JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
    } catch (error) {
        console.error("Failed to read deployments:", error.message);
        return [];
    }
}

function saveDeployments(deployments) {
    fs.writeFileSync(
        DEPLOYMENTS_FILE,
        JSON.stringify(deployments, null, 2) + "\n"
    );
}

function safeName(repository) {
    return repository
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-");
}

function getDeploymentPaths(deployment) {
    const name = safeName(deployment.repository);
    const deployDir = path.join(
        process.env.HOME || process.cwd(),
        ".cenfra",
        "deployments",
        name
    );

    return {
        name,
        deployDir,
        composeFile: path.join(deployDir, "docker-compose.yml"),
        containerName: `cenfra-${name}`
    };
}

// ============================================================
// Docker helpers
// ============================================================

async function getContainerState(deployment) {
    const { containerName } = getDeploymentPaths(deployment);

    try {
        const { stdout } = await execFileAsync("docker", [
            "inspect",
            "--format",
            "{{.State.Running}}",
            containerName
        ]);

        return stdout.trim() === "true" ? "running" : "stopped";
    } catch (error) {
        const stderr = String(error.stderr || "");
        const stdout = String(error.stdout || "");
        const message = `${stderr} ${stdout} ${error.message || ""}`;

        // Docker inspect exits with code 1 when the container does not exist.
        // Treat that as a normal pre-deployment state, not an unknown state.
        if (
            error.code === 1 ||
            message.includes("No such object") ||
            message.includes("No such container")
        ) {
            return "not-deployed";
        }

        // Docker itself is unavailable / daemon is not reachable.
        if (
            error.code === "ENOENT" ||
            message.includes("Cannot connect to the Docker daemon") ||
            message.includes("Is the docker daemon running")
        ) {
            return "docker-unavailable";
        }

        console.error(
            `Unable to inspect ${containerName}:`,
            message.trim()
        );

        return "unknown";
    }
}

async function runCompose(deployment, command) {
    const { name, composeFile } = getDeploymentPaths(deployment);

    if (!fs.existsSync(composeFile)) {
        throw new Error(
            `Deployment files not found for ${deployment.repository}`
        );
    }

    console.log(
        `docker compose -p ${name} -f ${composeFile} ${command.join(" ")}`
    );

    return execFileAsync("docker", [
        "compose",
        "-p",
        name,
        "-f",
        composeFile,
        ...command
    ]);
}

// ============================================================
// GitHub helpers
// ============================================================

function parseRepository(repository) {
    const parts = repository.split("/");

    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error("Repository must be in owner/repository format");
    }

    return {
        owner: parts[0],
        repo: parts[1]
    };
}

async function githubRequest(endpoint, options = {}) {
    const response = await fetch(
        `https://api.github.com${endpoint}`,
        {
            ...options,
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                "X-GitHub-Api-Version": "2022-11-28",
                ...(options.headers || {})
            }
        }
    );

    const text = await response.text();
    let data = null;

    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        data = text;
    }

    if (!response.ok) {
        const error = new Error(
            data?.message || `GitHub API request failed (${response.status})`
        );
        error.status = response.status;
        throw error;
    }

    return data;
}

async function getRepository(repository) {
    const { owner, repo } = parseRepository(repository);

    return githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
}

async function getBranchHeadSha(repository, branch) {
    const { owner, repo } = parseRepository(repository);

    const commit = await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`
    );

    if (!commit?.sha) {
        throw new Error(`Unable to resolve HEAD SHA for ${repository}:${branch}`);
    }

    return commit.sha;
}

async function checkDockerfile(repository, branch) {
    const { owner, repo } = parseRepository(repository);

    try {
        const dockerfile = await githubRequest(
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/Dockerfile?ref=${encodeURIComponent(branch)}`
        );

        return {
            exists: true,
            type: dockerfile.type,
            path: dockerfile.path
        };
    } catch (error) {
        if (error.status === 404) {
            return { exists: false };
        }
        throw error;
    }
}


async function getFileText(repository, filePath, branch) {
    const { owner, repo } = parseRepository(repository);

    const file = await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${filePath}?ref=${encodeURIComponent(branch)}`
    );

    if (!file || file.type !== "file" || !file.content) {
        throw new Error(`Unable to read ${filePath}`);
    }

    return Buffer.from(file.content, "base64").toString("utf8");
}

function detectPortFromDockerfile(dockerfile) {
    const exposeMatches = [
        ...dockerfile.matchAll(/^\s*EXPOSE\s+([^#\r\n]+)/gim)
    ];

    for (const match of exposeMatches) {
        const candidates = match[1]
            .trim()
            .split(/\s+/)
            .map((value) => value.split("/")[0])
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);

        if (candidates.length > 0) {
            return {
                port: candidates[0],
                source: "Dockerfile EXPOSE"
            };
        }
    }

    const envPatterns = [
        /^\s*ENV\s+PORT\s+([0-9]{1,5})\s*(?:#.*)?$/im,
        /^\s*ENV\s+PORT=([0-9]{1,5})\s*(?:#.*)?$/im
    ];

    for (const pattern of envPatterns) {
        const match = dockerfile.match(pattern);
        if (match) {
            const port = Number(match[1]);
            if (port >= 1 && port <= 65535) {
                return {
                    port,
                    source: "Dockerfile ENV PORT"
                };
            }
        }
    }

    return null;
}

async function detectApplicationPort(repository, branch) {
    // Strongest signal: Dockerfile explicitly declares the container port.
    try {
        const dockerfile = await getFileText(
            repository,
            "Dockerfile",
            branch
        );

        const detected = detectPortFromDockerfile(dockerfile);
        if (detected) {
            return detected;
        }
    } catch (error) {
        if (error.status !== 404) {
            throw error;
        }
    }

    // Common Node.js project fallback when package.json declares a port
    // in a start script or package metadata.
    try {
        const packageJsonText = await getFileText(
            repository,
            "package.json",
            branch
        );

        const packageJson = JSON.parse(packageJsonText);
        const scripts = Object.values(packageJson.scripts || {}).join(" ");
        const scriptPort = scripts.match(/(?:PORT|--port|-p)[=\s:]+(\d{2,5})/i);

        if (scriptPort) {
            const port = Number(scriptPort[1]);
            if (port >= 1 && port <= 65535) {
                return {
                    port,
                    source: "package.json script"
                };
            }
        }

        const dependencies = {
            ...(packageJson.dependencies || {}),
            ...(packageJson.devDependencies || {})
        };

        if (dependencies.next) {
            return { port: 3000, source: "Next.js default" };
        }

        if (dependencies.vite) {
            return { port: 5173, source: "Vite default" };
        }
    } catch (error) {
        if (error.status !== 404) {
            // Ignore malformed/missing package.json and let the caller know
            // no port was detected rather than failing registration.
            console.warn(`Port detection fallback skipped: ${error.message}`);
        }
    }

    return null;
}

async function createPushWebhook(repository) {
    const hooks = await githubRequest(
        `/repos/${repository}/hooks?per_page=100`
    );

    const webhookUrl = `${PUBLIC_WEBHOOK_URL}/webhooks/github`;

    const existing = hooks.find(
        (hook) => hook.config?.url === webhookUrl
    );

    const config = {
        url: webhookUrl,
        content_type: "json",
        secret: WEBHOOK_SECRET,
        insecure_ssl: "0"
    };

    if (existing) {
        await githubRequest(
            `/repos/${repository}/hooks/${existing.id}`,
            {
                method: "PATCH",
                body: JSON.stringify({
                    name: "web",
                    active: true,
                    events: ["push"],
                    config
                }),
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );

        return existing.id;
    }

    const webhook = await githubRequest(
        `/repos/${repository}/hooks`,
        {
            method: "POST",
            body: JSON.stringify({
                name: "web",
                active: true,
                events: ["push"],
                config
            }),
            headers: {
                "Content-Type": "application/json"
            }
        }
    );

    return webhook.id;
}

async function deleteWebhook(repository, webhookId) {
    if (!webhookId) {
        return;
    }

    try {
        await githubRequest(
            `/repos/${repository}/hooks/${webhookId}`,
            { method: "DELETE" }
        );

        console.log(`Deleted webhook ${webhookId} for ${repository}`);
    } catch (error) {
        // Already deleted manually. Treat that as success for deregistration.
        if (error.status === 404) {
            return;
        }
        throw error;
    }
}

async function triggerDeployment({
    repository,
    branch,
    sha,
    appPort,
    hostPort
}) {
    await githubRequest(
        `/repos/${GITHUB_OWNER}/${CENFRA_REPO}/dispatches`,
        {
            method: "POST",
            body: JSON.stringify({
                event_type: "deploy",
                client_payload: {
                    repository,
                    branch,
                    sha,
                    app_port: String(appPort),
                    host_port: String(hostPort)
                }
            }),
            headers: {
                "Content-Type": "application/json"
            }
        }
    );
}

// ============================================================
// Host port allocation
// ============================================================

function allocateHostPort() {
    const deployments = loadDeployments();
    const usedPorts = new Set(
        deployments.map((d) => Number(d.hostPort))
    );

    for (let port = HOST_PORT_START; port <= HOST_PORT_END; port++) {
        if (!usedPorts.has(port)) {
            return port;
        }
    }

    throw new Error(
        `No host ports available in range ${HOST_PORT_START}-${HOST_PORT_END}`
    );
}

// ============================================================
// API: GitHub repositories
// ============================================================

app.get("/api/repos", async (req, res) => {
    try {
        const repositories = await githubRequest(
            "/user/repos?visibility=all&affiliation=owner&per_page=100&sort=updated"
        );

        res.json(
            repositories.map((repo) => ({
                full_name: repo.full_name,
                name: repo.name,
                private: repo.private,
                default_branch: repo.default_branch || "main"
            }))
        );
    } catch (error) {
        console.error("Failed to load repositories:", error.message);
        res.status(500).json({
            error: error.message || "Failed to load repositories"
        });
    }
});

// ============================================================
// API: Inspect repository
// ============================================================

app.get("/api/inspect", async (req, res) => {
    try {
        const repository = req.query.repository;
        const branch = req.query.branch || "main";

        if (!repository) {
            return res.status(400).json({ error: "Repository is required" });
        }

        const repo = await getRepository(repository);

        if (repo.archived) {
            return res.status(400).json({ error: "Repository is archived" });
        }

        const dockerfile = await checkDockerfile(repository, branch);
        const detectedPort = dockerfile.exists
            ? await detectApplicationPort(repository, branch)
            : null;

        res.json({
            repository,
            branch,
            dockerfile: dockerfile.exists,
            detectedPort
        });
    } catch (error) {
        console.error("Repository inspection failed:", error.message);
        res.status(error.status || 500).json({
            error: error.message || "Failed to inspect repository"
        });
    }
});

// ============================================================
// API: Detect application port
// ============================================================

app.get("/api/detect-port", async (req, res) => {
    try {
        const repository = req.query.repository;
        const branch = req.query.branch || "main";

        if (!repository) {
            return res.status(400).json({
                error: "Repository is required"
            });
        }

        await getRepository(repository);

        const result = await detectApplicationPort(
            repository,
            branch
        );

        if (!result) {
            return res.status(404).json({
                error:
                    "Cenfra could not detect the application port automatically. Add an EXPOSE <port> line to the Dockerfile or enter the port manually."
            });
        }

        res.json({
            repository,
            branch,
            ...result
        });
    } catch (error) {
        console.error("Port detection failed:", error.message);

        res.status(error.status || 500).json({
            error:
                error.message ||
                "Failed to detect application port"
        });
    }
});

// ============================================================
// API: Register repository
// ============================================================

app.post("/api/register", async (req, res) => {
    try {
        const { repository, branch, appPort } = req.body;
        const numericAppPort = Number(appPort);

        if (!repository) {
            return res.status(400).json({ error: "Repository is required" });
        }

        if (!branch) {
            return res.status(400).json({ error: "Branch is required" });
        }

        if (
            !Number.isInteger(numericAppPort) ||
            numericAppPort < 1 ||
            numericAppPort > 65535
        ) {
            return res.status(400).json({ error: "Invalid application port" });
        }

        parseRepository(repository);

        const repo = await getRepository(repository);

        if (repo.archived) {
            return res.status(400).json({
                error: "Cannot register an archived repository"
            });
        }

        const dockerfile = await checkDockerfile(repository, branch);

        if (!dockerfile.exists) {
            return res.status(400).json({
                error: `No Dockerfile found in ${repository} on branch ${branch}`
            });
        }

        const deployments = loadDeployments();
        const existing = deployments.find(
            (deployment) => deployment.repository === repository
        );

        if (existing) {
            return res.status(409).json({
                error: "Repository is already registered",
                deployment: existing
            });
        }

        const hostPort = allocateHostPort();
        const webhookId = await createPushWebhook(repository);

        const deployment = {
            repository,
            branch,
            appPort: numericAppPort,
            hostPort,
            webhookId,
            status: "stopped",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        deployments.push(deployment);
        saveDeployments(deployments);

        console.log(`Registered ${repository} on ${hostPort}`);

        res.status(201).json({
            success: true,
            message: "Repository registered successfully",
            deployment,
            hostPort
        });
    } catch (error) {
        console.error("Registration failed:", error.message);
        res.status(error.status || 500).json({
            error: error.message || "Failed to register repository"
        });
    }
});

// ============================================================
// API: Get deployments + live Docker state
// ============================================================

app.get("/api/deployments", async (req, res) => {
    try {
        const deployments = loadDeployments();
        let changed = false;

        const result = await Promise.all(
            deployments.map(async (deployment) => {
                const runtimeState = await getContainerState(deployment);

                // The Docker runtime is the source of truth for whether
                // an application is actually running. Once the workflow
                // has created and started the container, immediately move
                // the persisted state out of deployment-triggered.
                if (runtimeState === "running" &&
                    (deployment.status === "deploying" ||
                     deployment.status === "deployment-triggered")) {
                    deployment.status = "running";
                    deployment.updatedAt = new Date().toISOString();
                    changed = true;
                }

                // Also reconcile a stopped container with a transitional
                // status left behind by a previous action.
                if (runtimeState === "stopped" &&
                    (deployment.status === "stopping" ||
                     deployment.status === "running")) {
                    deployment.status = "stopped";
                    deployment.updatedAt = new Date().toISOString();
                    changed = true;
                }

                return {
                    ...deployment,
                    runtimeState
                };
            })
        );

        if (changed) {
            saveDeployments(deployments);
        }

        res.json(result);
    } catch (error) {
        console.error("Failed to load deployments:", error.message);
        res.status(500).json({
            error: "Failed to load deployments"
        });
    }
});

// ============================================================
// API: Start repository
// Resolves the current branch HEAD and triggers the centralized
// deployment workflow. No GitHub push is required.
// ============================================================

app.post("/api/deployments/:repository/start", async (req, res) => {
    const repository = decodeURIComponent(req.params.repository);

    try {
        const deployments = loadDeployments();
        const deployment = deployments.find(
            (item) => item.repository === repository
        );

        if (!deployment) {
            return res.status(404).json({
                error: "Repository is not registered"
            });
        }

        const runtimeState = await getContainerState(deployment);

        if (runtimeState === "running") {
            return res.status(409).json({
                error: "Repository is already running"
            });
        }

        if (runtimeState === "unknown") {
            return res.status(409).json({
                error: "Unable to verify the Docker runtime state"
            });
        }

        if (deployment.status === "deploying" || deployment.status === "deployment-triggered") {
            return res.status(409).json({
                error: "Repository deployment is already in progress"
            });
        }

        deployment.status = "deploying";
        deployment.updatedAt = new Date().toISOString();
        saveDeployments(deployments);

        const sha = await getBranchHeadSha(
            repository,
            deployment.branch
        );

        await triggerDeployment({
            repository,
            branch: deployment.branch,
            sha,
            appPort: deployment.appPort,
            hostPort: deployment.hostPort
        });

        deployment.lastRequestedSha = sha;
        deployment.status = "deployment-triggered";
        deployment.updatedAt = new Date().toISOString();
        saveDeployments(deployments);

        console.log(
            `Start requested for ${repository} at ${sha}`
        );

        return res.json({
            success: true,
            message: "Deployment triggered",
            sha,
            hostPort: deployment.hostPort
        });
    } catch (error) {
        console.error(
            `Start failed for ${repository}:`,
            error.message
        );

        const deployments = loadDeployments();
        const deployment = deployments.find(
            (item) => item.repository === repository
        );

        if (deployment) {
            deployment.status = "start-failed";
            deployment.updatedAt = new Date().toISOString();
            saveDeployments(deployments);
        }

        return res.status(error.status || 500).json({
            error: error.message || "Failed to start repository"
        });
    }
});

// ============================================================
// API: Stop running repository
// ============================================================

app.post("/api/deployments/:repository/stop", async (req, res) => {
    try {
        const repository = decodeURIComponent(req.params.repository);
        const deployments = loadDeployments();

        const deployment = deployments.find(
            (item) => item.repository === repository
        );

        if (!deployment) {
            return res.status(404).json({
                error: "Repository is not registered"
            });
        }

        const runtimeState = await getContainerState(deployment);

        if (runtimeState === "stopped" || runtimeState === "not-deployed") {
            deployment.status = "stopped";
            deployment.updatedAt = new Date().toISOString();
            saveDeployments(deployments);

            return res.json({
                success: true,
                message: "Repository is already stopped",
                runtimeState: "stopped"
            });
        }

        if (runtimeState !== "running") {
            return res.status(409).json({
                error: `Cannot stop repository while runtime state is ${runtimeState}`
            });
        }

        deployment.status = "stopping";
        deployment.updatedAt = new Date().toISOString();
        saveDeployments(deployments);

        await runCompose(deployment, ["stop"]);

        const finalState = await getContainerState(deployment);

        if (finalState === "running") {
            deployment.status = "stop-failed";
            deployment.updatedAt = new Date().toISOString();
            saveDeployments(deployments);

            return res.status(500).json({
                error: "Docker container is still running"
            });
        }

        deployment.status = "stopped";
        deployment.updatedAt = new Date().toISOString();
        saveDeployments(deployments);

        console.log(`Stopped ${repository}`);

        res.json({
            success: true,
            message: "Repository stopped successfully",
            runtimeState: "stopped"
        });
    } catch (error) {
        console.error("Stop failed:", error.message);

        const deployments = loadDeployments();
        const repository = decodeURIComponent(req.params.repository);
        const deployment = deployments.find(
            (item) => item.repository === repository
        );

        if (deployment) {
            deployment.status = "stop-failed";
            deployment.updatedAt = new Date().toISOString();
            saveDeployments(deployments);
        }

        res.status(500).json({
            error: error.message || "Failed to stop repository"
        });
    }
});

// ============================================================
// API: Deregister repository
// Only allowed after the container is stopped.
// ============================================================

app.delete("/api/deployments/:repository", async (req, res) => {
    try {
        const repository = decodeURIComponent(req.params.repository);
        const deployments = loadDeployments();

        const index = deployments.findIndex(
            (item) => item.repository === repository
        );

        if (index === -1) {
            return res.status(404).json({
                error: "Repository is not registered"
            });
        }

        const deployment = deployments[index];
        const runtimeState = await getContainerState(deployment);

        // Deregistration is only available for a deployed container
        // that has explicitly been stopped. A never-started repository
        // must be started first, then stopped, before it can be removed.
        if (runtimeState === "running") {
            return res.status(409).json({
                error: "Stop the repository before deregistering it"
            });
        }

        if (runtimeState === "not-deployed") {
            return res.status(409).json({
                error: "Start the repository and stop it before deregistering it"
            });
        }

        if (runtimeState === "unknown") {
            return res.status(409).json({
                error: "Unable to verify the Docker runtime state"
            });
        }

        deployment.status = "deregistering";
        deployment.updatedAt = new Date().toISOString();
        saveDeployments(deployments);

        // Remove the compose stack/container if it exists.
        const { deployDir, composeFile } = getDeploymentPaths(deployment);

        if (fs.existsSync(composeFile)) {
            try {
                await runCompose(deployment, ["down", "--remove-orphans"]);
            } catch (error) {
                console.warn(
                    `Docker cleanup warning for ${repository}:`,
                    error.message
                );
            }
        }

        // Remove GitHub webhook.
        await deleteWebhook(
            repository,
            deployment.webhookId
        );

        // Remove local Cenfra deployment files.
        if (fs.existsSync(deployDir)) {
            fs.rmSync(deployDir, {
                recursive: true,
                force: true
            });
        }

        deployments.splice(index, 1);
        saveDeployments(deployments);

        console.log(`Deregistered ${repository}`);

        res.json({
            success: true,
            message: "Repository deregistered successfully"
        });
    } catch (error) {
        console.error("Deregistration failed:", error.message);
        res.status(error.status || 500).json({
            error:
                error.message ||
                "Failed to deregister repository"
        });
    }
});

// ============================================================
// GitHub webhook
// ============================================================

function verifyWebhookSignature(req) {
    if (!WEBHOOK_SECRET) {
        return false;
    }

    const signature =
        req.headers["x-hub-signature-256"] || "";

    if (!signature.startsWith("sha256=")) {
        return false;
    }

    const expected = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(req.body)
        .digest("hex");

    const received = signature.slice(7);

    if (received.length !== expected.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        Buffer.from(received),
        Buffer.from(expected)
    );
}

app.post("/webhooks/github", async (req, res) => {
    console.log("\n========== GitHub Webhook ==========");

    if (!verifyWebhookSignature(req)) {
        console.log("Invalid webhook signature");
        return res.status(401).send("Invalid signature");
    }

    let payload;

    try {
        payload = JSON.parse(req.body.toString("utf8"));
    } catch {
        return res.status(400).send("Invalid JSON");
    }

    const event = req.headers["x-github-event"];

    if (event === "ping") {
        return res.status(200).send("Pong");
    }

    if (event !== "push") {
        return res.status(200).send("Ignored");
    }

    const repository = payload.repository?.full_name;
    const ref = payload.ref || "";
    const sha = payload.after;

    if (!repository || !sha) {
        return res.status(400).send("Invalid push payload");
    }

    const branch = ref.startsWith("refs/heads/")
        ? ref.replace("refs/heads/", "")
        : ref;

    console.log(`Repository: ${repository}`);
    console.log(`Branch: ${branch}`);
    console.log(`Commit: ${sha}`);

    const deployments = loadDeployments();
    const deployment = deployments.find(
        (item) =>
            item.repository === repository &&
            item.branch === branch
    );

    if (!deployment) {
        console.log("Repository is not registered with Cenfra");
        return res.status(200).send("Repository not registered");
    }

    // A repository stopped from Cenfra stays stopped until explicitly started.
    if (deployment.status === "stopped") {
        console.log(
            "Repository is stopped. Ignoring push until it is started again."
        );
        return res.status(200).send("Repository stopped");
    }

    try {
        await triggerDeployment({
            repository,
            branch,
            sha,
            appPort: deployment.appPort,
            hostPort: deployment.hostPort
        });

        deployment.status = "deployment-triggered";
        deployment.updatedAt = new Date().toISOString();
        saveDeployments(deployments);

        console.log("Deployment triggered successfully");
        return res.status(200).send("Deployment triggered");
    } catch (error) {
        console.error("Deployment trigger failed:", error.message);

        deployment.status = "dispatch-failed";
        deployment.updatedAt = new Date().toISOString();
        saveDeployments(deployments);

        return res.status(500).send("Deployment trigger failed");
    }
});

// ============================================================
// Health check
// ============================================================

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        service: "cenfra"
    });
});

// ============================================================
// Frontend
// ============================================================

app.get("/", (req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ============================================================
// Start server
// ============================================================

app.listen(PORT, () => {
    console.log("======================================");
    console.log("Cenfra server started");
    console.log(`Local: http://localhost:${PORT}`);
    console.log(
        `Webhook: ${PUBLIC_WEBHOOK_URL}/webhooks/github`
    );
    console.log(
        `Host ports: ${HOST_PORT_START}-${HOST_PORT_END}`
    );
    console.log("======================================");
});
