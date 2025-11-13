// api/proxy.ts — Vercel Edge Function
export const config = { runtime: "edge" };

const TARGET_BASE =
  process.env.TARGET_URL ??
  "https://n8n.athenas.me/webhook/dash-revoltado";

const PAGINATION_KEYS = new Set([
  "page",
  "limit",
  "per_page",
  "page_size",
  "pageSize",
]);

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;
const ARRAY_FIELD_PREFERENCES = [
  "data",
  "items",
  "records",
  "rows",
  "result",
  "results",
  "payload",
  "entries",
];

type PaginationConfig = {
  enabled: boolean;
  page: number;
  pageSize: number;
};

function sanitizePositiveInt(
  value: string | null,
  fallback: number,
  max?: number
): number {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    const normalized = Math.floor(parsed);
    if (max) {
      return Math.min(normalized, max);
    }
    return normalized;
  }
  return fallback;
}

function extractPagination(searchParams: URLSearchParams): PaginationConfig {
  const pageRaw = searchParams.get("page");
  const sizeRaw =
    searchParams.get("limit") ??
    searchParams.get("per_page") ??
    searchParams.get("page_size") ??
    searchParams.get("pageSize");

  const enabled = Boolean(pageRaw ?? sizeRaw);
  const page = sanitizePositiveInt(pageRaw, 1);
  const pageSize = sanitizePositiveInt(
    sizeRaw,
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE
  );

  return { enabled, page, pageSize };
}

type ArrayTarget = {
  data: any[];
  replace: (replacement: any[]) => any;
  rootIsArray: boolean;
};

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function makeReplacement(
  record: Record<string, any>,
  key: string,
  nextValue: any
) {
  return { ...record, [key]: nextValue };
}

function targetFromKey(
  record: Record<string, any>,
  key: string
): ArrayTarget | null {
  if (!(key in record)) return null;
  const candidate = record[key];

  if (Array.isArray(candidate)) {
    return {
      data: candidate,
      replace: (replacement: any[]) => makeReplacement(record, key, replacement),
      rootIsArray: false,
    };
  }

  if (typeof candidate === "string") {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) {
        return {
          data: parsed,
          replace: (replacement: any[]) =>
            makeReplacement(record, key, JSON.stringify(replacement)),
          rootIsArray: false,
        };
      }
    } catch (_) {
      // Não é um JSON válido; segue a busca.
    }
  }

  return null;
}

function findArrayTarget(value: unknown): ArrayTarget | null {
  if (Array.isArray(value)) {
    return {
      data: value,
      replace: (replacement: any[]) => replacement,
      rootIsArray: true,
    };
  }

  if (!isPlainObject(value)) {
    return null;
  }

  const record = value;

  for (const key of ARRAY_FIELD_PREFERENCES) {
    const target = targetFromKey(record, key);
    if (target) {
      return target;
    }
  }

  for (const key of Object.keys(record)) {
    const target = targetFromKey(record, key);
    if (target) {
      return target;
    }
  }

  for (const [key, child] of Object.entries(record)) {
    if (isPlainObject(child) || Array.isArray(child)) {
      const nested = findArrayTarget(child);
      if (nested) {
        return {
          data: nested.data,
          replace: (replacement: any[]) =>
            makeReplacement(record, key, nested.replace(replacement)),
          rootIsArray: false,
        };
      }
    }
  }

  return null;
}

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

  const pagination = extractPagination(incomingUrl.searchParams);

  incomingUrl.searchParams.forEach((v, k) => {
    if (!PAGINATION_KEYS.has(k)) {
      targetUrl.searchParams.append(k, v);
    }
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
    if (pagination.enabled && upstream.ok && req.method === "GET") {
      try {
        const parsed = JSON.parse(upstreamText);
        const target = findArrayTarget(parsed);

        if (target) {
          const totalItems = target.data.length;
          const totalPages =
            pagination.pageSize > 0
              ? Math.ceil(totalItems / pagination.pageSize)
              : 0;
          const start = (pagination.page - 1) * pagination.pageSize;
          const end = start + pagination.pageSize;
          const sliced = target.data.slice(start, end);

          const paginationMeta = {
            page: pagination.page,
            pageSize: pagination.pageSize,
            totalItems,
            totalPages,
          };

          let payload = target.replace(sliced);

          if (target.rootIsArray) {
            payload = { data: payload, pagination: paginationMeta };
          } else if (payload && typeof payload === "object") {
            payload = { ...(payload as Record<string, any>), pagination: paginationMeta };
          } else {
            payload = { data: sliced, pagination: paginationMeta };
          }

          outHeaders.set(
            "content-type",
            "application/json; charset=utf-8"
          );

          return new Response(JSON.stringify(payload), {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: outHeaders,
          });
        }
      } catch (_) {
        // Se não conseguir paginar (JSON inválido), segue fluxo normal.
      }
    }

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

