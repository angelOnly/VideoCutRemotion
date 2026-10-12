import type { ProjectSnapshot, RevisionRecord } from "@videocut/contracts";

/** 当前 Revision 与其可编辑快照是仓储对应用层暴露的最小读取合同。 */
export interface ProjectState {
  revision: RevisionRecord;
  snapshot: ProjectSnapshot;
}

/** 调用方基于的 Revision 已经不是项目当前 Revision。 */
export class RevisionConflictError extends Error {
  constructor(public readonly expected: number, public readonly actual: number) {
    super(`Revision 已过期：请求基于 ${expected}，当前为 ${actual}`);
  }
}

/** 项目、Revision、任务或导出产物不存在。 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
  }
}
