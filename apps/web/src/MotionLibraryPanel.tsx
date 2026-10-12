import { managedMotionReviewOutcome, type ProjectSnapshot } from "@videocut/contracts";
import { MOTION_SOURCES } from "../../../packages/motion-work/src/catalog";
import { API_BASE } from "./api";

/** 直接使用原站图库，不复制第三方素材墙；项目里只显示真正生成的固定版本作品。 */
export function MotionLibraryPanel({ snapshot, onSelectAsset }: { snapshot: ProjectSnapshot; onSelectAsset: (id: string) => void }) {
  const works = snapshot.assets.filter((asset) => asset.motion);
  return <section className="story-card" data-testid="motion-library">
    <strong>原创动效作品</strong>
    <p>按内容设计完整画面与运动，通过真实动态审阅后用于成片。下方来源可按需寻找灵感，无参考也可正常制作。</p>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
      {MOTION_SOURCES.map((source) => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer" style={{ border: "1px solid #ffffff25", padding: 12, borderRadius: 8, color: "inherit", textDecoration: "none" }}><strong>{source.name} ↗</strong><small style={{ display: "block", marginTop: 6 }}>{source.tags.join(" · ")}</small></a>)}
    </div>
    {works.map((asset) => <article key={asset.id} style={{ marginTop: 16 }}>
      <strong>{asset.name}</strong> <small>{asset.motion!.version.slice(0, 8)} · {managedMotionReviewOutcome(asset.motion) === "passed" ? "作品通过，合成待审" : managedMotionReviewOutcome(asset.motion) === "failed" ? "作品未通过，需修改" : "待动态审阅"}</small>
      <video aria-label={`${asset.name}审阅预览`} controls preload="metadata" style={{ width: "100%", maxHeight: 230, marginTop: 8 }} src={`${API_BASE}/media/${encodeURIComponent(snapshot.project.id)}/${asset.managedPath.split(/[\\/]/u).map(encodeURIComponent).join("/")}`} />
      <button onClick={() => onSelectAsset(asset.id)}>查看作品素材</button>
      {asset.motion!.creativeBrief && <p>{asset.motion!.creativeBrief}</p>}
      {asset.motion!.referenceUrl && <a href={asset.motion!.referenceUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#c2b7ff" }}>查看选中的在线参考 ↗</a>}
      <small style={{ display: "block" }}>此处为带背景的审阅代理；正式叠加使用透明帧。修改文案由 Codex 提交新版本，不覆盖旧版。</small>
    </article>)}
  </section>;
}
