export const openCvWorkerSource = String.raw`
const readline = require('node:readline');
const cvPackage = require(process.env.COMPUTER_USE_OPENCV_MODULE);
const sharpPackage = require(process.env.COMPUTER_USE_SHARP_MODULE);
const sharp = sharpPackage.default || sharpPackage;
let cvPromise;
let queue = Promise.resolve();
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
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
const area = (bounds) => Math.max(0, bounds.right - bounds.left) * Math.max(0, bounds.bottom - bounds.top);
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
  while (parent >= 0) {
    depth += 1;
    parent = hierarchyValue(hierarchy, parent, 3);
  }
  return depth;
};
const interiorPoint = (cv, contours, hierarchy, index, bounds) => {
  const width = Math.max(1, Math.round(bounds.right - bounds.left));
  const height = Math.max(1, Math.round(bounds.bottom - bounds.top));
  const mask = cv.Mat.zeros(height + 2, width + 2, cv.CV_8UC1);
  const distance = new cv.Mat();
  try {
    const offset = new cv.Point(1 - bounds.left, 1 - bounds.top);
    cv.drawContours(mask, contours, index, new cv.Scalar(255), cv.FILLED, cv.LINE_8, hierarchy, 0, offset);
    let child = hierarchyValue(hierarchy, index, 2);
    while (child >= 0) {
      cv.drawContours(mask, contours, child, new cv.Scalar(0), cv.FILLED, cv.LINE_8, hierarchy, 0, offset);
      child = hierarchyValue(hierarchy, child, 0);
    }
    cv.distanceTransform(mask, distance, cv.DIST_L2, 5);
    const maximum = cv.minMaxLoc(distance);
    if (!maximum.maxLoc || maximum.maxVal < 0.9) return undefined;
    return {
      x: Math.round(bounds.left + maximum.maxLoc.x - 1),
      y: Math.round(bounds.top + maximum.maxLoc.y - 1)
    };
  } finally {
    distance.delete();
    mask.delete();
  }
};
const roleFor = (bounds, vertices) => {
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  return width > height * 4 || height > width * 4 ? 'bar' : vertices === 4 ? 'region' : width <= 64 && height <= 64 ? 'icon' : 'visual';
};
const suppress = (elements, maximum) => {
  const kept = [];
  for (const element of elements.sort((first, second) => second.confidence - first.confidence || area(first.bounds) - area(second.bounds))) {
    if (!kept.some((entry) => overlap(entry.bounds, element.bounds) > 0.88)) kept.push(element);
    if (kept.length >= maximum) break;
  }
  return kept;
};
const contoursFrom = (cv, image, width, height, maximum) => {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const binary = new cv.Mat();
  const edges = new cv.Mat();
  const combined = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.cvtColor(image, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    cv.adaptiveThreshold(blurred, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 15, 4);
    cv.Canny(blurred, edges, 45, 135);
    cv.bitwise_or(binary, edges, combined);
    cv.findContours(combined, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
    const imageArea = width * height;
    const proposals = [];
    for (let index = 0; index < contours.size(); index += 1) {
      if (hierarchyDepth(hierarchy, index) % 2 === 1) continue;
      const contour = contours.get(index);
      const approximation = new cv.Mat();
      try {
        const rectangle = cv.boundingRect(contour);
        const bounds = { left: rectangle.x, top: rectangle.y, right: rectangle.x + rectangle.width, bottom: rectangle.y + rectangle.height };
        const boxArea = area(bounds);
        const contourArea = Math.abs(cv.contourArea(contour));
        const fill = boxArea > 0 ? contourArea / boxArea : 0;
        if (rectangle.width < 8 || rectangle.height < 8 || boxArea > imageArea * 0.92 || boxArea < 64 || fill < 0.04) continue;
        cv.approxPolyDP(contour, approximation, Math.max(1, cv.arcLength(contour, true) * 0.02), true);
        proposals.push({
          index,
          bounds,
          vertices: approximation.rows,
          confidence: Math.min(0.86, 0.38 + fill * 0.34 + Math.min(0.14, boxArea / imageArea))
        });
      } finally {
        approximation.delete();
        contour.delete();
      }
    }
    const selected = suppress(proposals, Math.min(2500, maximum + Math.min(200, maximum)));
    const elements = selected.flatMap((proposal) => {
      const safePoint = interiorPoint(cv, contours, hierarchy, proposal.index, proposal.bounds);
      return safePoint ? [{
        id: 'opencv:' + proposal.index,
        role: roleFor(proposal.bounds, proposal.vertices),
        name: '',
        bounds: proposal.bounds,
        safePoint,
        confidence: proposal.confidence,
        enabled: true,
        focused: false,
        offscreen: false,
        actions: ['click', 'drag'],
        sources: ['opencv']
      }] : [];
    });
    return elements.slice(0, maximum);
  } finally {
    hierarchy.delete();
    contours.delete();
    combined.delete();
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
  try {
    source.data.set(prepared.data);
    return contoursFrom(cv, source, prepared.info.width, prepared.info.height, message.maxElements);
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
