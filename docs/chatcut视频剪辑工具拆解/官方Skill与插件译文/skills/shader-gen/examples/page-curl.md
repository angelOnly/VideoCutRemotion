---
tags: 3d, page, curl, flip, turn, book, peel
description: 卷页 Transition——Outgoing 页面从左向右卷走，露出下方 Incoming。
complexity: high
---

# 卷页 Transition

双 Layer 方法：Incoming 页面平放在后方（z=-0.001），Outgoing 页面是高分辨率细分 Plane（80×80），每一帧都变形 Vertex 来模拟圆柱卷曲。

关键决策：

- **根据 FOV 计算 Camera Distance**：`dist = 1 / Math.tan(fovRad / 2)` 确保 Plane（height=2）在垂直方向准确填满 Viewport。没有硬编码 Camera Z。
- **Radius 与页面宽度成比例**：`radius = W * 0.08` 随宽高比缩放，避免宽视频上的 Curl 太紧，或高视频上的 Curl 太松。
- **Fold 从左→右扫过**：`foldX = -W/2 + eased * (W + radius * PI)`。progress=0 时，Fold 位于左边缘（尚未卷曲）；progress=1 时，它越过右边缘（完全卷走）。
- **基于 UV 重建位置**：每帧都从 UV 推导原始位置（`ox = uv.getX(i) * W - W/2`），因为 Position Buffer 会被覆盖。UV 保持不变。
- **三个 Curl Zone**：(1) `ox <= foldX` → 平坦，尚未到达。(2) `ox > foldX, angle <= PI` → 围绕圆柱卷曲。(3) `angle > PI` → 超过 180°，在 z=2\*radius 位置向 -x 方向平坦延伸（折回页面在顶部可见）。
- **`side: 2`（DoubleSide）**：卷曲过程中可以看到页面背面。
- **Texture Swap**：`incomingMat` 获得 `outgoingTexture`，`curlMat` 获得 `incomingTexture`——卷走的页面显示 Incoming，平坦 Base 显示 Outgoing。这会产生旧页剥离、新页显露的效果。

```typescript
export class PageCurlTransition extends TransitionProcessor {
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private curlMesh!: Mesh;
  private incomingMesh!: Mesh;
  private curlMat!: MeshBasicMaterial;
  private incomingMat!: MeshBasicMaterial;
  private aspect!: number;
  private W!: number;

  async initialize(ctx: TransitionInitContext): Promise<void> {
    this.aspect = ctx.width / ctx.height;
    this.scene = new Scene();

    const fov = 45;
    const fovRad = (fov * Math.PI) / 180;
    const dist = 1 / Math.tan(fovRad / 2);

    this.camera = new PerspectiveCamera(fov, this.aspect, 0.01, 100);
    this.camera.position.z = dist;

    this.W = 2 * this.aspect;
    const H = 2;

    this.incomingMat = new MeshBasicMaterial({ side: 2 });
    this.incomingMesh = new Mesh(
      new PlaneGeometry(this.W, H),
      this.incomingMat,
    );
    this.incomingMesh.position.z = -0.001;
    this.scene.add(this.incomingMesh);

    this.curlMat = new MeshBasicMaterial({ side: 2 });
    this.curlMesh = new Mesh(
      new PlaneGeometry(this.W, H, 80, 80),
      this.curlMat,
    );
    this.scene.add(this.curlMesh);
  }

  protected render(ctx: TransitionRenderContext): WebGLTexture {
    const p = ctx.progress;
    const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

    this.incomingMat.map = ctx.three.wrapTexture(ctx.outgoingTexture);
    this.curlMat.map = ctx.three.wrapTexture(ctx.incomingTexture);

    const W = this.W;
    const radius = W * 0.08;
    const foldX = -W / 2 + eased * (W + radius * Math.PI);

    const pos = this.curlMesh.geometry.attributes.position;
    const uv = this.curlMesh.geometry.attributes.uv;
    const count = pos.count;

    for (let i = 0; i < count; i++) {
      const ox = uv.getX(i) * W - W / 2;
      const oy = uv.getY(i) * 2 - 1;

      let nx: number, nz: number;

      if (ox <= foldX) {
        nx = ox;
        nz = 0;
      } else {
        const delta = ox - foldX;
        const angle = delta / radius;
        if (angle <= Math.PI) {
          nx = foldX + radius * Math.sin(angle);
          nz = radius * (1 - Math.cos(angle));
        } else {
          const extra = delta - radius * Math.PI;
          nx = foldX - extra;
          nz = radius * 2;
        }
      }

      pos.setXYZ(i, nx, oy, nz);
    }

    pos.needsUpdate = true;
    this.curlMesh.geometry.computeVertexNormals();

    return ctx.threePass(this.scene, this.camera);
  }
}
```

