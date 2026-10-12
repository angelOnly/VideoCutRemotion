import React from "react";
import { Composition, registerRoot } from "remotion";
import { z } from "zod";
import { ProjectComposition, type CompositionProps } from "../../../packages/remotion-runtime/src/index";

const compositionId = "videocut-project";
const renderPropsSchema = z.object({ snapshot: z.any(), mediaBaseUrl: z.string() });
type RenderCompositionProps = CompositionProps & Record<string, unknown>;

const RenderRoot: React.FC = () => (
  <Composition<typeof renderPropsSchema, RenderCompositionProps>
    id={compositionId}
    schema={renderPropsSchema}
    component={ProjectComposition as React.FC<RenderCompositionProps>}
    durationInFrames={1}
    fps={24}
    width={768}
    height={1344}
    defaultProps={{
      snapshot: {} as CompositionProps["snapshot"],
      mediaBaseUrl: "http://127.0.0.1"
    }}
    calculateMetadata={({ props }) => ({
      durationInFrames: Math.max(1, props.snapshot.timeline.durationInFrames),
      fps: props.snapshot.timeline.fps,
      width: props.snapshot.timeline.width,
      height: props.snapshot.timeline.height
    })}
  />
);

registerRoot(RenderRoot);

export { compositionId };
