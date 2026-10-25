export type StairStep = { center: [number, number, number]; size: [number, number, number] };

/** Matches StairSteps in the mapper. Steps rise on local +Y and run toward local +Z. */
export const STAIR_RISER_METERS = 0.18;

export function stairStepCount(height: number): number {
  const steps = Math.round(Math.abs(height) / STAIR_RISER_METERS);
  return Math.min(30, Math.max(2, steps));
}

export function stairBoxes(dimensions: [number, number, number]): StairStep[] {
  const width = Math.max(Math.abs(dimensions[0]), 0.05);
  const height = Math.max(Math.abs(dimensions[1]), 0.05);
  const depth = Math.max(Math.abs(dimensions[2]), 0.05);
  const count = stairStepCount(height);
  const riser = height / count;
  const tread = depth / count;
  return Array.from({ length: count }, (_, index) => {
    const stepHeight = riser * (index + 1);
    const z0 = -depth / 2 + tread * index;
    return {
      center: [0, -height / 2 + stepHeight / 2, z0 + tread / 2],
      size: [width, stepHeight, tread],
    };
  });
}
