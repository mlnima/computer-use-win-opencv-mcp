export const openCvDescriptorSource = String.raw`
const colorFor = (red, green, blue) => {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
  if (maximum < 30) return 'black';
  if (minimum > 232) return 'white';
  if (delta < 24 || delta / Math.max(1, maximum) < 0.14) return luminance < 0.28 ? 'dark gray' : luminance > 0.76 ? 'light gray' : 'gray';
  let hue = maximum === red
    ? 60 * ((green - blue) / delta % 6)
    : maximum === green ? 60 * ((blue - red) / delta + 2) : 60 * ((red - green) / delta + 4);
  if (hue < 0) hue += 360;
  if (hue < 15 || hue >= 345) return 'red';
  if (hue < 42) return luminance < 0.43 ? 'brown' : 'orange';
  if (hue < 68) return 'yellow';
  if (hue < 165) return 'green';
  if (hue < 195) return 'cyan';
  if (hue < 255) return 'blue';
  if (hue < 290) return 'purple';
  return 'magenta';
};
const appearanceFor = (image, bounds) => {
  const counts = new Map();
  let luminance = 0;
  let samples = 0;
  const width = Math.max(1, bounds.right - bounds.left);
  const height = Math.max(1, bounds.bottom - bounds.top);
  const visited = new Set();
  for (let row = 0; row < 7; row += 1) for (let column = 0; column < 7; column += 1) {
    const x = clamp(Math.round(bounds.left + width * (0.15 + column * 0.7 / 6)), 0, image.cols - 1);
    const y = clamp(Math.round(bounds.top + height * (0.15 + row * 0.7 / 6)), 0, image.rows - 1);
    const pixel = y * image.cols + x;
    if (visited.has(pixel)) continue;
    visited.add(pixel);
    const offset = pixel * 4;
    const red = image.data[offset];
    const green = image.data[offset + 1];
    const blue = image.data[offset + 2];
    const color = colorFor(red, green, blue);
    counts.set(color, (counts.get(color) || 0) + 1);
    luminance += (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    samples += 1;
  }
  const dominant = [...counts].sort((first, second) => second[1] - first[1] || first[0].localeCompare(second[0]))[0]?.[0] || 'unknown';
  const average = samples > 0 ? luminance / samples : 0;
  return { color: dominant, luminance: average, tone: average < 0.28 ? 'dark' : average > 0.76 ? 'bright' : 'mid-tone' };
};
const positionFor = (point, width, height) => {
  const horizontal = point.x < width * 0.34 ? 'left' : point.x > width * 0.66 ? 'right' : 'center';
  const vertical = point.y < height * 0.34 ? 'top' : point.y > height * 0.66 ? 'bottom' : 'middle';
  return horizontal === 'center' && vertical === 'middle' ? 'center' : vertical === 'middle' ? horizontal : horizontal === 'center' ? vertical : vertical + ' ' + horizontal;
};
const sizeFor = (ratio) => ratio < 0.0003 ? 'tiny' : ratio < 0.003 ? 'small' : ratio < 0.03 ? 'medium' : ratio < 0.18 ? 'large' : 'very large';
const aspectFor = (ratio) => ratio >= 6 ? 'very wide' : ratio >= 2.2 ? 'wide' : ratio <= 1 / 6 ? 'very tall' : ratio <= 1 / 2.2 ? 'tall' : ratio >= 0.82 && ratio <= 1.22 ? 'balanced' : ratio > 1 ? 'horizontal' : 'vertical';
const fillFor = (fill, holes) => holes > 0 ? 'ringed' : fill < 0.2 ? 'sparse' : fill < 0.5 ? 'outlined' : fill < 0.78 ? 'filled' : 'solid';
const shapeFor = (vertices, circularity, aspect) => {
  if (aspect >= 7) return 'horizontal line';
  if (aspect <= 1 / 7) return 'vertical line';
  if (vertices === 3) return 'triangle';
  if (circularity >= 0.74 && aspect >= 0.75 && aspect <= 1.34) return 'circle';
  if (vertices === 4) return aspect >= 0.84 && aspect <= 1.2 ? 'square' : 'rectangle';
  if (vertices === 5) return 'pentagon';
  if (vertices === 6) return 'hexagon';
  if (vertices <= 9 && circularity >= 0.5) return 'rounded polygon';
  return circularity >= 0.58 ? 'rounded shape' : 'irregular shape';
};
const describe = (image, proposal, width, height, level) => {
  const boxArea = area(proposal.bounds);
  const areaRatio = boxArea / Math.max(1, width * height);
  const aspect = (proposal.bounds.right - proposal.bounds.left) / Math.max(1, proposal.bounds.bottom - proposal.bounds.top);
  const appearance = appearanceFor(image, proposal.bounds);
  const position = positionFor(proposal.safePoint, width, height);
  const size = sizeFor(areaRatio);
  const aspectLabel = aspectFor(aspect);
  const fillLabel = fillFor(proposal.fill, proposal.holes);
  const shape = shapeFor(proposal.vertices, proposal.circularity, aspect);
  const topology = proposal.holes === 0 ? 'no holes' : proposal.holes === 1 ? 'one hole' : proposal.holes + ' holes';
  const role = aspect >= 4 || aspect <= 0.25 ? 'bar' : size === 'tiny' || size === 'small' ? 'icon' : size === 'very large' ? 'region' : 'visual';
  return {
    role,
    name: position + ' ' + size + ' ' + appearance.color + ' ' + shape,
    value: aspectLabel + '; ' + fillLabel + '; ' + topology + '; ' + appearance.tone,
    evidence: [
      'opencv:' + level,
      'scale=' + proposal.scale.toFixed(2),
      'shape=' + shape,
      'topology=' + topology,
      'aspect=' + aspectLabel + ':' + aspect.toFixed(2),
      'fill=' + fillLabel + ':' + proposal.fill.toFixed(2),
      'size=' + size + ':' + (areaRatio * 100).toFixed(3) + '%',
      'position=' + position,
      'color=' + appearance.color,
      'luminance=' + appearance.tone + ':' + appearance.luminance.toFixed(2),
      'safeRadius=' + proposal.safeRadius.toFixed(1)
    ]
  };
};`;
