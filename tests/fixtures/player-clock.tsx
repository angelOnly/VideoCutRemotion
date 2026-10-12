import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player, type PlayerRef } from "@remotion/player";
import { OffthreadVideo } from "remotion";
import type { ProjectSnapshot } from "../../packages/contracts/src/index";
import { usePreviewInput } from "../../apps/web/src/use-preview-input";

const initial = { project: { id: "clock-fixture" } } as ProjectSnapshot;
function Content({ snapshot, mediaBaseUrl }: { snapshot: ProjectSnapshot; mediaBaseUrl: string }) {
  return <><OffthreadVideo src={`${mediaBaseUrl}/clock.mp4`} /><span data-project={snapshot.project.id} /></>;
}
function Harness() {
  const [snapshot, setSnapshot] = useState(initial);
  const [frame, setFrame] = useState(0);
  const ref = useRef<PlayerRef>(null);
  const input = usePreviewInput(snapshot, window.location.origin)!;
  const legacy = new URLSearchParams(window.location.search).has("legacy");
  useEffect(() => {
    const player = ref.current!;
    const update = (event: { detail: { frame: number } }) => setFrame(event.detail.frame);
    player.addEventListener("frameupdate", update);
    return () => player.removeEventListener("frameupdate", update);
  }, []);
  return <>
    <output id="frame">{frame}</output>
    <button id="play" onClick={() => ref.current?.play()}>播放</button>
    <button id="pause" onClick={() => ref.current?.pause()}>暂停</button>
    <button id="seek" onClick={() => ref.current?.seekTo(96)}>定位</button>
    <button id="revision" onClick={() => setSnapshot({ ...initial, project: { ...initial.project, id: "changed" } })}>换快照</button>
    <Player ref={ref} component={Content} inputProps={legacy ? { snapshot, mediaBaseUrl: window.location.origin } : input}
      durationInFrames={480} compositionHeight={180} compositionWidth={320} fps={24} controls
      style={{ width: 320, height: 180 }} />
  </>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
