import swordsSvg   from 'lucide-static/icons/swords.svg?raw';
import shieldSvg   from 'lucide-static/icons/shield-alert.svg?raw';
import landmarkSvg from 'lucide-static/icons/landmark.svg?raw';
import sunSvg      from 'lucide-static/icons/sun.svg?raw';
import flameSvg    from 'lucide-static/icons/flame.svg?raw';
import compassSvg  from 'lucide-static/icons/compass.svg?raw';
import flaskSvg    from 'lucide-static/icons/flask-conical.svg?raw';
import paletteSvg  from 'lucide-static/icons/palette.svg?raw';
import type { Category } from '../types';

export const CATEGORY_SVGS: Partial<Record<Category, string>> = {
  battle:      swordsSvg,
  war:         shieldSvg,
  politics:    landmarkSvg,
  religion:    sunSvg,
  disaster:    flameSvg,
  exploration: compassSvg,
  science:     flaskSvg,
  culture:     paletteSvg,
};

/** Replace currentColor with the given color in a Lucide SVG string. */
export function colorSvg(raw: string, color: string): string {
  return raw.replace(/currentColor/g, color);
}

/** Return a data URI suitable for <img src> or CSS url(). */
export function svgDataUri(raw: string): string {
  return `data:image/svg+xml,${encodeURIComponent(raw)}`;
}
