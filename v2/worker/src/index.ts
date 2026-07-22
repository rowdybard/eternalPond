import { hashString32 } from "@eternal-pond/shared";
import { PondCoreV2 } from "./core";
import { PondGatewayV2 } from "./gateway";

export { PondCoreV2, PondGatewayV2 };

function configuredOrigins(env: Env): Set<string> {
  return new Set(env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean));
}

function isAllowedOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("Origin");
  const requestHost = new URL(request.url).hostname;
  if (!origin) return requestHost === "localhost" || requestHost === "127.0.0.1";
  return configuredOrigins(env).has(origin);
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin");
  const allowed = origin && configuredOrigins(env).has(origin) ? origin : "https://eternalpond.com";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "eternal-pond-canonical", protocol: 3, now: Date.now() }, { headers: corsHeaders(request, env) });
    }

    if (url.pathname === "/api/v3/status" || url.pathname === "/api/v2/status") {
      if (!isAllowedOrigin(request, env)) return Response.json({ error: "origin_rejected" }, { status: 403 });
      const core = env.POND_CORE.getByName("canonical-world");
      return Response.json(await core.getPublicStatus(), { headers: corsHeaders(request, env) });
    }

    if (url.pathname !== "/ws/v3" && url.pathname !== "/ws/v2") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (!isAllowedOrigin(request, env)) return Response.json({ error: "origin_rejected" }, { status: 403 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
    }

    const routingKey = url.searchParams.get("token")
      ?? url.searchParams.get("connection")
      ?? crypto.randomUUID();
    const shard = hashString32(routingKey) % 16;
    url.searchParams.set("shard", String(shard));
    const gateway = env.POND_GATEWAY.getByName(`v2-gateway-${shard}`);
    return gateway.fetch(new Request(url, request));
  },
} satisfies ExportedHandler<Env>;
