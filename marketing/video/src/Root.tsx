import { Composition } from "remotion";
import { OmniClawAd } from "./OmniClawAd";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Vertical (1080x1920) — Reels / Shorts / TikTok / Stories. */}
      <Composition
        id="OmniClawAd"
        component={OmniClawAd}
        durationInFrames={1380}
        fps={30}
        width={1080}
        height={1920}
      />
      {/* Square (1080x1080) — feed posts. */}
      <Composition
        id="OmniClawAdSquare"
        component={OmniClawAd}
        durationInFrames={1380}
        fps={30}
        width={1080}
        height={1080}
      />
    </>
  );
};
