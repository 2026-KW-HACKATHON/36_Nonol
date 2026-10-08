// 공개 트랙 소개와 신청 폼. 비공개 장소는 공개 데이터에도 이름을 넣지 않는다.
(async function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const ICON = {
    meal: '<svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 37h46l-5 21H22zM12 64h56M26 29c-7-7 7-8 0-15M40 29c-7-7 7-8 0-15M54 29c-7-7 7-8 0-15M63 41h5v12h-8"/></svg>',
    silent: '<svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 30h20v16H15zM45 30h20v16H45zM35 35h10M9 28l6 7M71 28l-6 7M32 59h16M20 36h8M50 36h8"/></svg>',
    coffee: '<svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 30h34v24a8 8 0 0 1-8 8H28a8 8 0 0 1-8-8zM54 35h7a9 9 0 0 1 0 18h-7M14 68h47M29 22c-6-6 6-7 0-13M43 22c-6-6 6-7 0-13"/></svg>'
  };
  let data;
  try {
    const response = await fetch("./track.json", { cache: "no-store" });
    if (!response.ok) throw new Error(response.status);
    data = await response.json();
    if (!data.track?.id || !Array.isArray(data.checkpoints)) throw new Error("Invalid track");
  } catch {
    $("#content-error").hidden = false;
    return;
  }
  const t = data.track;
  document.title = `${t.name} | 노놀 알파`;
  $("#track-name").textContent = t.name;
  $("#track-line").textContent = t.line;
  $("#track-invite").textContent = t.invite;
  $("#n-fee").textContent = t.fee >= 10000 && t.fee % 10000 === 0 ? `${t.fee / 10000}만원` : `${t.fee.toLocaleString("ko-KR")}원`;
  $("#n-hours").textContent = `${t.hours}시간`;
  $("#n-spots").textContent = `${t.spots}곳`;
  $("#why").textContent = t.why;
  $("#why-sub").textContent = t.whySub || "";
  $("#apply-after").textContent = data.apply?.after || "";
  $("#done-msg").textContent = data.apply?.done || data.apply?.after || "신청 받았어요. 곧 연락드릴게요.";
  $("#consent").textContent = data.apply?.consent || "";
  $("#credits").textContent = data.credits || "";
  $("#deck").innerHTML = data.checkpoints.map((c) => `<article class="course-stop${c.secret ? " secret" : ""}">
    <div class="stop-top"><span class="stop-label">장소 ${esc(c.no)}</span><span class="stop-number" aria-hidden="true">0${esc(c.no)}</span></div>
    <div class="stop-visual" aria-hidden="true">${ICON[c.doodle] || ""}${c.secret ? '<span class="secret-word">???</span>' : ""}</div>
    ${c.secret ? '<h3 class="sr-only">비공개 장소</h3><div class="secret-blank" aria-hidden="true"></div>' : `<h3>${esc(c.place)}</h3>`}
    <p class="stop-sub">${esc(c.sub)}</p><p class="mission">${esc(c.mission)}</p>
  </article>`).join("");

  const from = new URLSearchParams(location.search).get("from") || "";
  const form = $("#apply-form"), err = $("#apply-error"), btn = $("#apply-submit");
  const nameField = form.elements.namedItem("name"), contactField = form.elements.namedItem("contact");
  btn.disabled = false;
  const resetButton = () => { btn.innerHTML = '묵언수행 신청하기 <span aria-hidden="true">↗</span>'; };
  form.addEventListener("input", (e) => { e.target.removeAttribute("aria-invalid"); });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    err.textContent = "";
    nameField.removeAttribute("aria-invalid");
    contactField.removeAttribute("aria-invalid");
    const name = nameField.value.trim(), contact = contactField.value.trim();
    if (!name) { err.textContent = "이름을 적어 주세요."; nameField.setAttribute("aria-invalid", "true"); nameField.focus(); return; }
    if (contact.length < 3) { err.textContent = "전화번호나 카카오톡 아이디를 적어 주세요."; contactField.setAttribute("aria-invalid", "true"); contactField.focus(); return; }
    const payload = { track_id: t.id, name, contact, party_size: Number(new FormData(form).get("party_size")), dates: [], referrer: from.slice(0, 40), message: "", agree: true, website: form.elements.namedItem("website").value };
    btn.disabled = true;
    btn.textContent = "보내는 중";
    form.setAttribute("aria-busy", "true");
    try {
      const response = await fetch("/api/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error || "보내지 못했어요. 잠시 후 다시 시도해 주세요.");
      form.hidden = true;
      if (body.duplicate) $("#done-msg").textContent = "이 연락처로 이미 신청이 있어요. 곧 연락드릴게요.";
      $("#apply-done").hidden = false;
      $("#apply-done h3").focus();
    } catch (error) {
      err.textContent = error instanceof TypeError ? "연결이 끊겼어요. 입력한 내용은 그대로 있으니 다시 보내 주세요." : error.message;
    } finally {
      btn.disabled = false;
      form.removeAttribute("aria-busy");
      resetButton();
    }
  });
})();
