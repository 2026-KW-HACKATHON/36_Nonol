// 설문 Worker.
// 정적 파일은 ASSETS 가 먼저 내보내고, 여기서는 문항 정의, 응답 저장, 추첨 참여만 처리한다.
// 이 Worker 는 받기만 한다. 응답이나 번호를 돌려주는 주소는 두지 않는다.
// 결과 조회와 추첨은 Cloudflare 계정으로 로그인한 컴퓨터에서 scripts/ 의 스크립트로만 한다.
import { QUESTIONS, clean, cleanPhone } from "./survey.js";

const SECURITY = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY } });

async function readJson(request) {
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return null;
  if (Number(request.headers.get("Content-Length") || 0) > 8192) return null;
  const text = await request.text();
  if (text.length > 8192) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const post = request.method === "POST";
    const sameOrigin = request.headers.get("Origin") === url.origin;
    try {
      if (url.pathname === "/api/survey") {
        if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
        return json({ questions: QUESTIONS });
      }

      if (url.pathname === "/api/respond") {
        if (!post) return json({ error: "method not allowed" }, 405);
        if (!sameOrigin) return json({ error: "같은 페이지에서 보낸 응답만 받습니다." }, 403);
        const v = clean(await readJson(request));
        if (typeof v === "string") return json({ error: v }, 400);
        await env.DB.prepare("INSERT INTO responses (id, created_at, source, used, services, service, service_other, last_used, state, reasons, reason_other, benefit, experiences, revisit, age) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .bind(crypto.randomUUID(), new Date().toISOString(), v.source, v.used, v.services, v.service, v.service_other, v.last_used, v.state, v.reasons, v.reason_other, v.benefit, v.experiences, v.revisit, v.age).run();
        return json({ ok: true }, 201);
      }

      if (url.pathname === "/api/raffle") {
        if (!post) return json({ error: "method not allowed" }, 405);
        if (!sameOrigin) return json({ error: "같은 페이지에서 보낸 요청만 받습니다." }, 403);
        const v = cleanPhone(await readJson(request));
        if (typeof v === "string") return json({ error: v }, 400);
        // 같은 번호는 한 번만 받는다. 이미 있는 번호인지는 응답으로 알려 주지 않는다.
        await env.DB.prepare("INSERT INTO raffle (id, created_at, phone) VALUES (?,?,?) ON CONFLICT(phone) DO NOTHING")
          .bind(crypto.randomUUID(), new Date().toISOString(), v.phone).run();
        return json({ ok: true }, 201);
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      // 입력값은 기록하지 않는다. 어디서 어떤 종류의 오류가 났는지만 남긴다.
      console.error(JSON.stringify({ at: url.pathname, error: String(e?.name || "Error") }));
      return json({ error: "처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요." }, 500);
    }
  },
};
