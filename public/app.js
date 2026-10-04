const repoSelect = document.getElementById("repoSelect");
const branchInput = document.getElementById("branch");
const appPortInput = document.getElementById("appPort");
const checkDockerBtn = document.getElementById("checkDockerBtn");
const registerBtn = document.getElementById("registerBtn");
const dockerStatus = document.getElementById("dockerStatus");
const fetchPortBtn = document.getElementById("fetchPortBtn");
const portStatus = document.getElementById("portStatus");
const message = document.getElementById("message");
const deploymentsBody = document.getElementById("deploymentsBody");

const confirmModal = document.getElementById("confirmModal");
const modalTitle = document.getElementById("modalTitle");
const modalText = document.getElementById("modalText");
const modalCancel = document.getElementById("modalCancel");
const modalConfirm = document.getElementById("modalConfirm");

let dockerfileValid = false;
let pendingAction = null;

function showMessage(text, type = "info") {
    message.textContent = text;
    message.className = `message ${type}`;
}

function setDockerStatus(text, type = "") {
    dockerStatus.textContent = text;
    dockerStatus.className = `docker-status ${type}`;
}

function resetDockerCheck() {
    dockerfileValid = false;
    registerBtn.disabled = true;
    setDockerStatus("Dockerfile not checked");
    portStatus.textContent = "Port not detected";
    portStatus.className = "port-status";
}

function escapeHtml(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function openConfirm(title, text, action) {
    modalTitle.textContent = title;
    modalText.textContent = text;
    pendingAction = action;
    confirmModal.classList.remove("hidden");
}

function closeConfirm() {
    pendingAction = null;
    confirmModal.classList.add("hidden");
}

modalCancel.addEventListener("click", closeConfirm);

modalConfirm.addEventListener("click", async () => {
    if (!pendingAction) return;

    const action = pendingAction;
    closeConfirm();
    await action();
});

async function loadRepositories() {
    try {
        const response = await fetch("/api/repos");
        const repos = await response.json();

        if (!response.ok) {
            throw new Error(repos.error || "Failed to load repositories");
        }

        repoSelect.innerHTML = `<option value="">Select repository</option>`;

        repos.forEach((repo) => {
            const option = document.createElement("option");
            option.value = repo.full_name;
            option.textContent = repo.full_name;
            option.dataset.defaultBranch = repo.default_branch || "main";
            repoSelect.appendChild(option);
        });
    } catch (error) {
        showMessage(error.message, "error");
    }
}

repoSelect.addEventListener("change", () => {
    resetDockerCheck();

    const selected = repoSelect.options[repoSelect.selectedIndex];
    branchInput.value = selected?.dataset.defaultBranch || "main";
});

async function checkDockerfile() {
    const repository = repoSelect.value;
    const branch = branchInput.value.trim();

    if (!repository) {
        showMessage("Select a repository first.", "error");
        return;
    }

    checkDockerBtn.disabled = true;
    setDockerStatus("Checking Dockerfile...");

    try {
        const response = await fetch(
            `/api/inspect?repository=${encodeURIComponent(repository)}&branch=${encodeURIComponent(branch)}`
        );
        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Dockerfile check failed");
        }

        if (!result.dockerfile) {
            dockerfileValid = false;
            registerBtn.disabled = true;
            setDockerStatus("Dockerfile not found", "error");
            showMessage("This repository does not contain a Dockerfile.", "error");
            return;
        }

        dockerfileValid = true;
        registerBtn.disabled = false;
        setDockerStatus("Dockerfile found", "success");

        if (result.detectedPort?.port) {
            appPortInput.value = result.detectedPort.port;
            portStatus.textContent = `Detected ${result.detectedPort.port} from ${result.detectedPort.source}.`;
            portStatus.className = "port-status success";
        }

        showMessage("Repository is ready for deployment.", "success");
    } catch (error) {
        dockerfileValid = false;
        registerBtn.disabled = true;
        setDockerStatus(error.message, "error");
        showMessage(error.message, "error");
    } finally {
        checkDockerBtn.disabled = false;
    }
}

checkDockerBtn.addEventListener("click", checkDockerfile);

async function fetchApplicationPort() {
    const repository = repoSelect.value;
    const branch = branchInput.value.trim();

    if (!repository) {
        showMessage("Select a repository first.", "error");
        return;
    }

    if (!branch) {
        showMessage("Enter a branch name.", "error");
        return;
    }

    fetchPortBtn.disabled = true;
    portStatus.textContent = "Detecting...";
    portStatus.className = "port-status loading";

    try {
        const response = await fetch(
            `/api/detect-port?repository=${encodeURIComponent(repository)}&branch=${encodeURIComponent(branch)}`
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Could not detect application port");
        }

        appPortInput.value = result.port;
        portStatus.textContent = `Detected ${result.port} from ${result.source}.`;
        portStatus.className = "port-status success";
        showMessage(`Application port detected: ${result.port}.`, "success");
    } catch (error) {
        appPortInput.value = "";
        portStatus.textContent = "Port could not be detected";
        portStatus.className = "port-status error";
        showMessage(error.message, "error");
    } finally {
        fetchPortBtn.disabled = false;
    }
}

fetchPortBtn.addEventListener("click", fetchApplicationPort);

registerBtn.addEventListener("click", async () => {
    const repository = repoSelect.value;
    const branch = branchInput.value.trim();
    const appPort = Number(appPortInput.value);

    if (!dockerfileValid) {
        showMessage("Check the Dockerfile before registering.", "error");
        return;
    }

    if (!Number.isInteger(appPort) || appPort < 1 || appPort > 65535) {
        showMessage("Enter a valid application port.", "error");
        return;
    }

    registerBtn.disabled = true;
    showMessage("Registering repository...");

    try {
        const response = await fetch("/api/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                repository,
                branch,
                appPort
            })
        });

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Registration failed");
        }

        showMessage(
            `Repository registered successfully on host port ${result.hostPort}.`,
            "success"
        );

        repoSelect.value = "";
        branchInput.value = "main";
        appPortInput.value = "";
        resetDockerCheck();
        await loadDeployments();
    } catch (error) {
        showMessage(error.message, "error");
    } finally {
        registerBtn.disabled = !dockerfileValid;
    }
});

function statusLabel(deployment) {
    const state = deployment.runtimeState;

    // Runtime state is authoritative once a container exists.
    if (state === "running") return "Running";
    if (deployment.status === "stopping") return "Stopping";
    if (deployment.status === "deregistering") return "Removing";
    if (deployment.status === "deploying" || deployment.status === "deployment-triggered") return "Deploying";
    if (deployment.status === "start-failed" || deployment.status === "dispatch-failed") return "Start failed";
    if (deployment.status === "stop-failed") return "Stop failed";
    if (state === "stopped" || state === "not-deployed") return "Stopped";
    if (state === "docker-unavailable") return "Docker unavailable";
    if (state === "unknown") return "Unknown";
    return deployment.status || "Stopped";
}

function statusClass(deployment) {
    const state = deployment.runtimeState;
    if (state === "running") return "running";
    if (state === "stopped" || state === "not-deployed") return "stopped";
    if (deployment.status === "deploying" || deployment.status === "deployment-triggered") return "pending";
    return "unknown";
}

function actionButtons(deployment) {
    const repository = encodeURIComponent(deployment.repository);
    const state = deployment.runtimeState;

    if (deployment.status === "stopping" || deployment.status === "deregistering") {
        return `<button class="button small secondary" disabled>Working...</button>`;
    }

    // Never show Deploying once Docker reports the container is running.
    if (state === "running") {
        return `
            <button
                class="button small danger"
                data-action="stop"
                data-repository="${repository}"
            >Stop</button>
        `;
    }

    if (deployment.status === "deploying" || deployment.status === "deployment-triggered") {
        return `<button class="button small secondary" disabled>Deploying...</button>`;
    }

    if (state === "not-deployed") {
        return `
            <button
                class="button small primary"
                data-action="start"
                data-repository="${repository}"
            >Start</button>
        `;
    }

    if (state === "stopped") {
        return `
            <button
                class="button small primary"
                data-action="start"
                data-repository="${repository}"
            >Start</button>
            <button
                class="button small danger"
                data-action="deregister"
                data-repository="${repository}"
            >Deregister</button>
        `;
    }

    if (state === "docker-unavailable") {
        return `<button class="button small secondary" disabled>Docker unavailable</button>`;
    }

    return `<button class="button small secondary" disabled>Unavailable</button>`;
}

async function loadDeployments() {
    try {
        const response = await fetch("/api/deployments");
        const deployments = await response.json();

        if (!response.ok) {
            throw new Error(deployments.error || "Failed to load deployments");
        }

        deploymentsBody.innerHTML = "";

        if (!deployments.length) {
            deploymentsBody.innerHTML = `
                <tr>
                    <td colspan="6" class="empty-cell">No repositories registered yet.</td>
                </tr>
            `;
            return;
        }

        deployments.forEach((deployment) => {
            const row = document.createElement("tr");

            row.innerHTML = `
                <td class="repo-name">${escapeHtml(deployment.repository)}</td>
                <td>${escapeHtml(deployment.branch)}</td>
                <td>${deployment.appPort}</td>
                <td>localhost:${deployment.hostPort}</td>
                <td>
                    <span class="status-badge ${statusClass(deployment)}">
                        <span class="status-dot"></span>
                        ${escapeHtml(statusLabel(deployment))}
                    </span>
                </td>
                <td class="action-cell">
                    ${actionButtons(deployment)}
                </td>
            `;

            deploymentsBody.appendChild(row);
        });
    } catch (error) {
        deploymentsBody.innerHTML = `
            <tr>
                <td colspan="6" class="empty-cell">${escapeHtml(error.message)}</td>
            </tr>
        `;
    }
}

deploymentsBody.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;

    const repository = decodeURIComponent(button.dataset.repository);
    const action = button.dataset.action;

    if (action === "start") {
        startRepository(repository);
    }

    if (action === "stop") {
        openConfirm(
            "Stop repository?",
            `Stop the running container for ${repository}? Future pushes will not redeploy it while it remains stopped.`,
            () => stopRepository(repository)
        );
    }

    if (action === "deregister") {
        openConfirm(
            "Deregister repository?",
            `This removes ${repository} from Cenfra and deletes its GitHub webhook. This action cannot be undone from Cenfra.`,
            () => deregisterRepository(repository)
        );
    }
});

async function startRepository(repository) {
    showMessage(`Starting ${repository}...`);

    try {
        const response = await fetch(
            `/api/deployments/${encodeURIComponent(repository)}/start`,
            { method: "POST" }
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Failed to start repository");
        }

        showMessage(
            `${repository} deployment triggered. Waiting for the runner...`,
            "success"
        );

        await loadDeployments();
    } catch (error) {
        showMessage(error.message, "error");
        await loadDeployments();
    }
}

async function stopRepository(repository) {
    showMessage(`Stopping ${repository}...`);

    try {
        const response = await fetch(
            `/api/deployments/${encodeURIComponent(repository)}/stop`,
            { method: "POST" }
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Failed to stop repository");
        }

        showMessage(`${repository} is now stopped.`, "success");
        await loadDeployments();
    } catch (error) {
        showMessage(error.message, "error");
        await loadDeployments();
    }
}

async function deregisterRepository(repository) {
    showMessage(`Deregistering ${repository}...`);

    try {
        const response = await fetch(
            `/api/deployments/${encodeURIComponent(repository)}`,
            { method: "DELETE" }
        );

        const result = await response.json();

        if (!response.ok) {
            throw new Error(result.error || "Failed to deregister repository");
        }

        showMessage(`${repository} was deregistered.`, "success");
        await loadDeployments();
        await loadRepositories();
    } catch (error) {
        showMessage(error.message, "error");
        await loadDeployments();
    }
}

async function refresh() {
    await loadDeployments();
}

window.addEventListener("focus", refresh);

setInterval(refresh, 5000);

(async () => {
    resetDockerCheck();
    await loadRepositories();
    await loadDeployments();
})();
