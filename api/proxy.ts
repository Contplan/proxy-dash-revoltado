// api/proxy.ts — Vercel Edge Function
export const config = { runtime: "edge" };

const TARGET_BASE =
  process.env.TARGET_URL ??
  "https://n8n.athenas.me/webhook/dash-revoltado";

function cors(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

export default async function handler(req: Request): Promise<Response> {
  const origin = req.headers.get("origin") ?? "*";

  // 🔹 1 — Pré-flight CORS
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(origin) });
  }

  // 🔹 2 — Monta URL de destino (N8N) com query params
  const incomingUrl = new URL(req.url);
  const targetUrl = new URL(TARGET_BASE);

  incomingUrl.searchParams.forEach((v, k) => {
    targetUrl.searchParams.append(k, v);
  });

  // Garante type=json, se não vier na URL
  if (!targetUrl.searchParams.has("type")) {
    targetUrl.searchParams.set("type", "json");
  }

  // Copia headers e remove host
  const fwdHeaders = new Headers(req.headers);
  fwdHeaders.delete("host");

  // Body só para métodos que suportam
  const body =
    ["GET", "HEAD"].includes(req.method) ? undefined : await req.text();

  const init: RequestInit = {
    method: req.method,
    headers: fwdHeaders,
    body,
    redirect: "manual",
  };

  try {
    const upstream = await fetch(targetUrl.toString(), init);

    // Lê o corpo como texto para poder inspecionar / reenviar
    const upstreamText = await upstream.text();

    const c = cors(origin);
    const outHeaders = new Headers(upstream.headers);
    Object.entries(c).forEach(([k, v]) => outHeaders.set(k, v as string));
    outHeaders.set("Cache-Control", "no-store");

    // 🔹 3 — Se for GET e deu erro no upstream, retorna fallback explicativo
    if (!upstream.ok && req.method === "GET") {
      const detailPreview =
        upstreamText.length > 500
          ? upstreamText.slice(0, 500) + "...(truncado)"
          : upstreamText;

      return new Response(
        JSON.stringify({
          ok: false,
          proxy: true,
          method: "GET",
          upstream_status: upstream.status,
          upstream_status_text: upstream.statusText,
          message:
            "A chamada GET foi encaminhada ao webhook, mas ele retornou erro. É provável que o webhook espere um POST com body.",
          upstream_preview: detailPreview,
        }),
        {
          status: 502,
          headers: {
            "Content-Type": "application/json",
            ...c,
          },
        }
      );
    }

    // 🔹 4 — Fluxo normal: devolve exatamente o que o upstream mandou
    return new Response(upstreamText, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  } catch (err: any) {
    const c = cors(origin);
    return new Response(
      JSON.stringify({
        ok: false,
        error: "upstream_fetch_failed",
        detail: String(err?.message || err),
      }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          ...c,
        },
      }
    );
  }
}

