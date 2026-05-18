import { workflow } from "@rigkit/sdk";
import { freestyle, VmBaseImage, VmSpec } from "@rigkit/provider-freestyle";

const projectName = "bun-typescript-simulator";
const repoPath = `/workspace/${projectName}`;
const repoUrl = process.env.BUN_TS_SIM_REPO_URL ?? "https://github.com/oven-sh/bun.git";

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

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
      jq \
      make \
      ninja-build \
      pkg-config \
      python3 \
      python3-pip \
      ripgrep \
      unzip \
      xz-utils
    rm -rf /var/lib/apt/lists/*
    corepack enable
    curl -fsSL https://bun.sh/install | bash
  `);

const app = workflow(projectName, {
  providers: {
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
      const quotedRepoPath = shellQuote(workspace.ctx.repoPath);
      const quotedRepoUrl = shellQuote(workspace.ctx.repoUrl);

      await providers.terminal.open(`SSH ${workspace.name}`, {
        ssh: await providers.freestyle.createSSHOptions({
          vmId: workspace.ctx.vmId,
        }),
        command: `
          set -e
          mkdir -p /workspace
          if [ ! -d ${quotedRepoPath}/.git ]; then
            git clone ${quotedRepoUrl} ${quotedRepoPath}
          fi
          cd ${quotedRepoPath}
          exec bash -l
        `,
        keepOpenAfterCommand: true,
        instructions: "Exit the SSH session when you are done.",
      });
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
