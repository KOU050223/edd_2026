import { Composition } from "remotion";
import { Launch } from "./Launch";
import { DURATION, FPS, HEIGHT, WIDTH } from "./timeline";

export const Root = () => (
  <Composition
    id="Launch"
    component={Launch}
    durationInFrames={DURATION}
    fps={FPS}
    width={WIDTH}
    height={HEIGHT}
  />
);
