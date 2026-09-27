// 설문 문항 정의와 입력 검사, 집계. Worker 와 시험이 함께 쓴다.
// 화면(public/app.js)의 문항은 /api/survey 로 이 정의를 받아 그린다.

const SERVICE_OPTIONS = [["delivery", "배달 앱 쿠폰"], ["lastminute", "마감 할인 앱"], ["stamp", "카페나 식당 스탬프 적립 앱"], ["local", "지역 화폐, 지역 상품권 앱"], ["other", "기타"]];

export const QUESTIONS = [
  {
    id: "used", type: "one", title: "쿠폰이나 할인을 받으려고 앱이나 서비스를 써본 적 있나요?",
    hint: "마감 할인, 타임 세일, 첫 주문 쿠폰, 스탬프 적립 등을 떠올려주세요.",
    options: [["yes", "있다"], ["no", "없다"]],
  },
  {
    id: "services", type: "many", title: "이용해본 서비스를 모두 골라주세요.", other: "service_other",
    hint: "여러 개를 선택할 수 있어요. 지금은 쓰지 않는 서비스도 포함해주세요.",
    options: SERVICE_OPTIONS,
  },
  {
    id: "service", type: "one", title: "그중 가장 많이 이용한 서비스는 무엇인가요?",
    hint: "하나를 고르고, 이후 질문도 그 서비스를 기준으로 답해주세요.",
    options: SERVICE_OPTIONS,
  },
  {
    id: "last_used", type: "one", title: "그 서비스를 마지막으로 이용한 건 언제인가요?",
    options: [["week", "일주일 안"], ["month", "한 달 안"], ["quarter", "석 달 안"], ["older", "그보다 오래됨"]],
  },
  {
    id: "state", type: "one", title: "처음 쓰던 때와 비교해, 요즘은 얼마나 이용하나요?",
    options: [["more", "더 자주 쓴다"], ["same", "비슷하게 쓴다"], ["less", "덜 쓴다"], ["stopped", "이제 안 쓴다"]],
  },
  {
    id: "reasons", type: "many", other: "reason_other",
    title: { less: "이용이 줄어든 이유는 무엇인가요?", stopped: "더 이상 이용하지 않는 이유는 무엇인가요?" },
    hint: "해당하는 이유를 모두 골라주세요.",
    options: [["discount", "할인 폭이 줄어서"], ["stores", "쓸 만한 가게가 없어서"], ["hassle", "쓰기 번거로워서"], ["alerts", "알림이 너무 많아서"], ["forgot", "그냥 잊어버려서"], ["other", "기타"]],
  },
  {
    id: "benefit", type: "one", title: "실제로 할인이나 혜택을 얼마나 받았나요?",
    options: [["full", "안내된 만큼 받았다"], ["less", "받긴 했지만 기대보다 적었다"], ["hard", "조건이 까다로워 거의 못 받았다"], ["none", "받지 못했다"]],
  },
  {
    id: "experiences", type: "many", title: "이용하면서 이런 경험이 있었나요?", hint: "해당하는 경험을 모두 골라주세요.", exclusive: "none",
    options: [["condition", "최소 주문 금액이나 사용 조건이 붙어 있었다"], ["expired", "쿠폰 기한이 지나 못 쓴 적이 있다"], ["shrink", "처음에만 혜택이 크고 갈수록 줄었다"], ["limited", "쓸 수 있는 가게나 시간이 제한적이었다"], ["overspend", "할인받으려고 계획에 없던 소비를 했다"], ["discover", "덕분에 몰랐던 가게를 알게 됐다"], ["saved", "덕분에 실제로 돈을 아꼈다"], ["none", "해당 없음"]],
  },
  {
    id: "revisit", type: "one", title: "할인이 없을 때도 그 가게를 다시 찾았나요?",
    options: [["yes", "있다"], ["no", "없다"], ["unknown", "기억나지 않는다"]],
  },
  {
    id: "age", type: "one", title: "마지막으로, 나이대를 알려주세요.",
    hint: "어떤 분들이 참여했는지 통계로 살펴보기 위한 질문이에요.",
    options: [["10", "10대"], ["20", "20대"], ["30", "30대"], ["40", "40대"], ["50", "50대 이상"]],
  },
];

const Q = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
const values = (id) => Q[id].options.map((o) => o[0]);

// 이 응답자가 답해야 하는 문항 순서. 화면도 같은 규칙을 쓴다.
export function path(answers) {
  if (answers.used === "no") return ["used", "age"];
  const ids = ["used", "services"];
  if (!Array.isArray(answers.services) || new Set(answers.services).size !== 1) ids.push("service");
  ids.push("last_used", "state");
  if (answers.state === "less" || answers.state === "stopped") ids.push("reasons");
  ids.push("benefit", "experiences", "revisit", "age");
  return ids;
}

const SOURCES = ["insta", "everytime", "kakao", "friend"];

// 입력을 검사해 저장할 값만 돌려준다. 문제가 있으면 문자열(사용자에게 보여 줄 메시지)을 돌려준다.
export function clean(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "응답을 읽지 못했습니다. 다시 시도해 주세요.";
  if (String(body.website || "")) return "응답을 처리하지 못했습니다."; // 봇용 숨은 칸
  let a = body.answers;
  if (!a || typeof a !== "object" || Array.isArray(a)) return "응답을 읽지 못했습니다. 다시 시도해 주세요.";
  const out = { source: SOURCES.includes(body.source) ? body.source : "", used: "", services: "", service: "", service_other: "", last_used: "", state: "", reasons: "", reason_other: "", benefit: "", experiences: "", revisit: "", age: "" };
  if (!values("used").includes(a.used)) return "첫 질문에 답해 주세요.";
  // 개편 전에 열린 화면의 제출도 받되, 복수 선택 통계에는 섞지 않는다.
  const legacy = a.services === undefined && values("service").includes(a.service);
  if (a.used === "yes") {
    const selected = legacy ? [a.service] : Array.isArray(a.services) ? [...new Set(a.services)] : [];
    if (!selected.length || selected.some((v) => !values("services").includes(v))) return "이용해본 서비스를 골라주세요.";
    if (selected.length > 1 && !selected.includes(a.service)) return "선택한 서비스 중 가장 많이 이용한 하나를 골라주세요.";
    a = { ...a, services: selected, service: selected.length === 1 ? selected[0] : a.service };
    out.service = a.service;
  }
  for (const id of path(a)) {
    const q = Q[id];
    if (q.type === "one") {
      if (!values(id).includes(a[id])) return "답하지 않은 질문이 있습니다.";
      out[id] = a[id];
    } else {
      const picked = Array.isArray(a[id]) ? [...new Set(a[id].map(String))] : [];
      if (!picked.length || picked.some((v) => !values(id).includes(v))) return "답하지 않은 질문이 있습니다.";
      if (q.exclusive && picked.includes(q.exclusive) && picked.length > 1) return "해당 없음은 다른 보기와 함께 고를 수 없습니다.";
      out[id] = values(id).filter((v) => picked.includes(v)).join(",");
    }
    if (q.other) {
      const chose = q.type === "one" ? a[id] === "other" : out[id].split(",").includes("other");
      const text = chose ? String(a[q.other] ?? "").trim() : "";
      if (text.length > (q.other === "service_other" ? 60 : 100)) return "직접 입력은 짧게 적어 주세요.";
      out[q.other] = text;
    }
  }
  if (legacy) out.services = "";
  return out;
}

// 추첨용 번호. 숫자만 남겨 010 으로 시작하는 10~11자리인지 본다.
export function cleanPhone(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "번호를 읽지 못했습니다. 다시 시도해 주세요.";
  if (String(body.website || "")) return "요청을 처리하지 못했습니다.";
  if (body.agree !== true) return "개인정보 수집에 동의해 주세요.";
  const phone = String(body.phone ?? "").replace(/\D/g, "");
  if (!/^01[016789]\d{7,8}$/.test(phone)) return "휴대폰 번호를 확인해 주세요.";
  return { phone };
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// 응답 행 전체로 집계를 만든다. 계속 이용의 기준은 설문 설계 문서에서 미리 정한 대로다.
export function summarize(rows) {
  const total = rows.length;
  const users = rows.filter((r) => r.used === "yes");
  const n = users.length;
  const serviceRespondents = users.filter((r) => r.services);
  const count = (list, key, id) => Q[id].options.map(([v, label]) => {
    const c = list.filter((r) => String(r[key]).split(",").includes(v)).length;
    return { value: v, label, count: c, percent: pct(c, list.length) };
  });
  const by = (state) => users.filter((r) => r.state === state);
  const kept = by("more").length + by("same").length;
  const recent = users.filter((r) => r.last_used === "week" || r.last_used === "month").length;
  // 느낌으로는 계속 쓴다고 했지만 마지막 사용이 석 달을 넘은 사람
  const mismatch = users.filter((r) => (r.state === "more" || r.state === "same") && r.last_used === "older").length;
  const sources = {};
  for (const r of rows) sources[r.source || "direct"] = (sources[r.source || "direct"] || 0) + 1;
  return {
    total, users: n, usedPercent: pct(n, total),
    key: {
      kept: { count: kept, percent: pct(kept, n) },
      less: { count: by("less").length, percent: pct(by("less").length, n) },
      stopped: { count: by("stopped").length, percent: pct(by("stopped").length, n) },
      recentUse: { count: recent, percent: pct(recent, n) },
      mismatch: { count: mismatch },
    },
    service: count(users, "service", "service"),
    services: count(serviceRespondents, "services", "services"),
    servicesRespondents: serviceRespondents.length,
    lastUsed: count(users, "last_used", "last_used"),
    state: count(users, "state", "state"),
    reasonsLess: count(by("less"), "reasons", "reasons"),
    reasonsStopped: count(by("stopped"), "reasons", "reasons"),
    benefit: count(users, "benefit", "benefit"),
    experiences: count(users, "experiences", "experiences"),
    revisit: count(users, "revisit", "revisit"),
    age: count(rows, "age", "age"),
    sources,
    otherText: {
      service: users.map((r) => r.service_other).filter(Boolean),
      reason: users.map((r) => r.reason_other).filter(Boolean),
    },
  };
}
