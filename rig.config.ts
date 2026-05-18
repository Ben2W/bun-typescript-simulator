import { workflow } from "@rigkit/sdk";
import { cmux } from "@rigkit/provider-cmux";
import { freestyle, type FreestyleRuntime, VmBaseImage, VmSpec } from "@rigkit/provider-freestyle";

const projectName = "bun-typescript-simulator";
const repoPath = `/workspace/${projectName}`;
const repoUrl = process.env.BUN_TS_SIM_REPO_URL ?? "https://github.com/Ben2W/bun-typescript-simulator.git";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

type WorkspaceContext = {
  vmId: string;
  repoPath: string;
  repoUrl: string;
};

function ensureWorkspaceCommand(workspace: Pick<WorkspaceContext, "repoPath" | "repoUrl">): string {
  const quotedRepoPath = shellQuote(workspace.repoPath);
  const quotedRepoUrl = shellQuote(workspace.repoUrl);

  return `
    set -e
    mkdir -p /workspace
    if [ ! -d ${quotedRepoPath}/.git ]; then
      git clone ${quotedRepoUrl} ${quotedRepoPath}
    fi
    cd ${quotedRepoPath}
  `;
}

async function ensureWorkspaceCheckout(freestyleRuntime: FreestyleRuntime, workspace: WorkspaceContext): Promise<void> {
  const vm = freestyleRuntime.client.vms.ref({ vmId: workspace.vmId });
  const result = await vm.exec({
    command: ensureWorkspaceCommand(workspace),
    timeoutMs: 180_000,
  });

  if ((result.statusCode ?? 0) !== 0) {
    throw new Error(
      [
        `Failed to prepare ${workspace.repoPath} in ${workspace.vmId}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

const vmSpec = new VmSpec()
  .baseImage(new VmBaseImage("FROM node:22-bookworm"))
  .memSizeGb(16)
  .vcpuCount(4)
  .rootfsSizeGb(64)
  .idleTimeoutSeconds(3600).runCommands(`
    set -eux
    apt-get update
    apt-get install -y --no-install-recommends \
      ca-certificates \
      clang \
      cmake \
      curl \
      g++ \
      git \
      gpg \
      jq \
      make \
      ninja-build \
      pkg-config \
      python3 \
      python3-pip \
      ripgrep \
      unzip \
      xz-utils
    mkdir -p -m 755 /etc/apt/keyrings
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    apt-get update
    apt-get install -y --no-install-recommends gh
    rm -rf /var/lib/apt/lists/*
    corepack enable
    curl -fsSL https://bun.sh/install | bash
  `);

const app = workflow(projectName, {
  providers: {
    cmux: cmux.provider(),
    freestyle: freestyle.provider(),
    terminal: freestyle.terminal(),
  },
});

export default app
  .sequence(projectName)
  .task("prepare-image", async ({ freestyle }) => {
    const { vm, vmId } = await freestyle.client.vms.create({
      spec: vmSpec,
      logger: console.log,
    });

    try {
      const snapshot = await vm.snapshot();
      return {
        ctx: {
          snapshotId: snapshot.snapshotId,
          repoPath,
          repoUrl,
        },
      };
    } finally {
      await freestyle.client.vms.delete({ vmId });
    }
  })
  .task("github-auth", async ({ freestyle, terminal, step }) => {
    const { vm, vmId } = await freestyle.client.vms.create({
      snapshotId: step.ctx.snapshotId,
      logger: console.log,
    });

    try {
      await terminal.open("GitHub CLI auth", {
        ssh: await freestyle.createSSHOptions({ vmId }),
        command: `
          set -e
          if ! gh auth status --hostname github.com >/dev/null 2>&1; then
            gh auth login --hostname github.com --git-protocol https --web
          fi
          gh auth setup-git --hostname github.com
          gh auth status --hostname github.com
        `,
        keepOpenAfterCommand: true,
        instructions: "Complete GitHub CLI auth, then type exit.",
      });

      const snapshot = await vm.snapshot();
      return {
        ctx: {
          ...step.ctx,
          snapshotId: snapshot.snapshotId,
        },
      };
    } finally {
      await freestyle.client.vms.delete({ vmId });
    }
  })
  .workspace({
    create: async ({ workflow, providers, workspace }) => {
      const { vmId } = await providers.freestyle.client.vms.create({
        snapshotId: workflow.ctx.snapshotId,
        idleTimeoutSeconds: 3600,
        logger: console.log,
      });

      return {
        vmId,
        name: workspace.name,
        repoPath: workflow.ctx.repoPath,
        repoUrl: workflow.ctx.repoUrl,
      };
    },
    remove: async ({ providers, workspace }) => {
      await providers.freestyle.client.vms.delete({
        vmId: workspace.ctx.vmId,
      });
    },
  })
  .workspaceOperation("ssh", {
    title: "SSH",
    description: "Open a shell in the Bun TypeScript simulator workspace",
    run: async ({ providers, workspace }) => {
      await providers.terminal.open(`SSH ${workspace.name}`, {
        ssh: await providers.freestyle.createSSHOptions({
          vmId: workspace.ctx.vmId,
        }),
        command: `
          ${ensureWorkspaceCommand(workspace.ctx)}
          exec bash -l
        `,
        keepOpenAfterCommand: true,
        instructions: "Exit the SSH session when you are done.",
      });
    },
  })
  .workspaceOperation("open-cmux", {
    title: "Open cmux",
    description: "Open the workspace in cmux",
    run: async ({ providers, workspace }) => {
      await ensureWorkspaceCheckout(providers.freestyle, workspace.ctx);

      await providers.cmux.open({
        name: workspace.name,
        ssh: await providers.freestyle.cmux.createSshOptions({
          vmId: workspace.ctx.vmId,
        }),
        cwd: workspace.ctx.repoPath,
        surfaceLayout: "tabs",
        terminals: [{ command: "exec bash -l", focus: true }],
        focus: true,
        waitForRemoteReady: {
          timeoutMs: 90_000,
        },
      });
    },
  })
  .workspaceOperation("open-vscode", {
    title: "Open VS Code",
    description: "Open the workspace in VS Code Remote SSH",
    run: async ({ providers, workspace, local }) => {
      await ensureWorkspaceCheckout(providers.freestyle, workspace.ctx);

      const url = await providers.freestyle.vscode.createUrl({
        vmId: workspace.ctx.vmId,
        cwd: workspace.ctx.repoPath,
      });
      await local.open(url);
    },
  })
  .workspaceOperation("status", {
    title: "Status",
    description: "Return workspace details",
    run: async ({ workspace }) => ({
      workspace: workspace.name,
      vmId: workspace.ctx.vmId,
      repoPath: workspace.ctx.repoPath,
      repoUrl: workspace.ctx.repoUrl,
    }),
  });
