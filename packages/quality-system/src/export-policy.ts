import type { ExportPurpose, QualityReport } from "@videocut/contracts";

/** 浏览器与 Worker 共用同一阻挡选择，辅助审阅保留提示而不参与文件导出。 */
export function exportBlockingIssues(report: Pick<QualityReport, "technical">, purpose: ExportPurpose) {
  return report.technical.filter(entry => entry.level === "blocking" && (!entry.blockingPurposes || entry.blockingPurposes.includes(purpose)));
}
