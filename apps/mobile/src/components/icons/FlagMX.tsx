import Svg, { Rect, Circle } from "react-native-svg";

type FlagProps = {
  size?: number;
};

// Simplified Mexico flag: three vertical bands (green/white/red) with a small
// brown disc in the center as a stand-in for the national emblem. Reads cleanly
// at ~28px; the disc is omitted at sizes that would render it as a single pixel.
export function FlagMX({ size = 28 }: FlagProps) {
  const showEmblem = size >= 20;

  return (
    <Svg width={size} height={(size * 2) / 3} viewBox="0 0 60 40">
      <Rect width="60" height="40" fill="#FFFFFF" rx="3" ry="3" />
      <Rect x="0" y="0" width="20" height="40" fill="#006847" />
      <Rect x="40" y="0" width="20" height="40" fill="#CE1126" />
      {showEmblem && <Circle cx="30" cy="20" r="4" fill="#8B4513" />}
    </Svg>
  );
}
