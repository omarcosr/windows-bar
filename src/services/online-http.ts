/** Small JSON helpers for the online widgets (official REST/GraphQL APIs). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function parse<T>(res: Response, label: string): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 160);
    } catch {}
    throw new HttpError(res.status, `${label} ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function getJson<T>(url: string, headers: Record<string, string>, label: string): Promise<{ body: T; res: Response }> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  return { body: await parse<T>(res, label), res };
}

export async function postJson<T>(url: string, payload: unknown, headers: Record<string, string>, label: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  return parse<T>(res, label);
}

/** GraphQL POST that throws on `errors`. */
export async function graphql<T>(url: string, query: string, variables: Record<string, unknown>, headers: Record<string, string>, label: string): Promise<T> {
  const body = await postJson<{ data?: T; errors?: { message: string }[] }>(url, { query, variables }, headers, label);
  if (body.errors?.length) throw new Error(`${label}: ${body.errors[0]!.message}`);
  if (!body.data) throw new Error(`${label}: resposta vazia`);
  return body.data;
}

/** The URL of rel="next" in a Link header (GitHub pagination). */
export function nextLink(res: Response): string | null {
  const link = res.headers.get("link") ?? res.headers.get("Link");
  if (!link) return null;
  const m = /<([^>]+)>;\s*rel="next"/.exec(link);
  return m ? m[1]! : null;
}
