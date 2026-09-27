-- 설문 응답. 익명이다. 이름과 연락처를 담지 않는다.
CREATE TABLE responses (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '' CHECK(length(source) <= 20),
  used TEXT NOT NULL CHECK(used IN ('yes','no')),
  service TEXT NOT NULL DEFAULT '' CHECK(length(service) <= 20),
  service_other TEXT NOT NULL DEFAULT '' CHECK(length(service_other) <= 60),
  last_used TEXT NOT NULL DEFAULT '' CHECK(length(last_used) <= 20),
  state TEXT NOT NULL DEFAULT '' CHECK(length(state) <= 20),
  reasons TEXT NOT NULL DEFAULT '' CHECK(length(reasons) <= 200),
  reason_other TEXT NOT NULL DEFAULT '' CHECK(length(reason_other) <= 100),
  benefit TEXT NOT NULL DEFAULT '' CHECK(length(benefit) <= 20),
  experiences TEXT NOT NULL DEFAULT '' CHECK(length(experiences) <= 200),
  revisit TEXT NOT NULL DEFAULT '' CHECK(length(revisit) <= 20),
  age TEXT NOT NULL CHECK(length(age) <= 10)
);
CREATE INDEX responses_created ON responses(created_at);

-- 추첨 참여. 응답과 이어 붙일 수 있는 값을 두지 않는다. 추첨이 끝나면 전부 지운다.
CREATE TABLE raffle (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE CHECK(length(phone) BETWEEN 10 AND 11)
);
