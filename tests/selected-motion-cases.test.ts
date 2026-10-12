import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileMotion } from "../packages/motion-work/src/compiler.js";
import { motionSubmissionSchema } from "../packages/motion-work/src/schema.js";

const root = resolve(".agents/skills");
const cases = ["sim-paper", "smooth-relay", "ticket-phone", "product-fan", "cover-flow", "comment-focus"];
const readFixture = async (name: string) => JSON.parse(await readFile(join(root, `motion-case-library/references/cases/motion-case-${name}/assets/fixture.json`), "utf8"));

test("选定源码通过当前受管校验与编译；按固定模式和图片绑定编译，不运行正式项目", async () => {
  for (const name of cases) {
    const fixture = await readFixture(name);
    const directory = join(root, `motion-case-library/references/cases/motion-case-${name}/assets`);
    const parts = fixture.parts ?? [{ source: fixture.sourceFiles[0], props: fixture.props, ...fixture }];
    const images: Record<string, string> = {};
    for (const [slot, file] of Object.entries(fixture.imageSlots)) {
      images[slot] = `data:image/jpeg;base64,${(await readFile(join(directory, file as string))).toString("base64")}`;
    }
    for (const part of parts) {
      const work = motionSubmissionSchema.parse({
        name: fixture.title,
        source: await readFile(join(directory, part.source), "utf8"),
        props: part.props,
        width: part.width, height: part.height, fps: part.fps, durationInFrames: part.durationInFrames,
        creativeBrief: "验证归档案例的固定源码与当前受管编译合同，编译成功不等于动态或成片验收。",
      });
      assert.ok((await compileMotion(work, images)).length > 0, `${name}/${part.source} 未输出编译结果`);
    }
  }
});

test("合集时长扣除实际交叠，24秒合成明确保留外部素材和本地时间", async () => {
  const relay = await readFixture("smooth-relay");
  let endFrame = relay.parts[0].durationInFrames;
  for (let i = 1; i < relay.parts.length; i++) {
    const transition = relay.transitions[i - 1];
    assert.equal(transition.type, "smoothleft");
    assert.equal(transition.startFrame, endFrame - transition.durationFrames);
    assert.equal(relay.parts[i].startFrame, transition.startFrame);
    endFrame = relay.parts[i].startFrame + relay.parts[i].durationInFrames;
  }
  assert.equal(endFrame, relay.durationInFrames);
  assert.equal(endFrame, 577);

  const composed = await readFixture("sim-paper");
  assert.equal(composed.kind, "composed");
  assert.equal(composed.durationInFrames / composed.fps, 24);
  assert.equal(composed.inputs.length, 2);
  assert.equal(composed.inputs[0].timelineEndFrame, composed.inputs[1].timelineStartFrame);
  assert.equal(composed.inputs[1].timelineEndFrame, composed.durationInFrames);
  for (const input of composed.inputs) {
    assert.equal(input.sourceEndFrame - input.sourceStartFrame, input.timelineEndFrame - input.timelineStartFrame);
    assert.equal(input.audio, "mute");
    assert.ok((await readFile(join(root, "motion-case-library/references/cases/motion-case-sim-paper/assets", input.file))).length > 0);
  }
});
