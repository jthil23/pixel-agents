/* eslint-disable pixel-agents/no-inline-colors -- Bitmap palette colors define the Home-AI pixel-art palette. */
export interface Bitmap {
  rows: string[];
  palette: Record<string, string>;
}

export function drawBitmap(
  ctx: CanvasRenderingContext2D,
  bmp: Bitmap,
  dx: number,
  dy: number,
  scale: number,
): void {
  bmp.rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === '.') continue;
      ctx.fillStyle = bmp.palette[ch];
      ctx.fillRect(
        Math.round(dx + c * scale),
        Math.round(dy + r * scale),
        Math.ceil(scale),
        Math.ceil(scale),
      );
    }
  });
}

export const ENVELOPE: Bitmap = {
  palette: { w: '#fafafa', k: '#263238', r: '#e53935' },
  rows: ['kkkkkkkk', 'kwkwwkwk', 'kwwkkwwk', 'kwwwwwwk', 'kwwwrwwk', 'kkkkkkkk'],
};
export const PHONE: Bitmap = {
  palette: { r: '#d32f2f', d: '#7f0000', k: '#212121' },
  rows: ['.rrrrr.', 'rr...rr', 'r.....r', '.rkkkr.', '.rdkdr.', '.rkkkr.', '.rrrrr.'],
};
export const CLOCK_ICON: Bitmap = {
  palette: { w: '#fffde7', k: '#3e2723', r: '#c62828' },
  rows: ['.kkkkk.', 'kwwkwwk', 'kwwkwwk', 'kwwkrrk', 'kwwwwwk', 'kwwwwwk', '.kkkkk.'],
};
export const FIRE: Bitmap = {
  palette: { y: '#ffeb3b', o: '#ff9800', r: '#f44336' },
  rows: ['..r...', '.rr.r.', '.ror.r', 'roorrr', 'royyor', 'roooyr', '.rrrr.'],
};
export const BEACON_ON: Bitmap = {
  palette: { r: '#ff1744', p: '#ff8a80', k: '#37474f' },
  rows: ['.pppp.', 'prrrrp', 'prrrrp', 'prrrrp', 'kkkkkk', 'kkkkkk'],
};
export const BEACON_OFF: Bitmap = {
  palette: { r: '#7f0000', k: '#37474f' },
  rows: ['.rrrr.', 'rrrrrr', 'rrrrrr', 'rrrrrr', 'kkkkkk', 'kkkkkk'],
};
/* eslint-enable pixel-agents/no-inline-colors */
