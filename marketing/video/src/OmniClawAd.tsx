import React from "react";
import {
  AbsoluteFill,
  Img,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
  spring,
} from "remotion";
import { Audio } from "@remotion/media";
import voiceover from "./voiceover.json";

/**
 * OmniClaw social ad.
 *
 * Built with the Remotion agent skills (remotion-best-practices →
 * remotion-markup): every motion is driven by useCurrentFrame() + interpolate()
 * (no CSS transitions/animations), transforms use the `scale`/`translate`/`rotate`
 * shorthands, and assets live in public/ and are referenced with staticFile().
 *
 * Brand tokens are the app's own (web-next/css/tokens.css) so the video looks
 * like the product, not a stock template.
 *
 * Sound: a locally synthesised music bed (scripts/make-music.mjs) under a
 * Windows-SAPI voiceover (scripts/make-voiceover.mjs), with burned-in captions
 * timed from the SAME manifest that places the audio, so a caption can never
 * drift from its line.
 */

const C = {
  bg: "#0f1011",
  bgSoft: "#141516",
  bgElevated: "#1d1e1f",
  text: "#f5efe6",
  textDim: "#cfc8bc",
  muted: "#aaa196",
  line: "#343537",
  accent: "#3b82f6",
  ok: "#4ade80",
  warn: "#fbbf24",
};

const FONT = '"Segoe UI", Inter, system-ui, -apple-system, "Helvetica Neue", sans-serif';

const CLAMP = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

type VoiceLine = { id: string; file: string; text: string; startMs: number; endMs: number; durationMs: number };

// ── shared pieces ────────────────────────────────────────────────────────────

const Backdrop: React.FC<{ children: React.ReactNode; glow?: string }> = ({
  children,
  glow = C.accent,
}) => {
  return (
    <AbsoluteFill
      style={{
        backgroundColor: C.bg,
        fontFamily: FONT,
        color: C.text,
        overflow: "hidden",
      }}
    >
      <AbsoluteFill
        style={{
          background: `radial-gradient(120% 70% at 50% 8%, ${glow}22 0%, ${glow}00 60%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage:
            "linear-gradient(#ffffff08 1px, transparent 1px), linear-gradient(90deg, #ffffff08 1px, transparent 1px)",
          backgroundSize: "64px 64px",
          maskImage:
            "radial-gradient(120% 90% at 50% 40%, #000 30%, transparent 80%)",
          WebkitMaskImage:
            "radial-gradient(120% 90% at 50% 40%, #000 30%, transparent 80%)",
        }}
      />
      {children}
    </AbsoluteFill>
  );
};

/** Rise-and-fade entrance used by every headline. */
const Enter: React.FC<{
  children: React.ReactNode;
  delay?: number;
  distance?: number;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, distance = 26, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - delay * fps,
    fps,
    config: { damping: 200, mass: 0.7 },
    durationInFrames: 26,
  });
  return (
    <div
      style={{
        opacity: enter,
        translate: `0px ${(1 - enter) * distance}px`,
        ...style,
      }}
    >
      {children}
    </div>
  );
};

/** A screenshot in a device-ish frame with a brand glow behind it. */
const Shot: React.FC<{
  file: string;
  width: number;
  radius?: number;
  label?: string;
  delay?: number;
}> = ({ file, width, radius = 22, label, delay = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - delay * fps,
    fps,
    config: { damping: 200, mass: 0.9 },
    durationInFrames: 30,
  });
  return (
    <div style={{ width }}>
      <div
        style={{
          // In flow, NOT absolute: an absolutely positioned screenshot paints
          // over the headline that sits above it in the flex column.
          width,
          marginTop: 8,
          borderRadius: radius,
          overflow: "hidden",
          border: `1px solid ${C.line}`,
          boxShadow: `0 40px 120px #00000099, 0 0 90px ${C.accent}33`,
          opacity: enter,
          scale: String(0.94 + enter * 0.06),
          translate: `0px ${(1 - enter) * 40}px`,
          background: C.bgElevated,
        }}
      >
        <Img src={staticFile(file)} style={{ width: "100%", display: "block" }} />
      </div>
      {label ? (
        <div
          style={{
            marginTop: 16,
            fontSize: 20,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.muted,
            fontWeight: 600,
            textAlign: "center",
          }}
        >
          {label}
        </div>
      ) : null}
    </div>
  );
};

const Wordmark: React.FC<{ size: number; sub?: string }> = ({ size, sub }) => (
  <div style={{ textAlign: "center" }}>
    <div
      style={{
        fontSize: size,
        fontWeight: 800,
        letterSpacing: "-0.03em",
        lineHeight: 1,
      }}
    >
      Omni<span style={{ color: C.accent }}>Claw</span>
    </div>
    {sub ? (
      <div
        style={{
          marginTop: 14,
          fontSize: size * 0.17,
          letterSpacing: "0.22em",
          textTransform: "uppercase",
          color: C.muted,
          fontWeight: 600,
        }}
      >
        {sub}
      </div>
    ) : null}
  </div>
);

// ── sound ────────────────────────────────────────────────────────────────────

/** The music bed plus every voice line, placed on its exact cue. */
const Soundtrack: React.FC = () => {
  const { fps } = useVideoConfig();
  const lines = (voiceover as { lines: VoiceLine[] }).lines;
  return (
    <>
      <Audio src={staticFile("music/bed.wav")} volume={1} />
      {lines.map((line) => (
        <Sequence key={line.id} from={Math.round((line.startMs / 1000) * fps)}>
          <Audio src={staticFile(`vo/${line.file}`)} volume={1} />
        </Sequence>
      ))}
    </>
  );
};

/** Burned-in captions, timed from the same manifest that places the audio. */
const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  const nowMs = (frame / fps) * 1000;
  const lines = (voiceover as { lines: VoiceLine[] }).lines;
  const active = lines.find((l) => nowMs >= l.startMs && nowMs <= l.endMs);
  if (!active) return null;
  const inMs = nowMs - active.startMs;
  const outMs = active.endMs - nowMs;
  const opacity =
    Math.min(
      interpolate(inMs, [0, 220], [0, 1], { ...CLAMP, easing: Easing.out(Easing.cubic) }),
      interpolate(outMs, [0, 220], [0, 1], { ...CLAMP, easing: Easing.in(Easing.cubic) }),
    );
  const rise = interpolate(inMs, [0, 260], [14, 0], { ...CLAMP, easing: Easing.out(Easing.cubic) });
  const tall = height >= 1600;
  return (
    <div
      style={{
        position: "absolute",
        left: tall ? 70 : 40,
        right: tall ? 70 : 40,
        bottom: tall ? 96 : 34,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          maxWidth: tall ? 900 : 880,
          padding: tall ? "20px 30px" : "14px 22px",
          borderRadius: tall ? 18 : 14,
          background: "#0f1011e6",
          border: `1px solid ${C.line}`,
          color: C.text,
          // The caption sits OUTSIDE the Backdrop, so it must name the font
          // itself — otherwise it inherits the document's serif default.
          fontFamily: FONT,
          fontSize: tall ? 40 : 28,
          fontWeight: 700,
          lineHeight: 1.24,
          textAlign: "center",
          letterSpacing: "-0.01em",
          opacity,
          translate: `0px ${rise}px`,
        }}
      >
        {active.text}
      </div>
    </div>
  );
};

// ── scenes ───────────────────────────────────────────────────────────────────

const SceneHook: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const fade = interpolate(frame, [0, 0.4 * fps], [0, 1], {
    ...CLAMP,
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const out = interpolate(frame, [3.3 * fps, 3.9 * fps], [1, 0], CLAMP);
  return (
    <AbsoluteFill style={{ opacity: Math.min(fade, out) }}>
      <Backdrop>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 140,
            textAlign: "center",
          }}
        >
          <Enter>
            <div
              style={{
                fontSize: 26,
                letterSpacing: "0.24em",
                textTransform: "uppercase",
                color: C.muted,
                fontWeight: 600,
                marginBottom: 44,
              }}
            >
              Local-first AI agent platform
            </div>
          </Enter>
          <Enter delay={0.25}>
            <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1.06, letterSpacing: "-0.035em" }}>
              Your AI agent
            </div>
          </Enter>
          <Enter delay={0.5}>
            <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1.06, letterSpacing: "-0.035em" }}>
              shouldn&apos;t live
            </div>
          </Enter>
          <Enter delay={0.75}>
            <div
              style={{
                fontSize: 88,
                fontWeight: 800,
                lineHeight: 1.06,
                letterSpacing: "-0.035em",
                whiteSpace: "nowrap",
              }}
            >
              in <span style={{ color: C.accent }}>someone&apos;s cloud</span>
            </div>
          </Enter>
          <Enter delay={1.5} style={{ marginTop: 64 }}>
            <Wordmark size={64} sub="Windows · on your machine" />
          </Enter>
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

const ProblemRow: React.FC<{ what: string; where: string; delay: number }> = ({
  what,
  where,
  delay,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({
    frame: frame - delay * fps,
    fps,
    config: { damping: 200, mass: 0.7 },
    durationInFrames: 24,
  });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 22,
        opacity: enter,
        translate: `0px ${(1 - enter) * 24}px`,
      }}
    >
      <div style={{ fontSize: 62, fontWeight: 800, letterSpacing: "-0.03em" }}>
        {what}
      </div>
      <div style={{ fontSize: 44, color: C.muted, fontWeight: 600 }}>
        {where}
      </div>
    </div>
  );
};

const SceneProblem: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(frame, [4.2 * fps, 4.8 * fps], [1, 0], CLAMP);
  const punch = spring({
    frame: frame - 3.1 * fps,
    fps,
    config: { damping: 12, mass: 0.6 },
    durationInFrames: 22,
  });
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Backdrop glow={C.warn}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: 130,
            gap: 40,
          }}
        >
          <div
            style={{
              fontSize: 26,
              letterSpacing: "0.24em",
              textTransform: "uppercase",
              color: C.muted,
              fontWeight: 600,
              marginBottom: 10,
            }}
          >
            The usual deal
          </div>
          <ProblemRow what="Your code" where="on their server" delay={0.2} />
          <ProblemRow what="Your API keys" where="in their vault" delay={0.8} />
          <div
            style={{
              marginTop: 40,
              fontSize: 60,
              fontWeight: 800,
              letterSpacing: "-0.03em",
              opacity: punch,
              scale: String(0.96 + punch * 0.04),
            }}
          >
            That&apos;s not an agent.
            <br />
            <span style={{ color: C.warn }}>That&apos;s a tab.</span>
          </div>
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

const SceneProduct: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(frame, [5.9 * fps, 6.5 * fps], [1, 0], CLAMP);
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Backdrop>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Enter>
            <div style={{ fontSize: 58, fontWeight: 800, letterSpacing: "-0.03em" }}>
              A real agent workspace
            </div>
          </Enter>
          <Enter delay={0.2}>
            <div style={{ marginTop: 14, fontSize: 30, color: C.muted, fontWeight: 500 }}>
              Chat, tools, memory, skills, approvals — one app on your machine
            </div>
          </Enter>
          <Shot file="workspace.png" width={860} label="OmniClaw Next" delay={0.35} />
          <Enter delay={0.9} style={{ position: "absolute", bottom: 190 }}>
            <div style={{ fontSize: 34, color: C.textDim, fontWeight: 600 }}>
              It plans, it uses tools, it shows its work.
            </div>
          </Enter>
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

/** A feature card: one real screenshot + a claim. */
const FeatureCard: React.FC<{
  file: string;
  title: string;
  line: string;
  tint: string;
  label?: string;
  width?: number;
}> = ({ file, title, line, tint, label, width = 820 }) => {
  const frame = useCurrentFrame();
  const { fps, height } = useVideoConfig();
  // The square format is half as tall: the card has to shrink with it, or it
  // overflows the frame.
  const k = Math.min(1, (height - 160) / 1120);
  // The square format has no room for the caption under the card: reserve it.
  const captionSpace = height >= 1600 ? 0 : 190;
  const enter = spring({
    frame: frame - 0.15 * fps,
    fps,
    config: { damping: 200, mass: 0.9 },
    durationInFrames: 28,
  });
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: `${Math.round(110 * k)}px ${Math.round(110 * k)}px ${Math.round(110 * k + captionSpace)}px`,
        opacity: enter,
        translate: `0px ${(1 - enter) * 30}px`,
      }}
    >
      <Shot file={file} width={Math.round(width * k)} delay={0.25} label={label} />
      <div
        style={{
          marginTop: 54 * k,
          fontSize: Math.round(58 * k),
          fontWeight: 800,
          letterSpacing: "-0.03em",
          textAlign: "center",
        }}
      >
        {title}
      </div>
      <div
        style={{
          marginTop: Math.round(16 * k),
          fontSize: Math.round(34 * k),
          color: tint,
          fontWeight: 600,
          textAlign: "center",
        }}
      >
        {line}
      </div>
    </div>
  );
};

const SceneFeatures: React.FC<{ cards: { file: string; title: string; line: string; tint: string; label?: string; width?: number }[]; each: number }> = ({
  cards,
  each,
}) => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Backdrop>
        {cards.map((card, i) => (
          <Sequence
            key={card.file}
            from={i * each}
            durationInFrames={each}
            premountFor={fps}
          >
            <FeatureCard {...card} />
          </Sequence>
        ))}
      </Backdrop>
    </AbsoluteFill>
  );
};

const SceneCta: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(frame, [6.2 * fps, 6.8 * fps], [1, 0], CLAMP);
  const chip = (label: string, color: string, delay: number) => {
    const f = frame - delay * fps;
    const e = spring({
      frame: f,
      fps,
      config: { damping: 200, mass: 0.6 },
      durationInFrames: 22,
    });
    return (
      <div
        style={{
          padding: "16px 28px",
          borderRadius: 999,
          border: `1px solid ${C.line}`,
          background: C.bgSoft,
          color,
          fontSize: 28,
          fontWeight: 700,
          letterSpacing: "0.02em",
          opacity: e,
          scale: String(0.9 + e * 0.1),
        }}
      >
        {label}
      </div>
    );
  };
  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Backdrop>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 40,
            padding: 120,
            textAlign: "center",
          }}
        >
          <Enter>
            <Wordmark size={110} />
          </Enter>
          <Enter delay={0.35}>
            <div style={{ fontSize: 44, color: C.textDim, fontWeight: 600 }}>
              Local-first. Yours. Windows.
            </div>
          </Enter>
          <Enter delay={0.6}>
            <div
              style={{
                marginTop: 10,
                padding: "22px 38px",
                borderRadius: 16,
                background: C.accent,
                color: "#ffffff",
                fontSize: 38,
                fontWeight: 800,
                letterSpacing: "-0.01em",
              }}
            >
              Download for Windows
            </div>
          </Enter>
          <Enter delay={0.8}>
            <div style={{ fontSize: 30, color: C.muted, fontWeight: 500 }}>
              github.com/jaatkundu90346-png/omniclaw
            </div>
          </Enter>
          <div
            style={{
              display: "flex",
              gap: 16,
              marginTop: 30,
              flexWrap: "wrap",
              justifyContent: "center",
            }}
          >
            {chip("87/87 tests green", C.ok, 1.0)}
            {chip("No cloud account", C.accent, 1.2)}
            {chip("MIT licensed", C.textDim, 1.4)}
          </div>
        </div>
      </Backdrop>
    </AbsoluteFill>
  );
};

// ── composition ──────────────────────────────────────────────────────────────

/** The four feature cards: the toolbox, the task, the build, the report. */
const FEATURE_CARDS = [
  {
    file: "tools.png",
    title: "Two hundred tools",
    line: "All running on your own machine",
    tint: C.accent,
    label: "Skills & Tools",
    width: 860,
  },
  {
    file: "working-session.png",
    title: "Give it a task",
    line: "It plans, calls tools, shows every step",
    tint: C.text,
    label: "A real OmniClaw session",
    width: 800,
  },
  {
    file: "built-output.png",
    title: "Then it builds it",
    line: "And you watch it live",
    tint: C.ok,
    label: "Written by the agent, on your machine",
    width: 880,
  },
  {
    file: "working-answer.png",
    title: "And it reports",
    line: "Exactly what it made",
    tint: C.textDim,
    label: "The agent's own report",
    width: 790,
  },
];

export const OmniClawAd: React.FC = () => {
  const { fps } = useVideoConfig();
  return (
    <AbsoluteFill>
      <Soundtrack />
      <Sequence from={0 * fps} durationInFrames={4 * fps} premountFor={fps}>
        <SceneHook />
      </Sequence>
      <Sequence from={4 * fps} durationInFrames={5 * fps} premountFor={fps}>
        <SceneProblem />
      </Sequence>
      <Sequence from={9 * fps} durationInFrames={7 * fps} premountFor={fps}>
        <SceneProduct />
      </Sequence>
      <Sequence from={16 * fps} durationInFrames={22 * fps} premountFor={fps}>
        <SceneFeatures cards={FEATURE_CARDS} each={5.5 * fps} />
      </Sequence>
      <Sequence from={38 * fps} durationInFrames={8 * fps} premountFor={fps}>
        <SceneCta />
      </Sequence>
      {/* Captions LAST: a scene's background paints over anything before it. */}
      <Captions />
    </AbsoluteFill>
  );
};
