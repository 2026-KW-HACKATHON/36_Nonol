import { test } from "node:test";
import assert from "node:assert/strict";
import { clean, cleanPhone, path, summarize } from "../src/survey.js";

const full = { used: "yes", services: ["delivery"], service: "delivery", last_used: "quarter", state: "stopped", reasons: ["discount", "forgot"], benefit: "less", experiences: ["shrink", "discover"], revisit: "no", age: "20" };

test("써 본 적 없으면 나이대만 묻는다", () => {
  assert.deepEqual(path({ used: "no" }), ["used", "age"]);
  const v = clean({ answers: { used: "no", age: "20", service: "delivery" }, source: "insta" });
  assert.equal(v.used, "no");
  assert.equal(v.service, "");
  assert.equal(v.source, "insta");
});

test("덜 쓴다와 안 쓴다만 이유를 묻는다", () => {
  assert.ok(!path({ used: "yes", state: "same" }).includes("reasons"));
  assert.ok(path({ used: "yes", state: "less" }).includes("reasons"));
  assert.ok(path({ used: "yes", state: "stopped" }).includes("reasons"));
  const v = clean({ answers: { ...full, state: "more", reasons: ["discount"] } });
  assert.equal(v.reasons, "");
});

test("전체 응답을 저장 형태로 바꾼다", () => {
  const v = clean({ answers: full, source: "EVIL<script>" });
  assert.equal(v.reasons, "discount,forgot");
  assert.equal(v.experiences, "shrink,discover");
  assert.equal(v.source, "");
});

test("빠진 답과 없는 보기를 거른다", () => {
  assert.equal(typeof clean({ answers: { ...full, benefit: undefined } }), "string");
  assert.equal(typeof clean({ answers: { ...full, age: "99" } }), "string");
  assert.equal(typeof clean({ answers: { ...full, reasons: [] } }), "string");
  assert.equal(typeof clean({ answers: { ...full, experiences: ["none", "saved"] } }), "string");
  assert.equal(typeof clean({ answers: full, website: "x" }), "string");
  assert.equal(typeof clean(null), "string");
});

test("기타를 골랐을 때만 직접 입력을 남긴다", () => {
  assert.equal(clean({ answers: { ...full, services: ["other"], service_other: " 당근 " } }).service_other, "당근");
  assert.equal(clean({ answers: { ...full, service_other: "당근" } }).service_other, "");
  assert.equal(typeof clean({ answers: { ...full, services: ["other"], service_other: "가".repeat(61) } }), "string");
});

test("서비스 하나면 기준 질문을 건너뛰고 서버가 기준 서비스를 정한다", () => {
  assert.ok(!path(full).includes("service"));
  assert.ok(path(full).includes("services"));
  const v = clean({ answers: { ...full, service: undefined } });
  assert.equal(v.services, "delivery");
  assert.equal(v.service, "delivery");
  assert.equal(clean({ answers: { ...full, service: "stamp" } }).service, "delivery");
});

test("서비스 여러 개면 선택한 항목 중 기준 서비스가 필요하다", () => {
  const a = { ...full, services: ["stamp", "delivery", "stamp"] };
  assert.ok(path(a).includes("service"));
  assert.equal(path(a).length, 10);
  assert.equal(clean({ answers: a }).services, "delivery,stamp");
  assert.equal(clean({ answers: a }).service, "delivery");
  assert.equal(typeof clean({ answers: { ...a, service: undefined } }), "string");
  assert.equal(typeof clean({ answers: { ...a, service: "local" } }), "string");
  assert.equal(clean({ answers: { ...a, services: ["delivery", "other"], service_other: "테스트" } }).service_other, "테스트");
});

test("잘못된 복수 선택을 거르고 미이용자의 불필요한 값을 버린다", () => {
  for (const services of [[], null, "delivery", ["unknown"], ["delivery", {}]]) {
    assert.equal(typeof clean({ answers: { ...full, services } }), "string");
  }
  const v = clean({ answers: { ...full, used: "no" } });
  assert.equal(v.services, "");
  assert.equal(v.service, "");
});

test("개편 전 화면의 제출은 보존하되 복수 선택 응답으로 추정하지 않는다", () => {
  const { services, ...legacy } = full;
  const v = clean({ answers: legacy });
  assert.equal(v.service, "delivery");
  assert.equal(v.services, "");
  const s = summarize([v, clean({ answers: full }), clean({ answers: { ...full, services: ["delivery", "stamp"] } })]);
  assert.equal(s.users, 3);
  assert.equal(s.servicesRespondents, 2);
  assert.equal(s.service.find((r) => r.value === "delivery").count, 3);
  assert.equal(s.services.find((r) => r.value === "stamp").percent, 50);
});

test("추첨 번호를 검사한다", () => {
  assert.deepEqual(cleanPhone({ phone: "010-1234-5678", agree: true }), { phone: "01012345678" });
  assert.equal(typeof cleanPhone({ phone: "010-1234-5678" }), "string");
  assert.equal(typeof cleanPhone({ phone: "02-123-4567", agree: true }), "string");
});

test("핵심 숫자를 계산한다", () => {
  const row = (o) => clean({ answers: { ...full, ...o } });
  const rows = [row({ state: "stopped" }), row({ state: "less", reasons: ["hassle"] }), row({ state: "same", last_used: "older" }), row({ state: "more", last_used: "week" }), clean({ answers: { used: "no", age: "30" } })];
  const s = summarize(rows);
  assert.equal(s.total, 5);
  assert.equal(s.users, 4);
  assert.equal(s.usedPercent, 80);
  assert.equal(s.key.kept.percent, 50);
  assert.equal(s.key.less.percent, 25);
  assert.equal(s.key.stopped.percent, 25);
  assert.equal(s.key.recentUse.count, 1);
  assert.equal(s.key.mismatch.count, 1);
  assert.equal(s.reasonsStopped.find((r) => r.value === "discount").percent, 100);
  assert.equal(s.reasonsLess.find((r) => r.value === "hassle").count, 1);
  assert.equal(summarize([]).key.kept.percent, 0);
});
