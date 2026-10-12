import { explicitCreativePreferencesSchema } from "../../../contracts/src/creative-preferences.js";
import { bindMotionFonts } from "../../../motion-work/src/fonts.js";
import { reconcileSoundDesign } from "../sound-design.js";
import { mkdirSync } from "node:fs";
import { reconcileMotionDependencies } from "../motion-dependencies.js";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MediaIntelligenceStore } from "../../../media-intelligence/src/store.js";
import type {
  CaptionCard,
  CreativeBrief,
  ExplicitCreativePreferences,
  ExportArtifact,
  Id,
  ImpactReport,
  JobKind,
  JobRecord,
  JobStatus,
  RepairTicket,
  RepairTicketStatus,
  ProjectSnapshot,
  ProjectSummary,
  RevisionRecord,
  SourceAudioAlignment
} from "@videocut/contracts";
import {
  assertProjectGraphValid,
  assertTimelineValid,
  cloneSnapshot,
  createId,
  createProjectSnapshot,
  DomainError,
  emptyImpact,
  sourceAudioAlignmentOwnerMatches,
  now
} from "@videocut/domain";
import { normalizeSnapshot } from "./normalize-snapshot";
import { reconcileEffectAudioEvents } from "../effect-audio-events.js";
import { projectFrameRateChange } from "../../../edit-domain/src/frame-rate-change.js";
import { projectFrameRateSchema } from "../../../contracts/src/frame-rate.js";
import { initializeProjectDatabase } from "./schema";
import { NotFoundError, RevisionConflictError, type ProjectState } from "./types";

type ProjectRow = {
  id: string;
  name: string;
  profile: string;
  root_path: string;
  current_revision_id: string;
  current_revision_number: number;
  created_at: string;
  updated_at: string;
};

type RevisionRow = {
  id: string;
  project_id: string;
  revision_number: number;
  parent_id: string | null;
  summary: string;
  snapshot_json: string;
  impact_json: string;
  created_at: string;
};

/** Revision 列表只显示历史摘要；不要为此反序列化每个可能很大的项目快照。 */
type RevisionSummaryRow = Pick<RevisionRow, "id" | "revision_number" | "summary" | "impact_json" | "created_at">;

type JobRow = {
  id: string;
  project_id: string;
  kind: JobKind;
  status: JobStatus;
  payload_json: string;
  result_json: string | null;
  error: string | null;
  idempotency_key: string;
  attempt: number;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
};

type ExportArtifactRow = {
  id: Id;
  project_id: Id;
  revision_number: number;
  job_id: Id;
  artifact_json: string;
  created_at: string;
};

type RepairTicketRow = {
  id: Id;
  project_id: Id;
  reported_revision: number;
  category: RepairTicket["category"];
  summary: string;
  detail: string | null;
  tool_name: string | null;
  job_id: Id | null;
  reporter_id: string;
  reported_release_id: string;
  idempotency_key: string;
  status: RepairTicketStatus;
  repairer_id: string | null;
  released_by: string | null;
  release_reason: string | null;
  candidate_release_id: string | null;
  validation_summary: string | null;
  deployed_release_id: string | null;
  deployment_evidence: string | null;
  acknowledged_by: string | null;
  acknowledged_release_id: string | null;
  acknowledged_revision: number | null;
  created_at: string;
  updated_at: string;
};

/** 对齐证据的来源一旦变化，旧 token 时间就不能继续驱动字幕卡。 */
function sourceAudioAlignmentIsCurrent(snapshot: ProjectSnapshot, alignment: SourceAudioAlignment): boolean {
  const item = snapshot.timeline.items.find((candidate) => candidate.id === alignment.sourceTimelineItemId);
  const asset = snapshot.assets.find((candidate) => candidate.id === alignment.sourceAssetId);
  return Boolean(item && asset && sourceAudioAlignmentOwnerMatches(snapshot, alignment)
    && !item.disabled && item.assetId === asset.id
    && asset.status === "ready" && asset.metadata?.hasAudio
    && asset.sourceHash === alignment.sourceAssetHash
    && item.sourceStartFrame === alignment.sourceStartFrame && item.sourceEndFrame === alignment.sourceEndFrame
    && item.startFrame === alignment.timelineStartFrame && item.endFrame === alignment.timelineEndFrame
    && item.sourceEndFrame - item.sourceStartFrame === item.endFrame - item.startFrame);
}

/** 原声卡的物理来源改变时不能保留旧坐标；其余结构损坏仍交给 Graph 显式报错。 */
function sourceAudioCaptionMappingIsStale(snapshot: ProjectSnapshot, caption: CaptionCard): boolean {
  if (caption.sourceKind !== "source_audio"
    || !caption.sourceAssetId || !caption.sourceTimelineItemId
    || caption.sourceStartFrame === undefined || caption.sourceEndFrame === undefined) return false;
  const item = snapshot.timeline.items.find((candidate) => candidate.id === caption.sourceTimelineItemId);
  if (!item) return true;
  return item.disabled || item.assetId !== caption.sourceAssetId
    || caption.sourceStartFrame < item.sourceStartFrame || caption.sourceEndFrame > item.sourceEndFrame
    || caption.sourceEndFrame <= caption.sourceStartFrame
    || caption.startFrame !== item.startFrame + (caption.sourceStartFrame - item.sourceStartFrame)
    || caption.endFrame !== item.startFrame + (caption.sourceEndFrame - item.sourceStartFrame);
}

function pushUnique(target: string[], values: string[]): void {
  const existing = new Set(target);
  for (const value of values) {
    if (!existing.has(value)) {
      target.push(value);
      existing.add(value);
    }
  }
}

/**
 * 所有写入都经过 Repository，因此在提交 Graph 前统一让失去来源的 token 对齐失效。
 * 这不是静默修补：保留 Alignment 审计、记录 Impact，并移除无法再正确显示的 Program/Card，
 * 迫使后续流程基于新 A-roll 重新对齐和审片，而不是让旧字幕跟着错误画面继续播放。
 */
function reconcileStaleSourceAudioArtifacts(snapshot: ProjectSnapshot, impact: ImpactReport): void {
  const alignments = snapshot.sourceAudioAlignments ?? [];
  const staleAlignmentIds = new Set(alignments.filter((alignment) => alignment.status === "stale").map((alignment) => alignment.id));
  const newlyStaleAlignmentIds: string[] = [];
  for (const alignment of alignments) {
    if (alignment.status === "ready" && !sourceAudioAlignmentIsCurrent(snapshot, alignment)) {
      alignment.status = "stale";
      staleAlignmentIds.add(alignment.id);
      newlyStaleAlignmentIds.push(alignment.id);
    }
  }
  const stalePrograms = (snapshot.sourceCaptionPrograms ?? []).filter((program) => staleAlignmentIds.has(program.alignmentId));
  const staleProgramIds = new Set(stalePrograms.map((program) => program.id));
  if (stalePrograms.length > 0) {
    snapshot.sourceCaptionPrograms = snapshot.sourceCaptionPrograms.filter((program) => !staleProgramIds.has(program.id));
  }
  const removedCaptions = snapshot.timeline.captions.filter((caption) => caption.sourceKind === "source_audio" && (
    sourceAudioCaptionMappingIsStale(snapshot, caption)
    || (caption.sourceAlignmentId !== undefined && staleAlignmentIds.has(caption.sourceAlignmentId))
    || (caption.sourceCaptionProgramId !== undefined && staleProgramIds.has(caption.sourceCaptionProgramId))
  ));
  if (removedCaptions.length > 0) {
    const removedCaptionIds = new Set(removedCaptions.map((caption) => caption.id));
    snapshot.timeline.captions = snapshot.timeline.captions.filter((caption) => !removedCaptionIds.has(caption.id));
    for (const caption of removedCaptions) {
      if (caption.startFrame >= 0 && caption.endFrame > caption.startFrame) {
        impact.dirtyRanges.push({ startFrame: caption.startFrame, endFrame: caption.endFrame, reason: "原声字幕来源或 token 对齐已过期" });
      }
    }
  }
  if (newlyStaleAlignmentIds.length > 0 || stalePrograms.length > 0 || removedCaptions.length > 0) {
    pushUnique(impact.stale, [...newlyStaleAlignmentIds, ...stalePrograms.map((program) => program.id), ...removedCaptions.map((caption) => caption.id)]);
    pushUnique(impact.changed, [...newlyStaleAlignmentIds, ...stalePrograms.map((program) => program.id), ...removedCaptions.map((caption) => caption.id)]);
    if (!impact.recomputed.includes("原声 token 对齐/语义字幕因 A-roll 变化失效")) {
      impact.recomputed.push("原声 token 对齐/语义字幕因 A-roll 变化失效");
    }
  }
}

/**
 * SQLite 只保存不可变 Revision 快照与任务状态；任何编辑写入都通过此仓储提交，
 * 防止 Web、MCP 和 Worker 各自维护一份 Timeline。
 */
export class ProjectRepository {
  private readonly db: DatabaseSync;
  readonly mediaIntelligence: MediaIntelligenceStore;

  constructor(public readonly workspaceRoot: string) {
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(join(workspaceRoot, "projects"), { recursive: true });
    this.db = new DatabaseSync(join(workspaceRoot, "app.sqlite"));
    // Server 与独立 Worker 会同时访问同一份 SQLite；短暂等待可避免正常事务互相误判为失败。
    initializeProjectDatabase(this.db);
    this.mediaIntelligence = new MediaIntelligenceStore(this.db);
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private revisionFromRow(row: RevisionRow): RevisionRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      number: row.revision_number,
      parentId: row.parent_id ?? undefined,
      summary: row.summary,
      snapshot: normalizeSnapshot(JSON.parse(row.snapshot_json) as ProjectSnapshot),
      impact: JSON.parse(row.impact_json) as ImpactReport,
      createdAt: row.created_at
    };
  }

  private jobFromRow(row: JobRow): JobRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      kind: row.kind,
      status: row.status,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      result: row.result_json ? (JSON.parse(row.result_json) as Record<string, unknown>) : undefined,
      error: row.error ?? undefined,
      idempotencyKey: row.idempotency_key,
      attempt: row.attempt,
      leaseUntil: row.lease_until ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private exportArtifactFromRow(row: ExportArtifactRow): ExportArtifact {
    const artifact = JSON.parse(row.artifact_json) as ExportArtifact;
    if (artifact.id !== row.id || artifact.projectId !== row.project_id || artifact.revision !== row.revision_number || artifact.jobId !== row.job_id) {
      throw new DomainError("ExportArtifact 持久化记录不一致", "EXPORT_ARTIFACT_CORRUPTED");
    }
    return artifact;
  }

  /** 修复工单独立于视频快照，读取时仍完整保留每次角色交接与发行版本证据。 */
  private repairTicketFromRow(row: RepairTicketRow): RepairTicket {
    return {
      id: row.id,
      projectId: row.project_id,
      reportedRevision: row.reported_revision,
      category: row.category,
      summary: row.summary,
      detail: row.detail ?? undefined,
      toolName: row.tool_name ?? undefined,
      jobId: row.job_id ?? undefined,
      reporterId: row.reporter_id,
      reportedReleaseId: row.reported_release_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      repairerId: row.repairer_id ?? undefined,
      releasedBy: row.released_by ?? undefined,
      releaseReason: row.status === "resolved_without_deployment" ? undefined : row.release_reason ?? undefined,
      candidateReleaseId: row.candidate_release_id ?? undefined,
      validationSummary: row.status === "resolved_without_deployment" ? undefined : row.validation_summary ?? undefined,
      deployedReleaseId: row.deployed_release_id ?? undefined,
      deploymentEvidence: row.deployment_evidence ?? undefined,
      acknowledgedBy: row.acknowledged_by ?? undefined,
      acknowledgedReleaseId: row.acknowledged_release_id ?? undefined,
      acknowledgedRevision: row.acknowledged_revision ?? undefined,
      ...(row.status === "resolved_without_deployment" ? {
        resolutionKind: row.release_reason as RepairTicket["resolutionKind"],
        resolutionEvidence: row.validation_summary ?? undefined
      } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  readCreativeDefaults(): ExplicitCreativePreferences {
    const row = this.db.prepare("SELECT value_json FROM workspace_settings WHERE key = ?").get("creative_defaults") as { value_json: string } | undefined;
    return row ? explicitCreativePreferencesSchema.parse(JSON.parse(row.value_json)) : {};
  }

  saveCreativeDefaults(value: ExplicitCreativePreferences): ExplicitCreativePreferences {
    const preferences = explicitCreativePreferencesSchema.parse(value);
    // 单次原子替换只改变工作台设置，绝不扫描或回写已有项目与 Job。
    this.db.prepare("INSERT INTO workspace_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
      .run("creative_defaults", JSON.stringify(preferences));
    return preferences;
  }

  createProject(input: {
    name: string;
    profile?: ProjectSnapshot["project"]["profile"];
    brief?: Partial<CreativeBrief>;
    fps?: number;
  }): ProjectState {
    if (!projectFrameRateSchema.safeParse(input.fps ?? 24).success) throw new DomainError("项目帧率必须是15至60的整数", "PROJECT_FPS_INVALID");
    const projectId = createId("project");
    const rootPath = join(this.workspaceRoot, "projects", projectId);
    for (const directory of ["assets/source", "assets/proxy", "assets/voice-reference", "assets/speech", "assets/actor", "assets/derived", "previews", "exports", "cache", "reports"]) {
      mkdirSync(join(rootPath, directory), { recursive: true });
    }
    const snapshot = createProjectSnapshot({ projectId, rootPath, name: input.name, profile: input.profile, brief: input.brief, fps: input.fps });
    // 新项目使用发行字体原件；文件身份随首个 Revision 固定，预览与导出不依赖系统字体。
    const { slot: _captionSlot, ...captionFont } = bindMotionFonts({ fontBindings: { caption: "noto-sans-sc-bold" } })[0]!;
    snapshot.timeline.captionFormat = { ...snapshot.timeline.captionFormat!, fontId: captionFont.fontId, font: captionFont, fontWeight: captionFont.weight };
    const revision: RevisionRecord = {
      id: createId("revision"),
      projectId,
      number: 1,
      summary: "创建项目",
      snapshot,
      impact: emptyImpact(),
      createdAt: now()
    };
    this.transaction(() => {
      this.db.prepare(`INSERT INTO projects (id, name, profile, root_path, current_revision_id, current_revision_number, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(projectId, input.name, snapshot.project.profile, rootPath, revision.id, revision.number, revision.createdAt, revision.createdAt);
      this.insertRevision(revision);
    });
    return { revision, snapshot };
  }

  private insertRevision(revision: RevisionRecord): void {
    this.db.prepare(`INSERT INTO revisions (id, project_id, revision_number, parent_id, summary, snapshot_json, impact_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        revision.id,
        revision.projectId,
        revision.number,
        revision.parentId ?? null,
        revision.summary,
        JSON.stringify(revision.snapshot),
        JSON.stringify(revision.impact),
        revision.createdAt
      );
  }

  getProjectRow(projectId: Id): ProjectRow {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!row) throw new NotFoundError(`项目不存在：${projectId}`);
    return row;
  }

  getCurrent(projectId: Id): ProjectState {
    const project = this.getProjectRow(projectId);
    const row = this.db.prepare("SELECT * FROM revisions WHERE id = ?").get(project.current_revision_id) as RevisionRow | undefined;
    if (!row) throw new NotFoundError(`项目 ${projectId} 缺少当前 Revision`);
    const revision = this.revisionFromRow(row);
    return { revision, snapshot: revision.snapshot };
  }

  getRevision(projectId: Id, number: number): RevisionRecord {
    const row = this.db.prepare("SELECT * FROM revisions WHERE project_id = ? AND revision_number = ?").get(projectId, number) as RevisionRow | undefined;
    if (!row) throw new NotFoundError(`不存在 Revision ${number}`);
    return this.revisionFromRow(row);
  }

  listProjects(): ProjectSummary[] {
    const rows = this.db.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as ProjectRow[];
    return rows.map((row) => {
      const revisionRow = this.db.prepare("SELECT snapshot_json FROM revisions WHERE id = ?").get(row.current_revision_id) as { snapshot_json: string };
      const snapshot = normalizeSnapshot(JSON.parse(revisionRow.snapshot_json) as ProjectSnapshot);
      return {
        id: row.id,
        name: row.name,
        profile: row.profile as ProjectSnapshot["project"]["profile"],
        currentRevision: row.current_revision_number,
        updatedAt: row.updated_at,
        durationInFrames: snapshot.timeline.durationInFrames,
        assetCount: snapshot.assets.length
      };
    });
  }

  listRevisions(projectId: Id): Array<Pick<RevisionRecord, "id" | "number" | "summary" | "createdAt" | "impact">> {
    this.getProjectRow(projectId);
    const rows = this.db.prepare(`SELECT id, revision_number, summary, impact_json, created_at
      FROM revisions WHERE project_id = ? ORDER BY revision_number DESC`).all(projectId) as RevisionSummaryRow[];
    return rows.map((row) => ({
      id: row.id,
      number: row.revision_number,
      summary: row.summary,
      createdAt: row.created_at,
      impact: JSON.parse(row.impact_json) as ImpactReport
    }));
  }

  commit(projectId: Id, baseRevision: number, summary: string, mutate: (snapshot: ProjectSnapshot, impact: ImpactReport) => void): ProjectState {
    return this.transaction(() => {
      const current = this.getCurrent(projectId);
      if (current.revision.number !== baseRevision) {
        throw new RevisionConflictError(baseRevision, current.revision.number);
      }
      const snapshot = cloneSnapshot(current.snapshot);
      const impact = emptyImpact();
      mutate(snapshot, impact);
      if (snapshot.timeline.captionFormat) {
        // 生成、重建与局部纠错都继承同一规范，不重新保存每卡外观。
        for (const caption of snapshot.timeline.captions) { delete caption.format; delete caption.emphasis; }
      }
      // 只把完整、确定性的时间换算作为比较基准；其它内容变化仍走原失效检查。
      const timingReference = current.snapshot.timeline.fps === snapshot.timeline.fps ? current.snapshot : projectFrameRateChange(current.snapshot, snapshot.timeline.fps).snapshot;
      reconcileMotionDependencies(timingReference, snapshot, impact);
      reconcileEffectAudioEvents(snapshot, impact);
      reconcileSoundDesign(timingReference, snapshot, impact);
      reconcileStaleSourceAudioArtifacts(snapshot, impact);
      snapshot.project.updatedAt = now();
      assertTimelineValid(snapshot);
      assertProjectGraphValid(snapshot);
      const revision: RevisionRecord = {
        id: createId("revision"),
        projectId,
        number: current.revision.number + 1,
        parentId: current.revision.id,
        summary,
        snapshot,
        impact,
        createdAt: now()
      };
      this.insertRevision(revision);
      this.db.prepare(`UPDATE projects SET name = ?, profile = ?, current_revision_id = ?, current_revision_number = ?, updated_at = ? WHERE id = ?`)
        .run(snapshot.project.name, snapshot.project.profile, revision.id, revision.number, revision.createdAt, projectId);
      return { revision, snapshot };
    });
  }

  createJob(input: { projectId: Id; kind: JobKind; payload: Record<string, unknown>; idempotencyKey: string }): JobRecord {
    this.getProjectRow(input.projectId);
    const existing = this.db.prepare("SELECT * FROM jobs WHERE project_id = ? AND idempotency_key = ?").get(input.projectId, input.idempotencyKey) as JobRow | undefined;
    if (existing) return this.jobFromRow(existing);
    const createdAt = now();
    const job: JobRecord = {
      id: createId("job"),
      projectId: input.projectId,
      kind: input.kind,
      status: "queued",
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      attempt: 0,
      createdAt,
      updatedAt: createdAt
    };
    this.db.prepare(`INSERT INTO jobs (id, project_id, kind, status, payload_json, result_json, error, idempotency_key, attempt, lease_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, ?, ?)`)
      .run(job.id, job.projectId, job.kind, job.status, JSON.stringify(job.payload), job.idempotencyKey, job.attempt, job.createdAt, job.updatedAt);
    return job;
  }

  listJobs(projectId: Id): JobRecord[] {
    this.getProjectRow(projectId);
    const rows = this.db.prepare("SELECT * FROM jobs WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as JobRow[];
    return rows.map((row) => this.jobFromRow(row));
  }

  getJob(jobId: Id): JobRecord {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as JobRow | undefined;
    if (!row) throw new NotFoundError(`任务不存在：${jobId}`);
    return this.jobFromRow(row);
  }

  claimNextJob(kinds?: JobKind[], leaseMilliseconds = 60_000): JobRecord | undefined {
    return this.transaction(() => {
      const nowIso = now();
      const kindsClause = kinds?.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const parameters = kinds?.length ? [nowIso, ...kinds] : [nowIso];
      const row = this.db.prepare(`SELECT * FROM jobs WHERE (status = 'queued' OR (status = 'running' AND lease_until < ?)) ${kindsClause} ORDER BY created_at ASC LIMIT 1`).get(...parameters) as JobRow | undefined;
      if (!row) return undefined;
      const leaseUntil = new Date(Date.now() + leaseMilliseconds).toISOString();
      const updatedAt = now();
      this.db.prepare("UPDATE jobs SET status = 'running', attempt = attempt + 1, lease_until = ?, updated_at = ? WHERE id = ?")
        .run(leaseUntil, updatedAt, row.id);
      return this.getJob(row.id);
    });
  }

  renewJobLease(jobId: Id, leaseMilliseconds = 60_000): JobRecord {
    const job = this.getJob(jobId);
    if (job.status !== "running") {
      throw new DomainError(`任务 ${jobId} 当前不是运行状态，不能续租`, "JOB_NOT_RUNNING");
    }
    const leaseUntil = new Date(Date.now() + leaseMilliseconds).toISOString();
    this.db.prepare("UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ?")
      .run(leaseUntil, now(), jobId);
    return this.getJob(jobId);
  }

  updateJob(jobId: Id, input: { status: JobStatus; result?: Record<string, unknown>; error?: string; leaseUntil?: string }): JobRecord {
    const old = this.getJob(jobId);
    // Worker 在运行中写入 Bridge 审计或恢复检查点时，不能意外清空已有租约；
    // 否则进程在该瞬间退出会留下永远无法重新领取的 running Job。
    const leaseUntil = input.leaseUntil ?? (input.status === "running" ? old.leaseUntil : undefined);
    this.db.prepare("UPDATE jobs SET status = ?, result_json = ?, error = ?, lease_until = ?, updated_at = ? WHERE id = ?")
      .run(input.status, input.result ? JSON.stringify(input.result) : old.result ? JSON.stringify(old.result) : null, input.error ?? null, leaseUntil ?? null, now(), jobId);
    return this.getJob(jobId);
  }

  createExportArtifact(artifact: ExportArtifact): ExportArtifact {
    this.getProjectRow(artifact.projectId);
    this.getRevision(artifact.projectId, artifact.revision);
    const job = this.getJob(artifact.jobId);
    const jobPurpose = job.payload.purpose === "draft" ? "draft" : "delivery";
    if (job.projectId !== artifact.projectId || job.kind !== "export" || Number(job.payload.revision) !== artifact.revision || jobPurpose !== artifact.purpose) {
      throw new DomainError("ExportArtifact 必须绑定同一项目的 Export Job", "EXPORT_ARTIFACT_JOB_MISMATCH");
    }
    const existing = this.db.prepare("SELECT * FROM export_artifacts WHERE project_id = ? AND job_id = ?")
      .get(artifact.projectId, artifact.jobId) as ExportArtifactRow | undefined;
    if (existing) return this.exportArtifactFromRow(existing);
    this.db.prepare(`INSERT INTO export_artifacts (id, project_id, revision_number, job_id, artifact_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(artifact.id, artifact.projectId, artifact.revision, artifact.jobId, JSON.stringify(artifact), artifact.createdAt);
    return artifact;
  }

  getExportArtifact(projectId: Id, artifactId: Id): ExportArtifact {
    this.getProjectRow(projectId);
    const row = this.db.prepare("SELECT * FROM export_artifacts WHERE id = ? AND project_id = ?")
      .get(artifactId, projectId) as ExportArtifactRow | undefined;
    if (!row) throw new NotFoundError(`导出产物不存在：${artifactId}`);
    return this.exportArtifactFromRow(row);
  }

  getExportArtifactForJob(projectId: Id, jobId: Id): ExportArtifact | undefined {
    this.getProjectRow(projectId);
    const row = this.db.prepare("SELECT * FROM export_artifacts WHERE project_id = ? AND job_id = ?")
      .get(projectId, jobId) as ExportArtifactRow | undefined;
    return row ? this.exportArtifactFromRow(row) : undefined;
  }

  listExportArtifacts(projectId: Id): ExportArtifact[] {
    this.getProjectRow(projectId);
    const rows = this.db.prepare("SELECT * FROM export_artifacts WHERE project_id = ? ORDER BY created_at DESC")
      .all(projectId) as ExportArtifactRow[];
    return rows.map((row) => this.exportArtifactFromRow(row));
  }

  /**
   * 新建阻断记录不会提交 Project Revision。视频项目只负责成片事实，
   * 协作协议保存在独立表，避免监测 Agent 与剪辑 Agent 产生无意义 Revision 冲突。
   */
  createRepairTicket(input: Omit<RepairTicket, "id" | "status" | "createdAt" | "updatedAt">): RepairTicket {
    this.getProjectRow(input.projectId);
    this.getRevision(input.projectId, input.reportedRevision);
    if (input.jobId) {
      const job = this.getJob(input.jobId);
      if (job.projectId !== input.projectId) throw new DomainError("修复工单关联的 Job 不属于当前项目", "REPAIR_TICKET_JOB_PROJECT_MISMATCH");
    }
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT * FROM repair_tickets
        WHERE project_id = ? AND reporter_id = ? AND idempotency_key = ?`)
        .get(input.projectId, input.reporterId, input.idempotencyKey) as RepairTicketRow | undefined;
      if (existing) return this.repairTicketFromRow(existing);
      const createdAt = now();
      const ticket: RepairTicket = {
        ...input,
        id: createId("repair_ticket"),
        status: "open",
        createdAt,
        updatedAt: createdAt
      };
      this.db.prepare(`INSERT INTO repair_tickets (
        id, project_id, reported_revision, category, summary, detail, tool_name, job_id,
        reporter_id, reported_release_id, idempotency_key, status, repairer_id, released_by,
        release_reason, candidate_release_id, validation_summary, deployed_release_id,
        deployment_evidence, acknowledged_by, acknowledged_release_id, acknowledged_revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`)
        .run(
          ticket.id, ticket.projectId, ticket.reportedRevision, ticket.category, ticket.summary,
          ticket.detail ?? null, ticket.toolName ?? null, ticket.jobId ?? null, ticket.reporterId,
          ticket.reportedReleaseId, ticket.idempotencyKey, ticket.status, ticket.createdAt, ticket.updatedAt
        );
      return ticket;
    });
  }

  getRepairTicket(ticketId: Id): RepairTicket {
    const row = this.db.prepare("SELECT * FROM repair_tickets WHERE id = ?").get(ticketId) as RepairTicketRow | undefined;
    if (!row) throw new NotFoundError(`修复工单不存在：${ticketId}`);
    return this.repairTicketFromRow(row);
  }

  listRepairTickets(input: { projectId?: Id; statuses?: RepairTicketStatus[] } = {}): RepairTicket[] {
    if (input.projectId) this.getProjectRow(input.projectId);
    const clauses: string[] = [];
    const parameters: Array<string> = [];
    if (input.projectId) {
      clauses.push("project_id = ?");
      parameters.push(input.projectId);
    }
    if (input.statuses?.length) {
      clauses.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
      parameters.push(...input.statuses);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`SELECT * FROM repair_tickets ${where} ORDER BY updated_at DESC`).all(...parameters) as RepairTicketRow[];
    return rows.map((row) => this.repairTicketFromRow(row));
  }

  claimRepairTicket(input: { ticketId: Id; repairerId: string }): RepairTicket {
    return this.transaction(() => {
      const ticket = this.getRepairTicket(input.ticketId);
      if (ticket.status !== "open") throw new DomainError("只有待处理的修复工单可以接手", "REPAIR_TICKET_NOT_OPEN");
      if (ticket.reporterId === input.repairerId) {
        throw new DomainError("报告剪辑 Agent 不能自行接手平台修复工单", "REPAIR_TICKET_ROLE_CONFLICT");
      }
      this.db.prepare(`UPDATE repair_tickets
        SET status = 'claimed', repairer_id = ?, released_by = NULL, release_reason = NULL, updated_at = ?
        WHERE id = ?`).run(input.repairerId, now(), input.ticketId);
      return this.getRepairTicket(input.ticketId);
    });
  }

  releaseRepairTicket(input: { ticketId: Id; repairerId: string; reason: string }): RepairTicket {
    return this.transaction(() => {
      const ticket = this.getRepairTicket(input.ticketId);
      if (ticket.status !== "claimed") throw new DomainError("只有已接手的修复工单可以释放", "REPAIR_TICKET_NOT_CLAIMED");
      if (ticket.repairerId !== input.repairerId) throw new DomainError("只有原接手修复 Agent 可以释放工单", "REPAIR_TICKET_CLAIMER_MISMATCH");
      this.db.prepare(`UPDATE repair_tickets
        SET status = 'open', repairer_id = NULL, released_by = ?, release_reason = ?, updated_at = ?
        WHERE id = ?`).run(input.repairerId, input.reason, now(), input.ticketId);
      return this.getRepairTicket(input.ticketId);
    });
  }

  /** 复用工单已有的原因和证据列，避免为了非部署收口改动生产表结构。 */
  resolveRepairTicketWithoutDeployment(input: { ticketId: Id; repairerId: string; kind: NonNullable<RepairTicket["resolutionKind"]>; evidence: string }): RepairTicket {
    return this.transaction(() => {
      const ticket = this.getRepairTicket(input.ticketId);
      if (ticket.status !== "claimed") throw new DomainError("只有已接手工单可按非部署原因收口", "REPAIR_TICKET_NOT_CLAIMED");
      if (ticket.repairerId !== input.repairerId) throw new DomainError("只有原接手修复 Agent 可以收口", "REPAIR_TICKET_CLAIMER_MISMATCH");
      this.db.prepare(`UPDATE repair_tickets SET status = 'resolved_without_deployment',
        release_reason = ?, validation_summary = ?, updated_at = ? WHERE id = ?`)
        .run(input.kind, input.evidence, now(), input.ticketId);
      return this.getRepairTicket(input.ticketId);
    });
  }

  markRepairTicketReadyForCutover(input: {
    ticketId: Id;
    repairerId: string;
    candidateReleaseId: string;
    validationSummary: string;
  }): RepairTicket {
    return this.transaction(() => {
      const ticket = this.getRepairTicket(input.ticketId);
      if (ticket.status !== "claimed") throw new DomainError("只有已接手的修复工单可以标记候选版本就绪", "REPAIR_TICKET_NOT_CLAIMED");
      if (ticket.repairerId !== input.repairerId) throw new DomainError("只有原接手修复 Agent 可以提交候选版本", "REPAIR_TICKET_CLAIMER_MISMATCH");
      this.db.prepare(`UPDATE repair_tickets
        SET status = 'ready_for_cutover', candidate_release_id = ?, validation_summary = ?, updated_at = ?
        WHERE id = ?`).run(input.candidateReleaseId, input.validationSummary, now(), input.ticketId);
      return this.getRepairTicket(input.ticketId);
    });
  }

  markRepairTicketDeployed(input: {
    ticketId: Id;
    repairerId: string;
    releaseId: string;
    deploymentEvidence: string;
  }): RepairTicket {
    return this.transaction(() => {
      const ticket = this.getRepairTicket(input.ticketId);
      if (ticket.status !== "ready_for_cutover") throw new DomainError("候选版本尚未就绪，不能记录部署", "REPAIR_TICKET_NOT_READY_FOR_CUTOVER");
      if (ticket.repairerId !== input.repairerId) throw new DomainError("只有原接手修复 Agent 可以记录部署", "REPAIR_TICKET_CLAIMER_MISMATCH");
      if (ticket.candidateReleaseId !== input.releaseId) throw new DomainError("已部署版本必须与已验证候选版本完全一致", "REPAIR_TICKET_RELEASE_MISMATCH");
      this.db.prepare(`UPDATE repair_tickets
        SET status = 'deployed', deployed_release_id = ?, deployment_evidence = ?, updated_at = ?
        WHERE id = ?`).run(input.releaseId, input.deploymentEvidence, now(), input.ticketId);
      return this.getRepairTicket(input.ticketId);
    });
  }

  acknowledgeRepairTicketDeployment(input: {
    ticketId: Id;
    editorId: string;
    releaseId: string;
    observedRevision: number;
  }): RepairTicket {
    return this.transaction(() => {
      const ticket = this.getRepairTicket(input.ticketId);
      if (ticket.status !== "deployed") throw new DomainError("只有已部署的修复工单可以由剪辑 Agent 确认", "REPAIR_TICKET_NOT_DEPLOYED");
      if (ticket.deployedReleaseId !== input.releaseId) throw new DomainError("剪辑 Agent 确认的版本与已部署版本不一致", "REPAIR_TICKET_RELEASE_MISMATCH");
      if (ticket.reporterId !== input.editorId) {
        throw new DomainError("只有原报告阻断的剪辑 Agent 可以确认恢复", "REPAIR_TICKET_REPORTER_MISMATCH");
      }
      const current = this.getCurrent(ticket.projectId);
      if (current.revision.number !== input.observedRevision) {
        throw new RevisionConflictError(input.observedRevision, current.revision.number);
      }
      this.db.prepare(`UPDATE repair_tickets
        SET status = 'acknowledged', acknowledged_by = ?, acknowledged_release_id = ?, acknowledged_revision = ?, updated_at = ?
        WHERE id = ?`).run(input.editorId, input.releaseId, input.observedRevision, now(), input.ticketId);
      return this.getRepairTicket(input.ticketId);
    });
  }

  updateExportArtifact(projectId: Id, artifactId: Id, mutate: (artifact: ExportArtifact) => void): ExportArtifact {
    return this.transaction(() => {
      const artifact = this.getExportArtifact(projectId, artifactId);
      mutate(artifact);
      this.db.prepare("UPDATE export_artifacts SET artifact_json = ? WHERE id = ? AND project_id = ?")
        .run(JSON.stringify(artifact), artifactId, projectId);
      return artifact;
    });
  }
}
