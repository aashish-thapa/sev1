/** One home for the 3D chunk's import, so the page can start fetching it before it's needed. */
export const loadFloor = () => import("../floor/FloorView.tsx");

export function preloadFloor(): void {
  void loadFloor();
}
