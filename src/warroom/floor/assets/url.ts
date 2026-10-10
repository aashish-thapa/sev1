/** Resolves a catalog path (e.g. `office/props/sofa.glb`) against wherever the app is served from. */
export function assetUrl(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}
