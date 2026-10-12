---
tags: 3d, cube, rotate, box, spin
description: 3D 立方体旋转——Outgoing 位于正面，Incoming 位于右面，绕 Y 轴旋转 90°。
complexity: high
---

# 立方体旋转 Transition

使用带逐面 Material 的 BoxGeometry。只有两个面承载 Texture（正面=Outgoing，右面=Incoming），其余面为黑色。

关键决策：

- `BoxGeometry(1.5 * aspect, 1.5, 1.5 * aspect)`——Depth 与 Width 一致，使立方体表面在 X/Z 平面中为正方形，从而无论视频宽高比如何，都保持正确旋转 Geometry。
- `camera.position.z = 2.5`——放置 Camera，使立方体表面在 FOV 45 时填满大部分 Viewport。
- 绕 Y 轴旋转并使用 Cubic Easing——缓慢开始，在旋转中段加速，在结束时减速。

```typescript
class CubeTransition extends TransitionProcessor {
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private cube!: Mesh;
  private outMat!: MeshBasicMaterial;
  private inMat!: MeshBasicMaterial;

  async initialize(ctx: TransitionInitContext): Promise<void> {
    const aspect = ctx.width / ctx.height;
    this.scene = new Scene();
    this.camera = new PerspectiveCamera(45, aspect, 0.1, 1000);
    this.camera.position.z = 2.5;

    const geometry = new BoxGeometry(1.5 * aspect, 1.5, 1.5 * aspect);
    this.outMat = new MeshBasicMaterial();
    this.inMat = new MeshBasicMaterial();

    // Front face (index 4) and Right face (index 0)
    const materials = [
      this.inMat,
      new MeshBasicMaterial({ color: 0x000000 }),
      new MeshBasicMaterial({ color: 0x000000 }),
      new MeshBasicMaterial({ color: 0x000000 }),
      this.outMat,
      new MeshBasicMaterial({ color: 0x000000 }),
    ];
    this.cube = new Mesh(geometry, materials);
    this.scene.add(this.cube);
  }

  protected render(ctx: TransitionRenderContext): WebGLTexture {
    this.outMat.map = ctx.three.wrapTexture(ctx.outgoingTexture);
    this.inMat.map = ctx.three.wrapTexture(ctx.incomingTexture);

    // Cubic easing
    const p = ctx.progress;
    const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    this.cube.rotation.y = -eased * (Math.PI / 2);

    return ctx.threePass(this.scene, this.camera);
  }
}
```

