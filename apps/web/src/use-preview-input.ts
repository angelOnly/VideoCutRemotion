import { useMemo } from "react";
import type { ProjectSnapshot } from "@videocut/contracts";

export function usePreviewInput(snapshot: ProjectSnapshot | undefined, mediaBaseUrl: string) {
  // 播放头只更新工作台 UI，不能换掉 Player 的输入对象；否则 Remotion 会重置播放时钟。
  // 真正换 Revision/素材快照时仍更新输入，不以放宽 seek 容差掩盖声画不同步。
  return useMemo(() => snapshot ? { snapshot, mediaBaseUrl } : undefined, [snapshot, mediaBaseUrl]);
}
