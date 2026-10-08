-- 알파 테스터 신청. 이름과 연락처는 개인정보이므로 테스트가 끝나면 지운다.
CREATE TABLE applications (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  track_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
  contact TEXT NOT NULL CHECK(length(contact) BETWEEN 3 AND 80),
  party_size INTEGER NOT NULL CHECK(party_size BETWEEN 1 AND 4),
  dates TEXT NOT NULL DEFAULT '' CHECK(length(dates) <= 200),
  referrer TEXT NOT NULL DEFAULT '' CHECK(length(referrer) <= 40),
  message TEXT NOT NULL DEFAULT '' CHECK(length(message) <= 500),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','paid','done','cancelled'))
);
CREATE INDEX applications_created ON applications(created_at);
