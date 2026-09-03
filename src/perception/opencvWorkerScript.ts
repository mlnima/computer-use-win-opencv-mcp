import { openCvDescriptorSource } from './opencvWorkerDescriptors';

export const openCvWorkerSource = String.raw`
const readline = require('node:readline');
const cvPackage = require(process.env.COMPUTER_USE_OPENCV_MODULE);
const sharpPackage = require(process.env.COMPUTER_USE_SHARP_MODULE);
const sharp = sharpPackage.default || sharpPackage;
let cvPromise;
let queue = Promise.resolve();
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const area = (bounds) => Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
${openCvDescriptorSource}
const getCv = () => {
  cvPromise ||= (async () => {
    const cv = await Promise.resolve(cvPackage.default || cvPackage);
    if (cv.Mat) return cv;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCV initialization timed out.')), 15000);
      cv.onRuntimeInitialized = () => {
        clearTimeout(timer);
        resolve(cv);
      };
    });
  })();
  return cvPromise.catch((error) => {
    cvPromise = undefined;
    throw error;
  });
};
const overlap = (first, second) => {
  const intersection = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left)) *
    Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  const union = area(first) + area(second) - intersection;
  return union > 0 ? intersection / union : 0;
};
const hierarchyValue = (hierarchy, index, field) => hierarchy.data32S[index * 4 + field] ?? -1;
const hierarchyDepth = (hierarchy, index) => {
  let depth = 0;
  let parent = hierarchyValue(hierarchy, index, 3);
  while (parent >= 0 && depth < 64) {
    depth += 1;
    parent = hierarchyValue(hierarchy, parent, 3);
  }
  return depth;
};
const holeCount = (hierarchy, index) => {
  let count = 0;
  let child = hierarchyValue(hierarchy, index, 2);
  while (child >= 0 && count < 64) {
    count += 1;
    child = hierarchyValue(hierarchy, child, 0);
  }
  return count;
};
const interiorPoint = (cv, contours, hierarchy, index, bounds) => {
  const width = Math.max(1, Math.round(bounds.right - bounds.left));
  const height = Math.max(1, Math.round(bounds.bottom - bounds.top));
  const contour = contours.get(index);
  const holes = [];
  try {
    let child = hierarchyValue(hierarchy, index, 2);
    while (child >= 0 && holes.length < 24) {
      holes.push(contours.get(child));
      child = hierarchyValue(hierarchy, child, 0);
    }
    const center = { x: (bounds.left + bounds.right - 1) / 2, y: (bounds.top + bounds.bottom - 1) / 2 };
    let selected;
    let selectedRadius = 0;
    let selectedDistance = Number.POSITIVE_INFINITY;
    const consider = (x, y) => {
      const point = new cv.Point(clamp(x, bounds.left, bounds.right - 1), clamp(y, bounds.top, bounds.bottom - 1));
      let radius = cv.pointPolygonTest(contour, point, true);
      if (radius < 0.9) return;
      for (const hole of holes) {
        const distance = cv.pointPolygonTest(hole, point, true);
        if (distance >= -0.9) return;
        radius = Math.min(radius, -distance);
      }
      const centerDistance = ((point.x - center.x) / width) ** 2 + ((point.y - center.y) / height) ** 2;
      if (radius > selectedRadius + 0.1 || Math.abs(radius - selectedRadius) <= 0.1 && centerDistance < selectedDistance) {
        selected = point;
        selectedRadius = radius;
        selectedDistance = centerDistance;
      }
    };
    for (let row = 0; row < 13; row += 1) for (let column = 0; column < 13; column += 1) {
      consider(bounds.left + width * (column + 0.5) / 13, bounds.top + height * (row + 0.5) / 13);
    }
    let stepX = width / 13;
    let stepY = height / 13;
    for (let round = 0; selected && round < 3; round += 1) {
      stepX /= 2;
      stepY /= 2;
      const origin = selected;
      for (let y = -1; y <= 1; y += 1) for (let x = -1; x <= 1; x += 1) consider(origin.x + x * stepX, origin.y + y * stepY);
    }
    if (!selected) return undefined;
    return {
      x: Math.round(selected.x),
      y: Math.round(selected.y),
      radius: Math.round(selectedRadius * 10) / 10
    };
  } finally {
    for (const hole of holes) hole.delete();
    contour.delete();
  }
};
const suppress = (elements, maximum, threshold) => {
  const kept = [];
  for (const element of elements.sort((first, second) => second.confidence - first.confidence || area(first.bounds) - area(second.bounds))) {
    if (!kept.some((entry) => overlap(entry.bounds, element.bounds) > threshold)) kept.push(element);
    if (kept.length >= maximum) break;
  }
  return kept;
};
const contoursFrom = (cv, source, original, width, height, scale, maximum, level, scaleIndex) => {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const binary = new cv.Mat();
  const edges = new cv.Mat();
  const otsu = new cv.Mat();
  const combined = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(source, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    const minimumDimension = Math.min(source.cols, source.rows);
    const block = Math.max(3, Math.min(level === 'deep' ? 31 : 15, minimumDimension % 2 === 1 ? minimumDimension : minimumDimension - 1));
    cv.adaptiveThreshold(blurred, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, block, 4);
    cv.Canny(blurred, edges, level === 'deep' ? 30 : 45, level === 'deep' ? 110 : 135);
    cv.bitwise_or(binary, edges, combined);
    if (level === 'deep') {
      cv.threshold(blurred, otsu, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);
      cv.bitwise_or(combined, otsu, combined);
    }
    cv.findContours(combined, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
    const proposals = [];
    const rawLimit = Math.min(level === 'deep' ? 5000 : 3000, Math.max(300, maximum * (level === 'deep' ? 8 : 5)));
    const scanLimit = level === 'deep' ? 12000 : 7000;
    const step = Math.max(1, Math.ceil(contours.size() / scanLimit));
    for (let index = 0; index < contours.size(); index += step) {
      if (hierarchyDepth(hierarchy, index) % 2 === 1) continue;
      const contour = contours.get(index);
      const approximation = new cv.Mat();
      try {
        const rectangle = cv.boundingRect(contour);
        const bounds = {
          left: clamp(Math.floor(rectangle.x / scale), 0, width - 1),
          top: clamp(Math.floor(rectangle.y / scale), 0, height - 1),
          right: clamp(Math.ceil((rectangle.x + rectangle.width) / scale), 1, width),
          bottom: clamp(Math.ceil((rectangle.y + rectangle.height) / scale), 1, height)
        };
        const boxArea = area(bounds);
        const contourArea = Math.abs(cv.contourArea(contour)) / (scale * scale);
        const fill = boxArea > 0 ? Math.min(1, contourArea / boxArea) : 0;
        const scaledPerimeter = cv.arcLength(contour, true);
        const perimeter = scaledPerimeter / scale;
        if (bounds.right - bounds.left < 8 || bounds.bottom - bounds.top < 8 || boxArea > width * height * 0.94 || boxArea < 64 || fill < 0.035 || perimeter < 16) continue;
        cv.approxPolyDP(contour, approximation, Math.max(1, scaledPerimeter * 0.02), true);
        const circularity = perimeter > 0 ? 4 * Math.PI * contourArea / (perimeter * perimeter) : 0;
        const confidence = Math.min(0.84, 0.34 + fill * 0.25 + Math.min(0.15, Math.sqrt(boxArea / (width * height))));
        proposals.push({
          index,
          scaledBounds: { left: rectangle.x, top: rectangle.y, right: rectangle.x + rectangle.width, bottom: rectangle.y + rectangle.height },
          bounds,
          fill,
          circularity,
          holes: holeCount(hierarchy, index),
          vertices: approximation.rows,
          confidence,
          scale
        });
        if (proposals.length >= rawLimit * 2) {
          const reduced = suppress(proposals, rawLimit, 0.9);
          proposals.length = 0;
          proposals.push(...reduced);
        }
      } finally {
        approximation.delete();
        contour.delete();
      }
    }
    const selected = suppress(proposals, Math.min(rawLimit, maximum + 160), 0.88);
    return selected.flatMap((proposal) => {
      const point = interiorPoint(cv, contours, hierarchy, proposal.index, proposal.scaledBounds);
      if (!point) return [];
      const safePoint = {
        x: clamp(Math.round(point.x / scale), proposal.bounds.left, proposal.bounds.right - 1),
        y: clamp(Math.round(point.y / scale), proposal.bounds.top, proposal.bounds.bottom - 1)
      };
      const resolved = {
        ...proposal,
        safePoint,
        safeRadius: point.radius / scale,
        confidence: Math.min(0.91, proposal.confidence + Math.min(0.1, point.radius / 20))
      };
      const descriptor = describe(original, resolved, width, height, level);
      return [{
        ...descriptor,
        id: 'opencv:' + scaleIndex + ':' + proposal.index,
        bounds: proposal.bounds,
        safePoint,
        confidence: resolved.confidence,
        enabled: true,
        focused: false,
        offscreen: false,
        actions: ['click', 'drag'],
        sources: ['opencv']
      }];
    });
  } finally {
    hierarchy.delete();
    contours.delete();
    combined.delete();
    otsu.delete();
    edges.delete();
    binary.delete();
    blurred.delete();
    gray.delete();
  }
};
const analyze = async (message) => {
  const cv = await getCv();
  const prepared = await sharp(Buffer.from(message.image, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const source = new cv.Mat(prepared.info.height, prepared.info.width, cv.CV_8UC4);
  const level = message.analysisLevel === 'deep' ? 'deep' : 'standard';
  const maximum = clamp(Number.isFinite(message.maxElements) ? Math.round(message.maxElements) : 1, 1, 2000);
  try {
    source.data.set(prepared.data);
    if (source.cols < 3 || source.rows < 3) return [];
    const scales = level === 'deep' ? [1, 0.65, 0.4] : [1];
    const elements = [];
    for (let index = 0; index < scales.length; index += 1) {
      const scale = scales[index];
      const scaled = scale === 1 ? source : new cv.Mat();
      try {
        if (scale !== 1) cv.resize(source, scaled, new cv.Size(Math.max(3, Math.round(source.cols * scale)), Math.max(3, Math.round(source.rows * scale))), 0, 0, cv.INTER_AREA);
        elements.push(...contoursFrom(cv, scaled, source, source.cols, source.rows, scale, maximum, level, index));
      } finally {
        if (scale !== 1) scaled.delete();
      }
    }
    return suppress(elements, maximum, level === 'deep' ? 0.8 : 0.88)
      .sort((first, second) => first.bounds.top - second.bounds.top || first.bounds.left - second.bounds.left || area(first.bounds) - area(second.bounds))
      .map((element, index) => ({ ...element, id: 'opencv:' + (index + 1) }));
  } finally {
    source.delete();
  }
};
const run = async (message) => {
  if (message.op === 'close') {
    send({ id: message.id, ok: true });
    process.exit(0);
  }
  send({ id: message.id, ok: true, elements: await analyze(message) });
};
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  queue = queue.catch(() => undefined).then(async () => {
    let message;
    try {
      message = JSON.parse(line);
      await run(message);
    } catch (error) {
      send({ id: message?.id || '', ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
});`;
