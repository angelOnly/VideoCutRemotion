---
tags: 3d, door, open, split, swing, hinge
description: 开门 Transition——Outgoing 分成两半，像门一样向外打开，露出后方 Incoming。
complexity: high
---

# 开门 Transition

三个 Layer：Incoming Backdrop 位于后方，左门和右门位于前方。每扇门都显示 Outgoing Texture 中正确的一半，并围绕各自外侧铰链向外摆动。

关键决策：

- **根据 FOV 计算 Camera Distance**：`dist = 1 / Math.tan(fovRad / 2)` 确保高度为 2 的 Plane 填满 Viewport。没有硬编码 Camera Z。
- **为拆分 Texture 重映射 UV**：左门 UV 重映射到 u:[0, 0.5]，右门重映射到 u:[0.5, 1]。每个半 Panel 只显示 Outgoing Frame 中对应的一半——而不是压缩完整 Frame。
- **Object3D Pivot 模式**：每扇门的 Geometry 都进行 Offset，使铰链边位于 Local Origin。Object3D Parent 放在屏幕边缘。旋转 Object3D 会让门围绕正确铰链摆动。左铰链 x=-W/2，右铰链 x=+W/2。
- **门向屏幕内摆动**：左门绕 -Y 旋转（向左远离），右门绕 +Y 旋转（向右远离）。两扇门都朝负 Z 方向摆动，形成自然的“朝观众打开”透视效果。

```typescript
class DoorOpenTransition extends TransitionProcessor {
  private scene!: Scene;
  private camera!: PerspectiveCamera;
  private leftPivot!: Object3D;
  private rightPivot!: Object3D;
  private leftMat!: MeshBasicMaterial;
  private rightMat!: MeshBasicMaterial;
  private backMat!: MeshBasicMaterial;

  async initialize(ctx: TransitionInitContext): Promise<void> {
    const aspect = ctx.width / ctx.height;
    const fov = 50;
    const dist = 1 / Math.tan((fov * Math.PI) / 180 / 2);

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(fov, aspect, 0.01, 100);
    this.camera.position.z = dist;

    const W = 2 * aspect;
    const H = 2;

    // Backdrop: incoming clip, full width
    this.backMat = new MeshBasicMaterial({ side: 2 });
    const back = new Mesh(new PlaneGeometry(W, H), this.backMat);
    back.position.z = -0.05;
    this.scene.add(back);

    // Left door: shows LEFT half of outgoing (UV u: 0→0.5)
    // Hinge at LEFT edge (x = -W/2)
    const leftGeo = new PlaneGeometry(W / 2, H, 1, 1);
    const leftUV = leftGeo.attributes.uv;
    for (let i = 0; i < leftUV.count; i++) {
      leftUV.setX(i, leftUV.getX(i) * 0.5);
    }
    leftUV.needsUpdate = true;
    this.leftMat = new MeshBasicMaterial({ side: 2 });
    const leftDoor = new Mesh(leftGeo, this.leftMat);
    // Shift geometry so LEFT edge is at local origin (pivot)
    leftDoor.geometry.translate(W / 4, 0, 0);
    this.leftPivot = new Object3D();
    this.leftPivot.position.x = -W / 2;
    this.leftPivot.add(leftDoor);
    this.scene.add(this.leftPivot);

    // Right door: shows RIGHT half of outgoing (UV u: 0.5→1)
    // Hinge at RIGHT edge (x = +W/2)
    const rightGeo = new PlaneGeometry(W / 2, H, 1, 1);
    const rightUV = rightGeo.attributes.uv;
    for (let i = 0; i < rightUV.count; i++) {
      rightUV.setX(i, 0.5 + rightUV.getX(i) * 0.5);
    }
    rightUV.needsUpdate = true;
    this.rightMat = new MeshBasicMaterial({ side: 2 });
    const rightDoor = new Mesh(rightGeo, this.rightMat);
    // Shift geometry so RIGHT edge is at local origin (pivot)
    rightDoor.geometry.translate(-W / 4, 0, 0);
    this.rightPivot = new Object3D();
    this.rightPivot.position.x = W / 2;
    this.rightPivot.add(rightDoor);
    this.scene.add(this.rightPivot);
  }

  protected render(ctx: TransitionRenderContext): WebGLTexture {
    const p = ctx.progress;
    const eased = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;

    this.backMat.map = ctx.three.wrapTexture(ctx.incomingTexture);
    this.leftMat.map = ctx.three.wrapTexture(ctx.outgoingTexture);
    this.rightMat.map = ctx.three.wrapTexture(ctx.outgoingTexture);

    // Left door: hinge on left, swings into screen (negative Y rotation)
    this.leftPivot.rotation.y = -eased * (Math.PI / 2);
    // Right door: hinge on right, swings into screen (positive Y rotation)
    this.rightPivot.rotation.y = eased * (Math.PI / 2);

    return ctx.threePass(this.scene, this.camera);
  }
}
```

