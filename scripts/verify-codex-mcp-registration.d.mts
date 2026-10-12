export interface McpRegistrationOptions {
  installedPluginRoot: string;
  repoRoot: string;
  mcpSpec: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    startup_timeout_sec: number;
    tool_timeout_sec: number;
  };
}

export interface McpRegistrationEvidence {
  hostRegistrationVerified: true;
  launcher: string;
  desktopConnectionVerified: false;
}

export function assertCodexMcpRegistration(registration: unknown, options: McpRegistrationOptions): McpRegistrationEvidence;
export function verifyCodexMcpRegistration(args: string[]): McpRegistrationEvidence & {
  installedReleaseVerified: boolean;
  releaseId: string;
  pendingVerification: string;
};
