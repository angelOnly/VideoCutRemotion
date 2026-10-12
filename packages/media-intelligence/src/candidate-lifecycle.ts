import type { AssetCandidate, AssetRequest } from "@videocut/contracts";

const strategyRejection = "素材需求已更新，必须重新搜索并复核候选。";
const durationRejection = (reason: string) => /^时长不足 \d+ 秒。$/u.test(reason);

/** 来源身份与媒介是技术边界，查询、用途、画幅和时长不是。 */
export function candidateTechnicalReasons(candidate: Pick<AssetCandidate, "originalAssetId" | "sourceUrl"> & { kind?: AssetCandidate["kind"] }, request: Pick<AssetRequest, "mediaKind">): string[] {
  const reasons: string[] = [];
  if ((request.mediaKind === "audio") !== (candidate.kind === "audio")) reasons.push("候选媒介类型不符合声音/视觉需求。");
  if (!candidate.originalAssetId.trim()) reasons.push("Provider 未返回原始素材 ID。");
  if (!candidate.sourceUrl.trim()) reasons.push("Provider 未返回可追溯的来源页面。");
  return reasons;
}

/** 读取时兼容旧记录；保留原始原因，不回写历史 Revision 或搜索会话。 */
export function normalizeCandidateFilters(candidate: AssetCandidate, request?: Pick<AssetRequest, "mediaKind">): AssetCandidate {
  candidate.kind ??= "video";
  const oldReasons = candidate.filterReasons;
  if (candidate.status === "rejected" && !candidate.strategyMigration
      && (candidate.rejectionReason?.includes(strategyRejection) || oldReasons.includes(strategyRejection))) {
    const technical = candidateTechnicalReasons(candidate, request ?? { mediaKind: candidate.kind === "audio" ? "audio" : "visual" });
    const onlyStrategy = candidate.rejectionReason === strategyRejection && oldReasons.includes(strategyRejection)
      && oldReasons.every(reason => reason === strategyRejection || durationRejection(reason)) && technical.length === 0;
    candidate.strategyMigration = { outcome: onlyStrategy ? "restored" : "retained_mixed", rejectionReason: candidate.rejectionReason, filterReasons: [...oldReasons] };
    if (onlyStrategy) {
      candidate.status = "available";
      candidate.hardFilterPassed = true;
      candidate.filterReasons = [];
      candidate.rejectionReason = undefined;
    }
    // 混合原因无法证明只是旧策略拒绝，保持原状态与理由。
    return candidate;
  }
  if (candidate.strategyMigration?.outcome === "retained_mixed") return candidate;
  const remaining = oldReasons.filter(reason => !durationRejection(reason));
  if (remaining.length !== oldReasons.length) {
    const automaticallyRejected = candidate.rejectionReason === oldReasons.join(" ");
    candidate.filterReasons = [...new Set([...remaining, ...candidateTechnicalReasons(candidate, request ?? { mediaKind: candidate.kind === "audio" ? "audio" : "visual" })])];
    candidate.hardFilterPassed = candidate.filterReasons.length === 0;
    if (automaticallyRejected) {
      candidate.rejectionReason = candidate.filterReasons.join(" ") || undefined;
      if (candidate.status === "rejected" && candidate.hardFilterPassed) candidate.status = "available";
    }
  }
  return candidate;
}
