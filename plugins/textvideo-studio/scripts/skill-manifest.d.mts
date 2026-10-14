export interface SkillFile { source: string; target: string; }
export interface SkillRole {
  entries: string[];
  references: string[];
  conditionalReferences?: string[];
}
export type SkillRoleName = 'coordinator' | 'director' | 'visual' | 'audio' | 'reviewer';
export interface SkillManifest {
  schemaVersion: 2;
  sourceRoot: '.agents/skills';
  retainedSkills: string[];
  excludedSkills: string[];
  excludedHistoricalCases: string[];
  renderFiles: SkillFile[];
  analysisFiles: SkillFile[];
  professionalSources: string[];
  roles: Record<SkillRoleName, SkillRole>;
}
export function readSkillManifest(repoRoot: string): Promise<{ root: string; templateRoot: string; manifest: SkillManifest }>;
export function listFiles(root: string, base?: string): Promise<string[]>;
export function verifySkillView(root: string, sourceRoot: string, files: SkillFile[]): Promise<void>;
