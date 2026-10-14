export interface SkillFile { source: string; target: string; }
export interface SkillManifest {
  schemaVersion: number;
  retainedSkills: string[];
  excludedSkills: string[];
  excludedHistoricalCases: string[];
  renderFiles: SkillFile[];
  analysisFiles: SkillFile[];
}
export function readSkillManifest(repoRoot: string): Promise<{ root: string; manifest: SkillManifest }>;
export function listFiles(root: string, base?: string): Promise<string[]>;
export function verifySkillView(root: string, sourceRoot: string, files: SkillFile[]): Promise<void>;
