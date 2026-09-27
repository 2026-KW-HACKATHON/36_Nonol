// 설문 화면. 문항 정의는 /api/survey 에서 받고, 한 화면에 한 문항씩 보여 준다.
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const source = (params.get("from") || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 20);
const answers = {};
let questions = [], index = 0, sending = false;

// 서버(src/survey.js)의 path 와 같은 규칙이다.
function path() {
  if (answers.used === "no") return ["used", "age"];
  const ids = ["used", "services"];
  if (!Array.isArray(answers.services) || new Set(answers.services).size !== 1) ids.push("service");
  ids.push("last_used", "state");
  if (answers.state === "less" || answers.state === "stopped") ids.push("reasons");
  ids.push("benefit", "experiences", "revisit", "age");
  return ids;
}
const current = () => questions.find((q) => q.id === path()[index]);

function show(id) {
  for (const s of ["intro", "quiz", "done"]) $(s).hidden = s !== id;
}

function render() {
  const q = current(), ids = path();
  // 이용 상태를 답하기 전에는 이유 문항까지 있다고 보고 센다. 도중에 전체 수가 늘어나 보이지 않게 한다.
  const total = ids.length + (answers.used !== "no" && !answers.state ? 1 : 0);
  $("count").textContent = (index + 1) + " / " + total;
  $("fill").value = Math.round((index / total) * 100);
  $("questionNumber").textContent = "QUESTION " + String(index + 1).padStart(2, "0");
  $("stage").textContent = q.id === "age" ? "마지막 질문" : ["used", "services", "service", "last_used", "state"].includes(q.id) ? "이용 경험" : "혜택과 경험";
  $("title").textContent = typeof q.title === "string" ? q.title : q.title[answers.state];
  $("hint").textContent = q.hint || (q.type === "many" ? "해당하는 항목을 모두 골라주세요." : "하나만 골라주세요.");
  const service = questions.find((item) => item.id === "service")?.options.find(([value]) => value === answers.service)?.[1];
  const showContext = !["used", "services", "service", "age"].includes(q.id) && service;
  $("context").hidden = !showContext;
  $("context").textContent = showContext ? (answers.service === "other" ? "앞서 떠올린 서비스" : service) + " 이용 경험을 기준으로 답해주세요." : "";
  $("err").textContent = "";
  const box = $("options");
  box.textContent = "";
  const many = q.type === "many";
  const chosen = many ? (answers[q.id] || []) : [answers[q.id]];
  const options = q.id === "service" ? q.options.filter(([value]) => answers.services.includes(value)) : q.options;
  for (const [value, label] of options) {
    const wrap = document.createElement("label");
    wrap.className = "opt";
    const input = document.createElement("input");
    input.type = many ? "checkbox" : "radio";
    input.name = q.id;
    input.value = value;
    input.checked = chosen.includes(value);
    const text = document.createElement("span");
    text.textContent = q.id === "service" && value === "other" && answers.service_other ? "기타: " + answers.service_other : label;
    wrap.append(input, text);
    box.append(wrap);
  }
  $("other").value = q.other ? (answers[q.other] || "") : "";
  $("other").maxLength = q.other === "reason_other" ? 100 : 60;
  toggleOther();
  $("back").disabled = index === 0;
  $("next").textContent = index === ids.length - 1 ? "제출하기" : "다음";
  $("title").focus({ preventScroll: true });
  window.scrollTo({ top: 0 });
}

function picked() {
  return [...document.querySelectorAll("#options input:checked")].map((i) => i.value);
}
function toggleOther() {
  const q = current();
  $("otherBox").hidden = !(q.other && picked().includes("other"));
}

function keep() {
  const q = current(), p = picked();
  const previousService = answers.service;
  if (!p.length) {
    delete answers[q.id];
    if (q.other) delete answers[q.other];
    if (q.id === "services") delete answers.service;
    if (["services", "service"].includes(q.id) && previousService) clearServiceExperience();
    return false;
  }
  answers[q.id] = q.type === "many" ? p : p[0];
  if (q.other) answers[q.other] = p.includes("other") ? $("other").value.trim() : "";
  if (q.id === "services") {
    if (p.length === 1) answers.service = p[0];
    else if (!p.includes(answers.service)) delete answers.service;
  }
  if (["services", "service"].includes(q.id) && answers.service !== previousService) clearServiceExperience();
  return true;
}

function clearServiceExperience() {
  for (const id of ["last_used", "state", "reasons", "reason_other", "benefit", "experiences", "revisit"]) delete answers[id];
}

$("options").addEventListener("change", (e) => {
  const q = current();
  // 해당 없음은 다른 보기와 함께 고를 수 없다.
  if (q.exclusive && e.target.checked) {
    for (const i of document.querySelectorAll("#options input")) {
      if (e.target.value === q.exclusive ? i !== e.target : i.value === q.exclusive) i.checked = false;
    }
  }
  $("err").textContent = "";
  toggleOther();
  if (!$("otherBox").hidden) $("other").focus();
});

$("back").addEventListener("click", () => {
  if (sending) return;
  keep();
  if (index > 0) { index -= 1; render(); }
});

$("next").addEventListener("click", async () => {
  if (sending) return;
  if (!keep()) { $("err").textContent = "하나 이상 골라 주세요."; return; }
  if (index < path().length - 1) { index += 1; render(); return; }
  sending = true;
  $("next").disabled = true;
  $("back").disabled = true;
  $("other").disabled = true;
  for (const input of document.querySelectorAll("#options input")) input.disabled = true;
  $("quiz").setAttribute("aria-busy", "true");
  $("next").textContent = "답변 보내는 중…";
  try {
    const only = {};
    for (const id of path()) {
      only[id] = answers[id];
      const q = questions.find((x) => x.id === id);
      if (q.other) only[q.other] = answers[q.other] || "";
    }
    const res = await fetch("/api/respond", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: only, source }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "저장하지 못했습니다. 다시 시도해 주세요.");
    $("count").textContent = "";
    $("fill").value = 100;
    show("done");
    $("doneTitle").focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  } catch (e) {
    $("err").textContent = e.message === "Failed to fetch" ? "연결이 끊겼습니다. 다시 시도해 주세요." : e.message;
    $("next").textContent = "제출하기";
  } finally {
    sending = false;
    $("next").disabled = false;
    $("back").disabled = index === 0;
    $("other").disabled = false;
    for (const input of document.querySelectorAll("#options input")) input.disabled = false;
    $("quiz").removeAttribute("aria-busy");
  }
});

$("phone").addEventListener("input", (e) => {
  const d = e.target.value.replace(/\D/g, "").slice(0, 11);
  e.target.value = d.length < 4 ? d : d.length < 8 ? d.slice(0, 3) + "-" + d.slice(3) : d.slice(0, 3) + "-" + d.slice(3, d.length - 4) + "-" + d.slice(-4);
});

$("raffle").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("raffleErr"), btn = $("raffleBtn");
  err.textContent = "";
  const phone = $("phone").value.replace(/\D/g, "");
  if (!/^01[016789]\d{7,8}$/.test(phone)) { err.textContent = "휴대폰 번호를 확인해 주세요."; $("phone").focus(); return; }
  if (!$("agree").checked) { err.textContent = "개인정보 수집에 동의해 주세요."; $("agree").focus(); return; }
  if (btn.disabled) return;
  btn.disabled = true;
  btn.textContent = "참여 신청 중…";
  $("skipRaffle").disabled = true;
  $("phone").disabled = true;
  $("agree").disabled = true;
  try {
    const res = await fetch("/api/raffle", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone, agree: true, website: $("website").value }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "저장하지 못했습니다. 다시 시도해 주세요.");
    $("raffle").hidden = true;
    $("raffleOk").hidden = false;
    $("phone").value = "";
    $("raffleOk").focus();
  } catch (e2) {
    err.textContent = e2.message === "Failed to fetch" ? "연결이 끊겼습니다. 다시 시도해 주세요." : e2.message;
    btn.disabled = false;
    btn.textContent = "추첨 참여하기";
    $("skipRaffle").disabled = false;
    $("phone").disabled = false;
    $("agree").disabled = false;
  }
});

$("skipRaffle").addEventListener("click", () => {
  $("phone").value = "";
  $("raffle").hidden = true;
  $("finish").hidden = false;
  $("finish").focus();
});

$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  $("startLabel").textContent = "질문을 불러오는 중…";
  $("startErr").textContent = "";
  try {
    const res = await fetch("/api/survey");
    if (!res.ok) throw new Error("survey unavailable");
    const data = await res.json();
    if (!Array.isArray(data.questions) || !data.questions.length) throw new Error("invalid survey");
    questions = data.questions;
    show("quiz");
    render();
  } catch {
    $("start").disabled = false;
    $("startLabel").textContent = "다시 시도하기";
    $("startErr").textContent = "질문을 불러오지 못했어요. 연결을 확인하고 다시 시도해주세요.";
  }
});
