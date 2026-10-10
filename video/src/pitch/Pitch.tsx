import { AbsoluteFill, Sequence } from "remotion";
import { Desktop } from "../scenes/Desktop";
import { Hook } from "../scenes/Hook";
import { LearningMap } from "../scenes/LearningMap";
import { Logo } from "../scenes/Logo";
import { VsCode } from "../scenes/VsCode";
import { ImportDemo } from "./ImportDemo";
import { RepoMap } from "./RepoMap";
import { Section } from "./Section";
import { Share } from "./Share";
import { PITCH_SCENES, type PitchSceneKey } from "./timeline";

const SCENE_COMPONENTS: Record<PitchSceneKey, () => React.JSX.Element> = {
  hook: Hook,
  vscode: VsCode,
  desktop: Desktop,
  map: LearningMap,
  section: Section,
  importDemo: ImportDemo,
  repoMap: RepoMap,
  share: Share,
  logo: Logo,
};

/**
 * 発表の裏で流す 3 分の映像。台本は PITCH.md。
 * 発表者が話すので、ナレーションも BGM も載せない。
 */
export const Pitch = () => (
  <AbsoluteFill style={{ background: "#0f172a" }}>
    {(Object.keys(PITCH_SCENES) as PitchSceneKey[]).map((key) => {
      const Scene = SCENE_COMPONENTS[key];
      return (
        <Sequence
          key={key}
          from={PITCH_SCENES[key].from}
          durationInFrames={PITCH_SCENES[key].duration}
          name={key}
        >
          <Scene />
        </Sequence>
      );
    })}
  </AbsoluteFill>
);
