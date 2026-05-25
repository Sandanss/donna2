import Svg, { Rect, G, Circle } from "react-native-svg";

type FlagProps = {
  size?: number;
};

// Simplified US flag: 13 red/white stripes, blue canton with star pattern.
// Designed to read cleanly at ~28px. ViewBox 60x40 keeps the 3:2 aspect ratio.
export function FlagUS({ size = 28 }: FlagProps) {
  const stripeH = 40 / 13;
  const redStripeRows = [0, 2, 4, 6, 8, 10, 12];

  return (
    <Svg width={size} height={(size * 2) / 3} viewBox="0 0 60 40">
      <Rect width="60" height="40" fill="#FFFFFF" rx="3" ry="3" />
      <G>
        {redStripeRows.map((row) => (
          <Rect
            key={row}
            x="0"
            y={row * stripeH}
            width="60"
            height={stripeH}
            fill="#B22234"
          />
        ))}
      </G>
      <Rect x="0" y="0" width="24" height={stripeH * 7} fill="#3C3B6E" />
      <G fill="#FFFFFF">
        {[0, 1, 2].map((row) =>
          [0, 1, 2, 3].map((col) => (
            <Circle
              key={`${row}-${col}`}
              cx={3.5 + col * 5.5}
              cy={3 + row * 6}
              r="1.1"
            />
          ))
        )}
      </G>
    </Svg>
  );
}
