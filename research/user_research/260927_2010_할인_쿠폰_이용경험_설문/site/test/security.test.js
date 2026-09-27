import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const origin = "https://survey.example";
function environment() {
  const statements = [];
  return {
    statements,
    DB: { prepare(sql) {
      const statement = { sql, values: [] };
      statements.push(statement);
      return { bind(...values) { statement.values = values; return { async run() { return { success: true }; } }; } };
    } },
    ASSETS: { async fetch() { return new Response("not found", { status: 404 }); } },
  };
}
const request = (path, method = "GET", body, requestOrigin = origin) => new Request(origin + path, {
  method,
  headers: { "Content-Type": "application/json", ...(requestOrigin ? { Origin: requestOrigin } : {}) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("비로그인 공개 API는 질문만 반환하고 DB를 읽지 않는다", async () => {
  const env = environment();
  const res = await worker.fetch(request("/api/survey"), env);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(await res.json()), ["questions"]);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  for (const path of ["/api/respond", "/api/raffle"]) {
    for (const method of ["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]) {
      assert.equal((await worker.fetch(request(path, method), env)).status, 405);
    }
  }
  for (const path of ["/api/results", "/api/responses", "/api/admin", "/api/export", "/api/raffle/1"]) {
    assert.equal((await worker.fetch(request(path), env)).status, 404);
  }
  assert.equal(env.statements.length, 0);
});

test("외부 출처와 입력 오류는 DB에 도달하지 않고 입력 내용을 반사하지 않는다", async () => {
  const env = environment();
  for (const path of ["/api/respond", "/api/raffle"]) {
    for (const from of [undefined, "https://other.example"]) {
      const res = await worker.fetch(request(path, "POST", {}, from === undefined ? "" : from), env);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
    }
    const res = await worker.fetch(request(path, "POST", { invalid: "PRIVATE_TEST_MARKER" }), env);
    assert.equal(res.status, 400);
    assert.ok(!(await res.text()).includes("PRIVATE_TEST_MARKER"));
  }
  assert.equal(env.statements.length, 0);
});

test("저장 API는 성공 여부만 반환하며 번호 중복으로 조회할 수 없다", async () => {
  const env = environment();
  const res = await worker.fetch(request("/api/respond", "POST", { answers: { used: "no", age: "20" } }), env);
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true });
  const body = { phone: "01000000000", agree: true };
  const first = await worker.fetch(request("/api/raffle", "POST", body), env);
  const repeated = await worker.fetch(request("/api/raffle", "POST", body), env);
  assert.equal(first.status, 201);
  assert.equal(repeated.status, 201);
  assert.deepEqual(await first.json(), { ok: true });
  assert.deepEqual(await repeated.json(), { ok: true });
  assert.ok(env.statements.every(({ sql }) => sql.startsWith("INSERT INTO ") && !/SELECT|RETURNING/i.test(sql)));
  assert.ok(env.statements[1].sql.includes("ON CONFLICT(phone) DO NOTHING"));
  assert.ok(!env.statements[0].values.includes(body.phone));
});

test("DB 실패 시 응답 및 로그에 입력이나 DB 세부 오류를 노출하지 않는다", async () => {
  const env = environment();
  env.DB.prepare = () => { throw new Error("PRIVATE_DATABASE_MARKER"); };
  const messages = [];
  const original = console.error;
  console.error = (message) => messages.push(message);
  try {
    const res = await worker.fetch(request("/api/raffle", "POST", { phone: "01000000000", agree: true }), env);
    assert.equal(res.status, 500);
    const output = await res.text() + messages.join("");
    assert.ok(!output.includes("01000000000"));
    assert.ok(!output.includes("PRIVATE_DATABASE_MARKER"));
  } finally { console.error = original; }
});
