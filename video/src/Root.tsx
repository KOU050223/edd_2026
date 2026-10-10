import { Composition } from "remotion";
import { Launch } from "./Launch";
import { Pitch } from "./pitch/Pitch";
import { PITCH_DURATION, PITCH_FPS } from "./pitch/timeline";
import { DURATION, FPS, HEIGHT, WIDTH } from "./timeline";

export const Root = () => (
  <>
    <Composition
      id="Launch"
      component={Launch}
      durationInFrames={DURATION}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
    />
    <Composition
      id="Pitch"
      component={Pitch}
      durationInFrames={PITCH_DURATION}
      fps={PITCH_FPS}
      width={WIDTH}
      height={HEIGHT}
    />
  </>
);
