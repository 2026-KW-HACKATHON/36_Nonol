import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { QUESTIONS, path } from "../src/survey.js";

function screen() {
  const elements = new Map();
  const context = vm.createContext({
    URLSearchParams, location: { search: "" }, fixture: {}, selected: [],
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, { value: "", addEventListener() {} });
        return elements.get(id);
      },
      querySelectorAll() { return context.selected.map((value) => ({ value })); },
    },
  });
  vm.runInContext(readFileSync(new URL("../public/app.js", import.meta.url), "utf8"), context);
  context.definitions = QUESTIONS;
  vm.runInContext("questions = definitions", context);
  return context;
}

function seed(context, fixture, index, selected) {
  Object.assign(context, { fixture, questionIndex: index, selected });
  vm.runInContext("for (const key of Object.keys(answers)) delete answers[key]; Object.assign(answers, fixture); index = questionIndex", context);
}
const readAnswers = (context) => JSON.parse(vm.runInContext("JSON.stringify(answers)", context));

test("화면과 서버의 서비스 선택 및 이용 상태 분기가 같다", () => {
  const context = screen();
  for (const used of ["yes", "no"]) {
    for (const services of [undefined, [], ["delivery"], ["delivery", "stamp"]]) {
      for (const state of [undefined, "more", "same", "less", "stopped"]) {
        const a = { used, services, state };
        seed(context, a, 0, []);
        const actual = JSON.parse(vm.runInContext("JSON.stringify(path())", context));
        assert.deepEqual(actual, path(a));
      }
    }
  }
});

test("이전 화면에서 기준 서비스를 바꾸면 기존 서비스 경험을 초기화한다", () => {
  const context = screen();
  seed(context, { used: "yes", services: ["delivery", "stamp"], service: "delivery", state: "stopped", last_used: "week", age: "20" }, 1, ["stamp"]);
  vm.runInContext("keep()", context);
  assert.deepEqual(readAnswers(context), { used: "yes", services: ["stamp"], service: "stamp", service_other: "", age: "20" });
  assert.equal(JSON.parse(vm.runInContext("JSON.stringify(path())", context))[2], "last_used");
});

test("기준 서비스를 유지한 채 선택을 추가하면 기존 답변을 유지한다", () => {
  const context = screen();
  seed(context, { used: "yes", services: ["delivery"], service: "delivery", last_used: "week" }, 1, ["delivery", "stamp"]);
  vm.runInContext("keep()", context);
  assert.equal(readAnswers(context).last_used, "week");
  assert.equal(JSON.parse(vm.runInContext("JSON.stringify(path())", context))[2], "service");
  seed(context, readAnswers(context), 2, ["stamp"]);
  vm.runInContext("keep()", context);
  assert.equal(readAnswers(context).service, "stamp");
  assert.equal(readAnswers(context).last_used, undefined);
});
