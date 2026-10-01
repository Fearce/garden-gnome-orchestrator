import type { GnomeRole } from "../types.js";

// Shared by avatars, the office and the scaffold. Referencing the URL does not fetch
// it: the browser loads this one texture only when beta artwork is mounted.
export const betaGnomeAtlas = new URL("../assets/gnomes/workshop-cast.webp", import.meta.url).href;
export const betaGnomeCast: Record<GnomeRole, { column: number; row: number; accent: string; coat: string }> = {
  director: { column: 0, row: 0, accent: "#c4a1ff", coat: "#343355" },
  planner: { column: 1, row: 0, accent: "#8abaff", coat: "#255782" },
  researcher: { column: 2, row: 0, accent: "#74dacb", coat: "#21686b" },
  implementor: { column: 3, row: 0, accent: "#ffd078", coat: "#b29672" },
  qa: { column: 0, row: 1, accent: "#ffacb7", coat: "#aa4752" },
  reader: { column: 1, row: 1, accent: "#d3adff", coat: "#8554a1" },
  reviewer: { column: 2, row: 1, accent: "#bcd58b", coat: "#57663b" },
  coworker: { column: 3, row: 1, accent: "#91e2dc", coat: "#26767c" },
};
