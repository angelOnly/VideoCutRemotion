export const DEFAULT_VOICE_WORKFLOW_ID: string;
export function configureDefaultVoice(input: { workflowPath: string; inputRoot: string; outputDirectory: string }): Promise<{ workflowId: string; reference: string; outputDirectory: string }>;
