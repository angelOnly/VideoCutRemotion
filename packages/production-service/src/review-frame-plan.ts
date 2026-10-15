import { z } from 'zod';
import { prepareReviewSchema } from './review-service.js';

const text=z.string().trim().min(1).max(4000);
/** 作者只提交目的与选帧；媒体编号、去重和证据引用由程序统一形成。 */
export const prepareReviewFramesSchema=z.object({
  renderRequestId:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  sourceDigest:z.string().min(1).optional(),
  timelineRef:prepareReviewSchema.shape.timelineRef,
  phase:prepareReviewSchema.shape.phase,
  reuse:prepareReviewSchema.shape.reuse,
  units:z.array(z.object({unitId:text,sceneIds:z.array(text).min(1),checks:z.array(z.object({
    checkId:text,purpose:text,frames:z.array(z.number().int().nonnegative()).min(1),
  }).strict()).min(1)}).strict()).min(1),
}).strict();

export function reviewFramesInput(runId:string,body:unknown){
  const request=prepareReviewFramesSchema.parse(body);
  const frames=[...new Set(request.units.flatMap(u=>u.checks.flatMap(c=>c.frames)))];
  const reviewPlan=prepareReviewSchema.parse({
    renderRequestIds:[request.renderRequestId],phase:request.phase,timelineRef:request.timelineRef,reuse:request.reuse,
    units:request.units.map(unit=>({...unit,checks:unit.checks.map(({frames,...check})=>({...check,mode:'image',
      evidence:[...new Set(frames)].map(frame=>({renderRequestId:request.renderRequestId,frame})),
    }))})),
  });
  return {runId,renderRequestId:request.renderRequestId,sourceDigest:request.sourceDigest,frames,reviewPlan};
}
