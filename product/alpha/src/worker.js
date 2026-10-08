// 노놀 알파 테스터 온보딩 페이지 Worker.
// 정적 파일은 ASSETS 가 먼저 내보내고, 여기서는 /api/apply (신청 저장) 만 처리한다.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 입력을 검사해 저장할 값만 돌려준다. 문제가 있으면 문자열(사용자에게 보여 줄 메시지)을 돌려준다.
function clean(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "신청 내용을 읽지 못했습니다. 다시 시도해 주세요.";
  if (String(body.website || "")) return "신청을 처리하지 못했습니다."; // 봇용 숨은 칸
  const name = String(body.name ?? "").trim();
  if (name.length < 1 || name.length > 40) return "이름을 적어 주세요 (40자 이하).";
  const contact = String(body.contact ?? "").trim();
  if (contact.length < 3 || contact.length > 80) return "연락처를 적어 주세요 (전화번호나 카카오톡 아이디).";
  const party = Number(body.party_size);
  if (!Number.isInteger(party) || party < 1 || party > 4) return "함께 올 인원은 1명에서 4명 사이로 골라 주세요.";
  const datesRaw = Array.isArray(body.dates) ? body.dates : [];
  const dates = [...new Set(datesRaw.map((d) => String(d).trim()).filter((d) => DATE_RE.test(d)))].sort();
  if (dates.length > 10) return "가능한 날짜는 10개까지만 고를 수 있습니다.";
  const referrer = String(body.referrer ?? "").trim();
  if (referrer.length > 40) return "추천한 사람 이름은 40자 이하로 적어 주세요.";
  const message = String(body.message ?? "").trim();
  if (message.length > 500) return "하고 싶은 말은 500자 이하로 적어 주세요.";
  if (body.agree !== true) return "개인정보 수집에 동의해 주세요.";
  const track = String(body.track_id ?? "").trim();
  if (!/^[\w-]{1,40}$/.test(track)) return "트랙 정보가 올바르지 않습니다. 페이지를 새로고침해 주세요.";
  return { name, contact, party, dates: dates.join(","), referrer, message, track };
}

async function readJson(request) {
  if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return null;
  const text = await request.text();
  if (text.length > 8192) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/apply") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (request.headers.get("Origin") !== url.origin) return json({ error: "같은 페이지에서 보낸 신청만 받습니다." }, 403);
      if (!env.DB) return json({ error: "신청 저장소가 준비되지 않았습니다. 운영자에게 알려 주세요." }, 500);
      const v = clean(await readJson(request));
      if (typeof v === "string") return json({ error: v }, 400);
      try {
        // 같은 연락처로 같은 트랙에 이미 신청했으면 새로 만들지 않고 알려 준다.
        const dup = await env.DB.prepare("SELECT id, created_at FROM applications WHERE track_id = ? AND contact = ? AND status != 'cancelled'").bind(v.track, v.contact).first();
        if (dup) return json({ ok: true, duplicate: true });
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO applications (id, created_at, track_id, name, contact, party_size, dates, referrer, message) VALUES (?,?,?,?,?,?,?,?,?)")
          .bind(id, new Date().toISOString(), v.track, v.name, v.contact, v.party, v.dates, v.referrer, v.message).run();
        return json({ ok: true, duplicate: false }, 201);
      } catch (e) {
        return json({ error: "저장 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요." }, 500);
      }
    }
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
