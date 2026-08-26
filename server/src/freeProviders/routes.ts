import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ProviderRequestError, type FreeProviderId } from "./types.js";
import { FreeProviderService, type ProviderConfigPatch } from "./service.js";

type AuthCheck = (cookieHeader?: string) => boolean;

function errorStatus(error: ProviderRequestError): number {
  if (error.kind === "invalid-configuration" || error.kind === "invalid-model" || error.kind === "context-length") return 400;
  if (error.kind === "authentication") return 422; // upstream auth failure, not GGO session auth
  if (error.kind === "billing") return 409;
  if (error.kind === "rate-limit") return 429;
  if (error.kind === "provider-outage" || error.kind === "network" || error.kind === "timeout") return 502;
  return 500;
}

function providerId(service: FreeProviderService, raw: string): FreeProviderId {
  if (!service.has(raw)) throw new ProviderRequestError("Unknown free provider.", "invalid-configuration");
  return raw;
}

function sendError(reply: FastifyReply, error: unknown) {
  const normalized = error instanceof ProviderRequestError
    ? error
    : new ProviderRequestError("Unexpected provider failure.", "unknown");
  return reply.code(errorStatus(normalized)).send({
    error: normalized.message,
    kind: normalized.kind,
    upstreamStatus: normalized.status,
    retryAt: normalized.retryAt,
  });
}

function requireAuth(req: FastifyRequest, reply: FastifyReply, isAuthed: AuthCheck): boolean {
  if (isAuthed(req.headers.cookie)) return true;
  void reply.code(401).send({ error: "unauthorized" });
  return false;
}

/** Auth-gated connection lab. Raw credentials enter only PUT and never leave the server again. */
export function registerFreeProviderRoutes(app: FastifyInstance, service: FreeProviderService, isAuthed: AuthCheck): void {
  app.get("/api/free-providers", async (req, reply) => {
    if (!requireAuth(req, reply, isAuthed)) return;
    reply.header("cache-control", "no-store");
    return { providers: service.list(), routing: service.routingStatus() };
  });

  app.put<{ Body: { enabled?: unknown } }>("/api/free-providers/routing", async (req, reply) => {
    if (!requireAuth(req, reply, isAuthed)) return;
    reply.header("cache-control", "no-store");
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || typeof req.body.enabled !== "boolean") {
      return sendError(reply, new ProviderRequestError("Expected { enabled: boolean }.", "invalid-configuration"));
    }
    return { routing: service.setRoutingEnabled(req.body.enabled), providers: service.list() };
  });

  app.put<{ Params: { id: string }; Body: ProviderConfigPatch }>("/api/free-providers/:id", async (req, reply) => {
    if (!requireAuth(req, reply, isAuthed)) return;
    reply.header("cache-control", "no-store");
    try {
      if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
        throw new ProviderRequestError("Expected a JSON configuration object.", "invalid-configuration");
      }
      const provider = service.update(providerId(service, req.params.id), req.body);
      return { provider, routing: service.routingStatus() };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/free-providers/:id/refresh", async (req, reply) => {
    if (!requireAuth(req, reply, isAuthed)) return;
    reply.header("cache-control", "no-store");
    try {
      const provider = await service.refresh(providerId(service, req.params.id));
      return { provider, routing: service.routingStatus() };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/free-providers/:id/probe", async (req, reply) => {
    if (!requireAuth(req, reply, isAuthed)) return;
    reply.header("cache-control", "no-store");
    try {
      return { ...await service.probe(providerId(service, req.params.id)), routing: service.routingStatus() };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
