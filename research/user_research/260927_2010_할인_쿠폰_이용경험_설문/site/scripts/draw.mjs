// 추첨. 참여한 번호 가운데 2명을 뽑아 터미널에만 보여 준다. 파일로 남기지 않는다.
// Cloudflare 계정으로 로그인한 컴퓨터에서만 돌아간다.
//   node scripts/draw.mjs           2명 뽑기
//   node scripts/draw.mjs --purge   발송을 마친 뒤 번호 전부 지우기
import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";

const local = process.argv.includes("--local");
function query(sql) {
  const out = execFileSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "d1", "execute", "DB", local ? "--local" : "--remote", "--command", sql, "--json"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, WRANGLER_SEND_METRICS: "false" } });
  return JSON.parse(out)[0].results;
}
if (process.argv.includes("--purge")) {
  query("DELETE FROM raffle");
  console.log(`번호를 모두 지웠다. 남은 수: ${query("SELECT COUNT(*) AS n FROM raffle")[0].n}`);
} else {
  const pool = query("SELECT phone FROM raffle").map((r) => r.phone), winners = [];
  const entries = pool.length;
  while (pool.length && winners.length < 2) winners.push(pool.splice(randomInt(pool.length), 1)[0]);
  console.log(`참여 ${entries}명`);
  console.log(winners.length ? `당첨: ${winners.join(", ")}` : "참여자가 없다.");
  console.log("쿠폰을 보낸 뒤 node scripts/draw.mjs --purge 로 번호를 지운다.");
}
