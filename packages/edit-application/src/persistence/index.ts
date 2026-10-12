/**
 * 数据库持久化唯一入口。
 *
 * 用户只需从这里查看表结构、SQLite 初始化和项目仓储；具体视频业务保持在 Application 层。
 */
export {
  PROJECT_DATABASE_PRAGMAS_SQL,
  PROJECT_DATABASE_SCHEMA_SQL,
  PROJECT_DATABASE_TABLES,
  initializeProjectDatabase,
  type PersistenceColumn,
  type PersistenceIndex,
  type PersistenceRelation,
  type PersistenceTable
} from "./schema";
export { normalizeSnapshot } from "./normalize-snapshot";
export { ProjectRepository } from "./sqlite-project-repository";
export { NotFoundError, RevisionConflictError, type ProjectState } from "./types";
