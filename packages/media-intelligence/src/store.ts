import type { DatabaseSync } from "node:sqlite";
import type { AssetCandidate, AssetRequest, AssetSearchDiagnostics, MediaAnalysisRecord, MediaObservation, MediaSource, SearchIntent } from "@videocut/contracts";
import { normalizeCandidateFilters } from "./candidate-lifecycle.js";
import { randomUUID } from "node:crypto";

export interface MediaSearchSession {
  resultFormatVersion?: number;
  nextCursor?: string;
  id: string; projectId: string; requestId: string; requestVersion: string;
  intent: SearchIntent; candidates: AssetCandidate[]; createdAt: string;
  diagnostics?: AssetSearchDiagnostics;
  requestSnapshot?: AssetRequest;
}
type JsonRow = { data: string };
/** 同一个 SQLite 内的操作表；不会随每个创作 Revision 重复复制。 */
export class MediaIntelligenceStore {
  constructor(private readonly db: DatabaseSync) {

  }
  saveSource(source: MediaSource): void {
    this.db.prepare("INSERT INTO media_sources(id,project_id,target_key,hash,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(source.id, source.projectId, (source.target.assetId ?? source.target.candidateId ?? source.target.exportArtifactId ?? source.target.previewJobId)!, source.hash, JSON.stringify(source));
  }
  source(projectId: string, id: string): MediaSource | undefined {
    const row = this.db.prepare("SELECT data FROM media_sources WHERE id=? AND project_id=?").get(id, projectId) as JsonRow | undefined;
    return row && JSON.parse(row.data);
  }
  sources(projectId: string): MediaSource[] {
    return (this.db.prepare("SELECT data FROM media_sources WHERE project_id=?").all(projectId) as JsonRow[]).map((row) => JSON.parse(row.data));
  }
  saveObservation(observation: MediaObservation): void {
    // 源项目、版本与不可变 ID 都在写入时检查，不允许一次纠错篡改别的素材。
    const source = this.source(observation.projectId, observation.sourceId);
    if (!source || source.hash !== observation.sourceHash) throw new Error("观察源身份不匹配");
    this.db.exec("SAVEPOINT media_observation_write");
    try {
      if (observation.supersedes) {
        const previous = this.observation(observation.projectId, observation.supersedes);
        if (!previous || previous.sourceId !== observation.sourceId || this.isSuperseded(observation.projectId, previous.id)) throw new Error("观察已被纠正或不属于此来源");
      }
      this.db.prepare("INSERT INTO media_observations(id,project_id,source_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING")
        .run(observation.id, observation.projectId, observation.sourceId, JSON.stringify(observation));
      if (observation.supersedes) this.db.prepare("UPDATE media_observations SET superseded_by=? WHERE id=? AND project_id=?").run(observation.id, observation.supersedes, observation.projectId);
      this.db.exec("RELEASE media_observation_write");
    } catch (error) { this.db.exec("ROLLBACK TO media_observation_write; RELEASE media_observation_write"); throw error; }
  }
  observation(projectId: string, id: string): MediaObservation | undefined {
    const row = this.db.prepare("SELECT data FROM media_observations WHERE project_id=? AND id=?").get(projectId, id) as JsonRow | undefined;
    return row && JSON.parse(row.data);
  }
  isSuperseded(projectId: string, id: string): boolean {
    return Boolean(this.db.prepare("SELECT id FROM media_observations WHERE project_id=? AND id=? AND superseded_by IS NOT NULL").get(projectId, id));
  }
  observations(projectId: string, sourceId?: string): MediaObservation[] {
    const rows = this.db.prepare(`SELECT data FROM media_observations WHERE project_id=? AND superseded_by IS NULL${sourceId ? " AND source_id=?" : ""}`).all(...(sourceId ? [projectId, sourceId] : [projectId])) as JsonRow[];
    return rows.map((row) => JSON.parse(row.data));
  }
  saveAnalysis(record: MediaAnalysisRecord): void {
    this.db.prepare("INSERT INTO media_analysis_records(id,project_id,analysis_key,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(record.id, record.projectId, record.key, JSON.stringify(record));
  }
  analysis(projectId: string, id: string): MediaAnalysisRecord | undefined {
    const row = this.db.prepare("SELECT data FROM media_analysis_records WHERE project_id=? AND id=?").get(projectId, id) as JsonRow | undefined;
    return row && JSON.parse(row.data);
  }
  analyses(projectId: string, sourceId?: string): MediaAnalysisRecord[] {
    return (this.db.prepare("SELECT data FROM media_analysis_records WHERE project_id=?").all(projectId) as JsonRow[]).map((row) => JSON.parse(row.data) as MediaAnalysisRecord).filter((record) => !sourceId || record.sourceId === sourceId);
  }
  saveVector(observationId: string, modality: string, model: string, textHash: string, vector: number[]): void {
    if (vector.length !== 1024 || vector.some((value) => !Number.isFinite(value)) || Math.abs(Math.hypot(...vector) - 1) > 0.02) throw new Error("文本向量必须为 L2 归一化的 1024 维数值");
    this.db.prepare("INSERT OR REPLACE INTO media_vectors(observation_id,modality,model,text_hash,data) VALUES(?,?,?,?,?)").run(observationId, modality, model, textHash, JSON.stringify(vector));
  }
  vector(observationId: string, modality: string, model: string, textHash: string): number[] | undefined {
    const row = this.db.prepare("SELECT data FROM media_vectors WHERE observation_id=? AND modality=? AND model=? AND text_hash=?").get(observationId, modality, model, textHash) as JsonRow | undefined;
    return row && JSON.parse(row.data);
  }
  saveSearch(session: MediaSearchSession): void {
    this.db.prepare("INSERT INTO media_search_sessions(id,project_id,request_id,data) VALUES(?,?,?,?)").run(session.id, session.projectId, session.requestId, JSON.stringify(session));
  }
  libraryCache<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM motion_library_cache WHERE key=?").get(key) as JsonRow | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }
  saveLibraryCache(key: string, value: unknown): void {
    this.db.prepare("INSERT OR REPLACE INTO motion_library_cache(key,data) VALUES(?,?)").run(key, JSON.stringify(value));
  }
  searches(projectId: string): MediaSearchSession[] {
    return (this.db.prepare("SELECT data FROM media_search_sessions WHERE project_id=? ORDER BY rowid DESC").all(projectId) as JsonRow[]).map((row) => {
      const session = JSON.parse(row.data) as MediaSearchSession;
      session.candidates.forEach(candidate => normalizeCandidateFilters(candidate, session.requestSnapshot));
      return session;
    });
  }
  candidate(projectId: string, id: string): { session: MediaSearchSession; candidate: AssetCandidate } | undefined {
    for (const session of this.searches(projectId)) {
      const candidate = session.candidates.find((candidate) => candidate.id === id);
      if (candidate) return { session, candidate };
    }
    return undefined;
  }
}
export const mediaId = (kind: string) => `${kind}_${randomUUID()}`;
