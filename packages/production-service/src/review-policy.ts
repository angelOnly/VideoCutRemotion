// 协调偏好仅提供给 Codex；Runtime 不据此创建审片代理或阻止预览。
export interface ReviewPolicyConfig {
  qaParallelReview: boolean;
  qaMaxReviewers: number;
  previewOnDemand: boolean;
}
export const DEFAULT_REVIEW_POLICY: ReviewPolicyConfig = {
  qaParallelReview: true, qaMaxReviewers: 3, previewOnDemand: true,
};
