export interface DynamicPreviewRequest {
  sourceDigest: string; question: string; fromFrame: number; toFrame: number;
  consumer: string; passCriteria: string;
  needsVideo: boolean; needsAudio: boolean;
  continuousVideoAvailable: boolean; continuousAudioAvailable: boolean;
}
export type PreviewDecision = 'legacy' | 'not_needed' | 'professional_review_pending' | 'reuse_whole_video' | 'request_preview';

/** 决策仅表示可提交检查，不证明连续看听已经发生。 */
export function decideDynamicPreview(input: {
  onDemand: boolean; request?: DynamicPreviewRequest;
  verifiedWholeVideo?: { sourceDigest: string; fileRef: string };
}): PreviewDecision {
  if (!input.onDemand) return 'legacy';
  const request = input.request;
  if (!request || (!request.needsVideo && !request.needsAudio)) return 'not_needed';
  if (!request.sourceDigest || !request.question.trim() || !request.consumer.trim() || !request.passCriteria.trim() || !Number.isInteger(request.fromFrame) || !Number.isInteger(request.toFrame) || request.fromFrame < 0 || request.toFrame <= request.fromFrame) throw new Error('动态检查需要明确快照、范围、问题、检查者与通过标准');
  if ((request.needsVideo && !request.continuousVideoAvailable) || (request.needsAudio && !request.continuousAudioAvailable)) return 'professional_review_pending';
  if (input.verifiedWholeVideo?.sourceDigest === request.sourceDigest && input.verifiedWholeVideo.fileRef) return 'reuse_whole_video';
  return 'request_preview';
}
