export type NormalizedRect = {
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
};

export function rectanglesOverlap(a: NormalizedRect, b: NormalizedRect): boolean {
  const aRight = a.cropX + a.cropWidth;
  const aBottom = a.cropY + a.cropHeight;
  const bRight = b.cropX + b.cropWidth;
  const bBottom = b.cropY + b.cropHeight;

  return a.cropX < bRight && aRight > b.cropX && a.cropY < bBottom && aBottom > b.cropY;
}

/** Every overlapping pair among a set of rectangles - used for a non-blocking warning, never to prevent saving. */
export function findOverlappingPairs<T extends NormalizedRect & { id: string }>(rects: T[]): Array<[T, T]> {
  const pairs: Array<[T, T]> = [];

  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectanglesOverlap(rects[i], rects[j])) {
        pairs.push([rects[i], rects[j]]);
      }
    }
  }

  return pairs;
}

export function pixelDimensionsForRect(rect: NormalizedRect, frameWidth: number, frameHeight: number) {
  return {
    width: Math.max(1, Math.round(rect.cropWidth * frameWidth)),
    height: Math.max(1, Math.round(rect.cropHeight * frameHeight)),
  };
}
