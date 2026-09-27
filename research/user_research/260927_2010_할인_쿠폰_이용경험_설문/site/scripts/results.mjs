// 설문 결과를 집계해 터미널에 보여 주고 .local/ 에 md 로 남긴다.
// Cloudflare 계정으로 로그인한 컴퓨터에서만 돌아간다 (wrangler 가 원격 D1 을 읽는다).
//   node scripts/results.mjs          원격 DB
//   node scripts/results.mjs --local  로컬 DB
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { summarize } from "../src/survey.js";

const local = process.argv.includes("--local");
function query(sql) {
  const out = execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", local ? "--local" : "--remote", "--command", sql, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  return JSON.parse(out)[0].results;
}
// 번호는 읽지 않는다. 추첨 참여자 수만 센다.
const rows = query("SELECT source, used, services, service, service_other, last_used, state, reasons, reason_other, benefit, experiences, revisit, age, created_at FROM responses ORDER BY created_at");
const entries = query("SELECT COUNT(*) AS n FROM raffle")[0].n;
const s = summarize(rows);
const day = (r) => (r ? r.created_at.slice(0, 10) : "");
const names = { insta: "인스타그램", everytime: "에브리타임", kakao: "카카오톡", friend: "지인", direct: "표시 없음" };
const table = (title, note, items) => [`## ${title}`, "", note, "", "| 보기 | 인원 | 비율 |", "| --- | --- | --- |", ...items.map((i) => `| ${i.label} | ${i.count} | ${i.percent}% |`), ""];
const k = s.key, base = `써 본 사람 ${s.users}명 기준`;
const lines = [
  "# 할인 및 쿠폰 서비스 이용 경험 설문: 집계",
  "",
  `집계 시각: ${new Date().toISOString()} (${local ? "로컬" : "원격"} DB)`,
  `조사 기간: ${rows.length ? day(rows[0]) + " ~ " + day(rows[rows.length - 1]) : "응답 없음"}`,
  `전체 응답 ${s.total}명, 써 본 사람 ${s.users}명 (${s.usedPercent}%), 추첨 참여 ${entries}명`,
  "",
  "## 핵심 숫자",
  "",
  base,
  "",
  "| 항목 | 인원 | 비율 |", "| --- | --- | --- |",
  `| 계속 쓴다 (더 자주, 비슷하게) | ${k.kept.count} | ${k.kept.percent}% |`,
  `| 덜 쓴다 | ${k.less.count} | ${k.less.percent}% |`,
  `| 이제 안 쓴다 | ${k.stopped.count} | ${k.stopped.percent}% |`,
  `| 최근 한 달 안에 사용 | ${k.recentUse.count} | ${k.recentUse.percent}% |`,
  "",
  `계속 쓴다고 답했지만 마지막 사용이 석 달을 넘은 사람: ${k.mismatch.count}명`,
  "",
  ...table("지금 이용 상태", base, s.state),
  ...table("덜 쓰게 된 이유", `덜 쓴다고 답한 ${k.less.count}명 기준, 복수 선택`, s.reasonsLess),
  ...table("안 쓰게 된 이유", `이제 안 쓴다고 답한 ${k.stopped.count}명 기준, 복수 선택`, s.reasonsStopped),
  ...table("가장 많이 쓴 것", base, s.service),
  ...table("이용해본 서비스", `복수 선택 문항에 답한 ${s.servicesRespondents}명 기준. 개편 전 응답은 제외.`, s.services),
  ...table("마지막 사용 시점", base, s.lastUsed),
  ...table("실제로 받은 혜택", base, s.benefit),
  ...table("쓰면서 겪은 일", base + ", 복수 선택", s.experiences),
  ...table("할인 없을 때 재방문", base, s.revisit),
  ...table("나이대", `전체 응답 ${s.total}명 기준`, s.age),
  ...table("유입 경로", `전체 응답 ${s.total}명 기준`, Object.entries(s.sources).map(([v, c]) => ({ label: names[v] || v, count: c, percent: s.total ? Math.round((c / s.total) * 1000) / 10 : 0 }))),
  "## 직접 입력", "",
  "서비스: " + (s.otherText.service.join(" / ") || "없음"), "",
  "이유: " + (s.otherText.reason.join(" / ") || "없음"), "",
];
const text = lines.join("\n");
await mkdir(".local", { recursive: true, mode: 0o700 });
const d = new Date(Date.now() + 9 * 3600000).toISOString();
const file = `.local/${d.slice(2, 4)}${d.slice(5, 7)}${d.slice(8, 10)}_${d.slice(11, 13)}${d.slice(14, 16)}_집계.md`;
await writeFile(file, text, { mode: 0o600 });
console.log(text);
console.log(`저장: ${file} (저장소에 올라가지 않는 폴더). 직접 입력 칸에 개인정보가 없는지 본 뒤에만 결과 문서로 옮긴다.`);
