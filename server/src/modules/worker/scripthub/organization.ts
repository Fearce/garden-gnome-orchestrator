import { HttpError } from "../router.js";

export interface Organization {
  management: "personal" | "agent";
  category: string;
  tags: string[];
}

export interface RegistryOrganization {
  owner?: string;
  agentManaged?: boolean;
  category?: string;
  tags?: string[];
}

/** Explicit registry metadata wins over the legacy owner convention. Local edits win over both. */
export function organizationOf(script: RegistryOrganization, saved?: Organization): Organization {
  if (saved) return saved;
  return {
    management: typeof script.agentManaged === "boolean" ? (script.agentManaged ? "agent" : "personal") : script.owner ? "personal" : "agent",
    category: script.category || "uncategorized",
    tags: Array.isArray(script.tags) ? script.tags.filter((tag) => typeof tag === "string") : [],
  };
}

export function readOrganization(value: unknown): Organization {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "organization must be an object");
  const { management, category, tags } = value as Record<string, unknown>;
  if (management !== "personal" && management !== "agent") throw new HttpError(400, "management must be personal or agent");
  if (typeof category !== "string" || !category.trim() || category.trim().length > 80 || /[\u0000-\u001f]/.test(category)) throw new HttpError(400, "category must contain 1–80 characters");
  if (!Array.isArray(tags) || tags.length > 20 || !tags.every((tag) => typeof tag === "string" && tag.trim().length > 0 && tag.trim().length <= 40 && !/[,\u0000-\u001f]/.test(tag))) throw new HttpError(400, "tags must be up to 20 labels of 1–40 characters, without commas");
  return { management, category: category.trim(), tags: [...new Set((tags as string[]).map((tag) => tag.trim().toLowerCase()))] };
}
