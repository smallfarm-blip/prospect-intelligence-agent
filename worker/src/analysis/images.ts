import { createHash } from "node:crypto";
import sharp from "sharp";

/** Provider guidance: long edge at most ~1568 px and ~1.15 megapixels avoids server-side downscaling. */
export const MAX_LONG_EDGE = 1568;
export const MAX_PIXELS = 1_150_000;
export const JPEG_QUALITY = 80;

export interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PreparedPixels {
  jpeg: Buffer;
  crop: Crop;
  scaledWidth: number;
  scaledHeight: number;
  estimatedTokens: number;
}

export interface ImageInfo {
  width: number;
  height: number;
  blank: boolean;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Anthropic's published approximation for image input tokens. */
export function estimateImageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}

export function fitWithinLimits(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_LONG_EDGE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
}

export async function inspectImage(buf: Buffer): Promise<ImageInfo> {
  const image = sharp(buf);
  const meta = await image.metadata();
  const stats = await image.stats();
  const blank = stats.channels.slice(0, 3).every((c) => c.stdev < 3);
  return { width: meta.width ?? 0, height: meta.height ?? 0, blank };
}

export async function prepareRegion(buf: Buffer, crop: Crop): Promise<PreparedPixels> {
  const size = fitWithinLimits(crop.width, crop.height);
  const jpeg = await sharp(buf)
    .extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height })
    .resize(size.width, size.height, { fit: "fill" })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return { jpeg, crop, scaledWidth: size.width, scaledHeight: size.height, estimatedTokens: estimateImageTokens(size.width, size.height) };
}

/**
 * Plans readable sections of a tall full-page image. The first screen is skipped because the
 * after-dismissal viewport screenshot already shows it. Sections overlap slightly so text cut at
 * a boundary appears whole in one of them; the last section is aligned to the bottom so no sliver
 * is cut off. Anything below the last section is reported, not hidden.
 */
export function planSections(
  imageWidth: number,
  imageHeight: number,
  sectionHeight: number,
  maxSections: number,
  overlap = 0.1,
): { sections: Crop[]; unanalysed: { fromY: number; toY: number } | null } {
  const sections: Crop[] = [];
  const step = Math.max(1, Math.floor(sectionHeight * (1 - overlap)));
  let coveredTo = Math.min(sectionHeight, imageHeight);
  let y = coveredTo;
  while (coveredTo < imageHeight && sections.length < maxSections) {
    const top = Math.max(0, Math.min(y, imageHeight - sectionHeight));
    const height = Math.min(sectionHeight, imageHeight - top);
    sections.push({ x: 0, y: top, width: imageWidth, height });
    coveredTo = top + height;
    y = top + step;
  }
  return { sections, unanalysed: coveredTo < imageHeight ? { fromY: coveredTo, toY: imageHeight } : null };
}
