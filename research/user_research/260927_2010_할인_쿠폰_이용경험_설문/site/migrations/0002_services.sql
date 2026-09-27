-- 기존 단일 선택 응답은 보존하고, 새 복수 선택 응답을 별도로 저장한다.
-- 이전 응답의 빈 값은 미수집을 뜻하므로 서비스 이용 경험 통계에서 제외한다.
ALTER TABLE responses ADD COLUMN services TEXT NOT NULL DEFAULT '' CHECK(length(services) <= 100);
