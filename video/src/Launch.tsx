import { AbsoluteFill, Html5Audio, Sequence, staticFile } from "remotion";
import { Desktop } from "./scenes/Desktop";
import { Everywhere } from "./scenes/Everywhere";
import { History } from "./scenes/History";
import { Hook } from "./scenes/Hook";
import { LearningMap } from "./scenes/LearningMap";
import { Logo } from "./scenes/Logo";
import { VsCode } from "./scenes/VsCode";
import { SCENES } from "./timeline";

const SCENE_COMPONENTS: Record<keyof typeof SCENES, () => React.JSX.Element> = {
  hook: Hook,
  vscode: VsCode,
  desktop: Desktop,
  everywhere: Everywhere,
  history: History,
  map: LearningMap,
  logo: Logo,
};

export const Launch = () => (
  <AbsoluteFill style={{ background: "#0f172a" }}>
    {(Object.keys(SCENES) as (keyof typeof SCENES)[]).map((key) => {
      const Scene = SCENE_COMPONENTS[key];
      return (
        <Sequence
          key={key}
          from={SCENES[key].from}
          durationInFrames={SCENES[key].duration}
          name={key}
        >
          <Scene />
        </Sequence>
      );
    })}
    {/* scripts/make-audio.ts が src/timeline.ts から合成した音。映像と同じ拍で鳴る */}
    <Html5Audio src={staticFile("soundtrack.wav")} />
  </AbsoluteFill>
);
