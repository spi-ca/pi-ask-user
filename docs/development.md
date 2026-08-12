# 개발 안내

## 도구와 타입 경로

이 패키지는 `package.json`의 `packageManager`에 선언된 `bun@1.3.14`를 사용합니다. Pi 타입은 devDependency `@earendil-works/pi-coding-agent`와 `@earendil-works/pi-tui`의 `node_modules` 설치본에서 해석됩니다. 개발 의존성 범위는 `^0.84.1`이지만 optional peer dependency는 `*`이므로 소비자의 Pi 최소 버전을 메타데이터로 강제하지 않습니다.

```bash
bun install
bun run check
bun run test
bun run ci
bun pm pack --dry-run
```

`ci`는 타입 검사와 테스트를 순서대로 실행하며, 변경을 검증된 것으로 취급하기 전에 반드시 통과해야 합니다. `pack --dry-run`은 배포하지 않고 패키지 포함 파일을 확인합니다.

## 프로젝트 구조

```text
index.ts              — 안정적인 Pi 확장 진입점, package.json의 pi.extensions가 참조
src/types.ts          — 질문·옵션·답변·결과의 공유 값 타입
src/questions.ts      — typebox 파라미터 스키마와 신뢰할 수 없는 입력 정규화
src/state.ts          — 탭·커서·다중 선택·답변·오류·단발 확정 상태 머신
src/render.ts          — 폭 계산, 매달린 들여쓰기, 옵션·요약 문자열의 순수 포매팅
src/component.ts      — 상태 머신을 Pi TUI에 연결하는 키 처리·편집기·테마 렌더링
src/presence.ts       — 선택적 process-local presence producer
src/tool.ts           — ask_user 도구 등록, 결과 형성, 취소 처리
test/questions.test.ts  — 정규화, 기본값, 오류 메시지, 스키마 제약 테스트
test/state.test.ts      — 탭 이동, 커서 클램프, 다중 선택 확정, 자유 입력, 단발 확정 테스트
test/render.test.ts     — 폭 경계, 들여쓰기, 옵션 조립, 요약·도움말 문자열 테스트
test/component.test.ts  — 실제 pi-tui 편집기와 fake TUI/theme으로 키 입력부터 렌더 출력까지 검증
test/presence.test.ts   — 게이트 조건, payload 형식, 순서 필드, 실패 격리, 개인정보 canary 테스트
test/tool.test.ts       — 오류 결과, 결과 텍스트, 호출 라벨 포매팅 테스트
test/entrypoint.test.ts — 등록 표면, 비대화형 경로, 완료·취소·abort 경로, 렌더러 테스트
test/helpers/           — 테스트 전용 fake theme과 fake TUI(`fake-theme.ts`)
docs/                   — 주제별 문서
```

루트 `index.ts`는 그대로 둡니다. `package.json`의 `pi.extensions`가 이 파일을 확장 진입점으로 참조하기 때문입니다. `src/`는 하위 디렉터리 없이 평면 구조이며 각 모듈이 타입·검증·상태·포매팅·렌더링·presence·도구 등록 중 하나의 책임만 갖습니다.

의존 방향은 `types → questions/render/state → component → tool → index`이고 `presence`는 `tool`만 사용합니다. 순수 모듈(`questions`, `render`, `state`)은 TUI를 import하지 않으므로 터미널 없이 검증할 수 있습니다.

## 변경 불변 조건

- 신뢰할 수 없는 도구 인수는 UI를 열기 전에 `normalizeQuestions`에서 검증합니다. 오류는 예외가 아니라 문자열로 반환하고 취소된 결과로 보고합니다.
- 답변 의미는 `src/state.ts`에만 둡니다. `src/component.ts`는 키를 상태 전이로 옮기고 스냅샷을 그리는 역할만 합니다.
- 확정은 단발입니다. `submit`이 여러 번 호출되어도 결과 콜백은 한 번만 실행되어야 합니다.
- 취소는 순서에 의존하지 않아야 합니다. abort가 컴포넌트 mount 전에 도착해도 취소로 수렴해야 하고, 컴포넌트는 그대로 반환해 host가 정리할 수 있어야 합니다.
- `id`는 공백 제거 후 비교·저장합니다. 다른 사용자 제공 문자열은 자동으로 `trim`하지 않습니다. 예외는 저장 시점의 자유 입력 답변입니다.
- 렌더 결과는 요청한 폭을 넘지 않아야 합니다. 새 표시 문자열을 추가하면 `wrapLines`/`wrapLinesWithPrefix`를 통과시킵니다.
- 렌더 캐시는 폭과 상태 revision을 함께 키로 씁니다. 새 상태를 추가하면 변경 시 `revision`이 증가하도록 합니다.
- presence는 관찰용입니다. 이벤트 발행 실패, 소비자 부재, 잘못된 세션 ID가 질문 실패로 이어져서는 안 됩니다.
- presence payload에 질문·옵션·답변 내용을 넣지 않습니다. 새 필드를 추가하면 [`configuration.md`](configuration.md)의 개인정보 범위와 canary 테스트를 함께 갱신합니다.
- 도구는 `sequential` 실행 모드를 유지합니다. 동시 질문이 TUI를 경합하지 않게 하기 위한 것입니다.

## 검증 범위

`bun run ci`는 입력 정규화와 오류 메시지, typebox 스키마 제약, 탭·커서·다중 선택·자유 입력 상태 전이, 단발 확정, 폭 경계와 들여쓰기, 옵션·요약·도움말 문자열, 실제 `pi-tui` 편집기를 사용한 키 입력·렌더 출력, presence 게이트·payload·순서 필드·실패 격리·개인정보 canary, 도구 등록 표면과 비대화형·완료·취소·abort 경로, 호출·결과 렌더러를 실행합니다.

이 검증은 fake TUI와 fake theme까지만 다룹니다. 실제 터미널 렌더링, 실제 테마 색상, 실행 중인 `pi-cmux-presence`와의 연동, cmux 서버 동작은 검증하지 않습니다. 변경 후 실제 환경에서 확인할 항목은 좁은 터미널에서의 줄바꿈, 편집기 커서 표시, presence 소비자가 있을 때의 알림 동작입니다.

## 관련 문서

- [`usage.md`](usage.md) — 도구 호출 형식, 검증 규칙, 반환 형식
- [`configuration.md`](configuration.md) — presence 이벤트 계약과 개인정보 범위

## 문서 작성 방식

- `README.md`는 짧고 신호가 높은 진입 문서로 유지합니다.
- 자세한 동작은 주제별 문서에 둡니다.
- 전체 구현 목록보다 안정적인 개념을 우선합니다.
- 중복된 명령 목록은 최소화하고 `package.json`과 맞춥니다.
- 사람이 읽는 문서(`README.md`, `docs/*.md`)는 한국어로, 에이전트가 읽는 문서(`AGENTS.md`)는 영어로 씁니다.
