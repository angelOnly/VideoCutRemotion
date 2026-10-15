type ClosingTimeline = {
  ending?: {closingUtteranceIds:string[]};
  scenes:Array<{from:number;utterances:Array<{endFrameExclusive:number}>}>;
};

/** 结束语保持在实际正文末帧，配音时长改变后不再维护第二份截止帧。 */
export function closingHoldFrame(timeline:ClosingTimeline):number|undefined {
  const count=timeline.ending?.closingUtteranceIds.length??0;
  if(!count)return undefined;
  const utterances=timeline.scenes.flatMap(scene=>scene.utterances.map(utterance=>({scene,utterance})));
  const body=utterances[utterances.length-count-1];
  if(!body)throw new Error('模板视觉校验失败：固定结束语之前必须有正文');
  return body.scene.from+body.utterance.endFrameExclusive-1;
}
