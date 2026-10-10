/** A share in basis points as people read it: 2500 → "25%", 1833 → "18.33%". */
export const percent = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
